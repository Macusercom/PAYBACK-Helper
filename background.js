// ============================================================
// PAYBACK Helper – Background Service Worker
// ============================================================

// Load shared domain map (defines PAYBACK_DOMAIN_LOOKUP + normalizeName)
importScripts('domain-map.js');

// ---- Refresh logic ----

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
// Tab IDs opened for background refresh – close them once data arrives.
// Persisted to session storage so they survive service worker restarts.
let refreshTabIds = new Set();
// Prevent multiple simultaneous refreshes (cooldown: 60 seconds)
// Persisted via chrome.storage.session so it survives restarts.
let _lastRefreshTime = 0;

// Restore in-memory state from session storage on worker wake-up
async function restoreWorkerState() {
  try {
    const data = await chrome.storage.session.get(['refreshTabIds', 'lastRefreshTime']);
    if (Array.isArray(data.refreshTabIds)) refreshTabIds = new Set(data.refreshTabIds);
    if (data.lastRefreshTime) _lastRefreshTime = data.lastRefreshTime;
  } catch {}
}
function persistRefreshTabs() {
  chrome.storage.session.set({ refreshTabIds: [...refreshTabIds] }).catch(() => {});
}
function persistRefreshTime() {
  chrome.storage.session.set({ lastRefreshTime: _lastRefreshTime }).catch(() => {});
}
restoreWorkerState();

// First install: load shops + coupons silently in background
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    refreshInBackground();
  }
});

const ALARM_COUPONS = 'refresh-coupons';
const ALARM_CLEANUP_PREFIX = 'cleanup-tab-';

function refreshInBackground() {
  const now = Date.now();
  if (now - _lastRefreshTime < 60000) {
    console.log('[PAYBACK] Refresh übersprungen – letzter Refresh vor', Math.round((now - _lastRefreshTime) / 1000), 's');
    return;
  }
  _lastRefreshTime = now;
  persistRefreshTime();
  console.log('[PAYBACK] Background-Refresh gestartet');

  // Shops (no login required) – open immediately
  openRefreshTab('https://www.payback.at/online-punkten/alle-shops');

  // Coupons – staggered via alarm (setTimeout is unreliable in MV3 service workers)
  chrome.alarms.create(ALARM_COUPONS, { delayInMinutes: 0.033 }); // ~2 seconds
}

function openRefreshTab(url) {
  chrome.tabs.create({ url, active: false }, tab => {
    if (tab?.id) {
      refreshTabIds.add(tab.id);
      persistRefreshTabs();
      // Fallback close via alarm (setTimeout unreliable in MV3)
      chrome.alarms.create(`${ALARM_CLEANUP_PREFIX}${tab.id}`, { delayInMinutes: 0.5 }); // 30s
    }
  });
}

// Handle alarms
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_COUPONS) {
    openRefreshTab('https://www.payback.at/coupons');
  } else if (alarm.name.startsWith(ALARM_CLEANUP_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(ALARM_CLEANUP_PREFIX.length), 10);
    if (tabId) closeRefreshTab(tabId);
  }
});

function closeRefreshTab(tabId) {
  if (!refreshTabIds.has(tabId)) return;
  refreshTabIds.delete(tabId);
  persistRefreshTabs();
  chrome.alarms.clear(`${ALARM_CLEANUP_PREFIX}${tabId}`);
  chrome.tabs.remove(tabId).catch(() => {});
}

// Close a tab if it was opened in the background (not active/focused).
// Works for tabs opened by refreshInBackground() AND by the popup's refresh button.
function autoCloseTab(tab) {
  if (!tab?.id) return;
  // If tracked by refreshInBackground, use that path
  if (refreshTabIds.has(tab.id)) {
    closeRefreshTab(tab.id);
    return;
  }
  // Otherwise, close if the tab is not active (i.e. opened in background for refresh)
  if (!tab.active) {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---- Smart auto-refresh on partner site visit ----
// Instead of a blind 24h alarm, refresh when the user visits a partner
// website and data is older than 24h. This also catches new shops.

async function refreshIfStale() {
  const { shopsLastFetch, couponsLastFetch } =
    await chrome.storage.local.get(['shopsLastFetch', 'couponsLastFetch']);
  const now = Date.now();
  const shopsStale   = !shopsLastFetch   || (now - shopsLastFetch)   > STALE_MS;
  const couponsStale = !couponsLastFetch || (now - couponsLastFetch) > STALE_MS;
  if (shopsStale || couponsStale) {
    refreshInBackground();
  }
}

// ---- Badge updates on tab navigation ----

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  await updateBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await updateBadge(tabId, tab.url);
  } catch {}
});

async function updateBadge(tabId, url) {
  const match = await findMatch(url);
  if (!match) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  // Partner site detected → trigger auto-refresh if data is stale
  refreshIfStale();

  const hasUnactivatedCoupon = match.coupons.some(c => !c.activated);
  const hasCoupon = match.coupons.length > 0;

  if (hasUnactivatedCoupon) {
    chrome.action.setBadgeText({ text: '°P', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#E87722', tabId }); // Orange = activate!
  } else if (hasCoupon) {
    chrome.action.setBadgeText({ text: '°P', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#2E7D32', tabId }); // Green = already active
  } else {
    chrome.action.setBadgeText({ text: '°P', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#0046AA', tabId }); // Blue = shop only
  }
}

// ---- Match URL against stored shops ----

async function findMatch(url) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;

  const { shops = [], coupons = [] } = await chrome.storage.local.get(['shops', 'coupons']);
  const shop = matchShop(parsedUrl.hostname, shops);
  if (!shop) return null;

  const matchingCoupons = coupons.filter(c => c.partnerShortName === shop.partnerShortName);
  return { shop, coupons: matchingCoupons };
}

function matchShop(hostname, shops) {
  const cleanHost = hostname.replace(/^www\./, '');

  // 1. Direct domain lookup via PAYBACK_DOMAIN_LOOKUP (most accurate)
  const normalizedFromMap = PAYBACK_DOMAIN_LOOKUP[cleanHost];
  if (normalizedFromMap) {
    const shop = shops.find(s => normalizeName(s.name) === normalizedFromMap);
    if (shop) return shop;
  }

  // 2. Check subdomain variants (e.g. at.ecco.com)
  for (const [domain, normedName] of Object.entries(PAYBACK_DOMAIN_LOOKUP)) {
    if (cleanHost === domain || cleanHost.endsWith('.' + domain)) {
      const shop = shops.find(s => normalizeName(s.name) === normedName);
      if (shop) return shop;
    }
  }

  // 3. Fallback: slug-based matching (catches shops not in domain map)
  const hostParts = cleanHost.split('.');
  for (const shop of shops) {
    const slug = shop.slug.toLowerCase();
    if (hostParts.some(part => part === slug)) return shop;
    if (cleanHost.startsWith(slug + '.') || cleanHost === slug) return shop;
    // Normalized name match (e.g. "ABOUT YOU" → "aboutyou" matches "aboutyou.de")
    const normedName = normalizeName(shop.name);
    if (normedName.length > 3 && hostParts.some(p => normalizeName(p) === normedName)) return shop;
    const normedSlug = normalizeName(slug);
    if (normedSlug.length > 3 && hostParts.some(p => normalizeName(p) === normedSlug)) return shop;
  }
  return null;
}

// ---- Messages from content scripts + popup ----

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'SHOPS_DATA') {
    chrome.storage.local.set({ shops: msg.data, shopsLastFetch: Date.now() });
    console.log(`[PAYBACK] ${msg.data.length} Shops gespeichert`);
    if (sender.tab?.id) autoCloseTab(sender.tab);

  } else if (msg.type === 'OPEN_SHOP_URL') {
    if (msg.url) {
      chrome.tabs.create({ url: msg.url }, () => {
        if (sender.tab?.id) {
          // Use alarm instead of setTimeout (setTimeout unreliable in MV3 service workers)
          const tabId = sender.tab.id;
          chrome.alarms.create(`${ALARM_CLEANUP_PREFIX}${tabId}`, { delayInMinutes: 0.025 }); // ~1.5s
          refreshTabIds.add(tabId);
          persistRefreshTabs();
        }
      });
    }

  } else if (msg.type === 'COUPONS_DATA') {
    // Not logged in: keep cached coupons (still useful for display) but
    // always mark as logged out so popup/overlay show a login warning.
    if (!msg.loggedIn) {
      chrome.storage.local.set({ couponsLoggedIn: false });
      if (sender.tab?.id) autoCloseTab(sender.tab);
      return;
    }

    // Merge: keep coupons for partners not present in the new data.
    // This prevents a filtered page (e.g. only Gurkerl visible) from
    // wiping out all other partners' coupons.
    chrome.storage.local.get(['coupons'], ({ coupons: existing = [] }) => {
      const newPartners = new Set(msg.data.map(c => c.partnerShortName));
      const now = Date.now();
      const merged = [
        ...existing.filter(c => !newPartners.has(c.partnerShortName)),
        ...msg.data,
      ].filter(c => {
        // Remove expired coupons (validTo is in the past)
        if (!c.validTo) return true;
        try { return new Date(c.validTo).getTime() > now; } catch { return true; }
      });
      chrome.storage.local.set({
        coupons: merged,
        couponsLastFetch: Date.now(),
        couponsLoggedIn: true,
      });
      console.log(`[PAYBACK] ${msg.data.length} Coupons aktualisiert, ${merged.length} gesamt (abgelaufen entfernt)`);
      // Refresh badge after storage is written
      chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
        if (tabs[0]?.url) await updateBadge(tabs[0].id, tabs[0].url);
      });
    });
    if (sender.tab?.id) autoCloseTab(sender.tab);

  } else if (msg.type === 'COUPON_ACTIVATED') {
    // Intercepted activation XHR – mark the coupon as activated in storage.
    chrome.storage.local.get(['coupons'], ({ coupons = [] }) => {
      let changed = false;
      const updated = coupons.map(c => {
        if (String(c.couponID) === String(msg.couponId) && !c.activated) {
          changed = true;
          return { ...c, activated: true, activatable: false };
        }
        return c;
      });
      if (changed) {
        chrome.storage.local.set({ coupons: updated });
        console.log(`[PAYBACK] Coupon ${msg.couponId} als aktiviert markiert`);
        chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
          if (tabs[0]?.url) await updateBadge(tabs[0].id, tabs[0].url);
        });
      }
    });

  }
  return false;
});

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
// Tab IDs opened speziell für Hintergrund-Aktivierung – NICHT schließen bis
// PENDING_ACTIVATIONS_DONE empfangen, damit async fetch() Requests abgeschlossen werden.
let activationTabIds = new Set();
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
const ALARM_ACTIVATION_PREFIX = 'activation-tab-';

function refreshInBackground() {
  const now = Date.now();
  if (now - _lastRefreshTime < 60000) {
    console.log('[PAYBACK] Refresh übersprungen – letzter Refresh vor', Math.round((now - _lastRefreshTime) / 1000), 's');
    return;
  }
  _lastRefreshTime = now;
  persistRefreshTime();
  console.log('[PAYBACK] Background-Refresh gestartet');

  // Shops (no login required) – open both pages:
  // alle-shops = vollständige Liste mit partnerShortName im data-tracking
  // online-punkten = Übersichtsseite enthält auch /partner/-Shops wie Otto
  openRefreshTab('https://www.payback.at/online-punkten/alle-shops');
  openRefreshTab('https://www.payback.at/online-punkten');

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
  } else if (alarm.name.startsWith(ALARM_ACTIVATION_PREFIX)) {
    // Fallback: Aktivierungs-Tab nach 2 Minuten zwangsweise schließen
    const tabId = parseInt(alarm.name.slice(ALARM_ACTIVATION_PREFIX.length), 10);
    if (tabId) {
      activationTabIds.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
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
  // Aktivierungs-Tabs NICHT früh schließen – warten auf PENDING_ACTIVATIONS_DONE
  if (activationTabIds.has(tab.id)) return;
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
    // Beim Speichern der alle-shops Daten: bestehende Partner-Shops (isPartnerPage: true)
    // erhalten, die nicht in der neuen Liste enthalten sind (z.B. Otto von /partner/).
    chrome.storage.local.get(['shops'], ({ shops: existing = [] }) => {
      const newPartners = new Set(msg.data.map(s => s.partnerShortName));
      const preserved = existing.filter(s => s.isPartnerPage && !newPartners.has(s.partnerShortName));
      const merged = [...msg.data, ...preserved];
      chrome.storage.local.set({ shops: merged, shopsLastFetch: Date.now() });
      console.log(`[PAYBACK] ${msg.data.length} Shops gespeichert` + (preserved.length ? `, ${preserved.length} Partner-Shop(s) erhalten` : ''));
    });
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
    // Aktivierungs-Tabs ignorieren: die extrahierten Daten sind stale (DOM zeigt
    // aktivierte Coupons noch als inaktiv). COUPON_ACTIVATED Nachrichten übernehmen
    // die Aktualisierung. So wird auch kein unnötiger Popup-Reload ausgelöst.
    if (activationTabIds.has(sender.tab?.id)) return;

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

  } else if (msg.type === 'PARTNER_SHOPS_DATA') {
    // Partner-Shops von /online-punkten Übersichtsseite (z.B. Otto)
    // Werden nur hinzugefügt wenn noch kein Eintrag mit gleichem partnerShortName existiert.
    chrome.storage.local.get(['shops'], ({ shops = [] }) => {
      const existingPartners = new Set(shops.map(s => s.partnerShortName));
      const newShops = msg.data.filter(s => !existingPartners.has(s.partnerShortName));
      if (newShops.length > 0) {
        chrome.storage.local.set({ shops: [...shops, ...newShops], shopsLastFetch: Date.now() });
        console.log(`[PAYBACK] ${newShops.length} Partner-Shop(s) ergänzt (${newShops.map(s => s.name).join(', ')})`);
        // Badge nach Storage-Update aktualisieren
        chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
          if (tabs[0]?.url) await updateBadge(tabs[0].id, tabs[0].url);
        });
      }
    });
    if (sender.tab?.id) autoCloseTab(sender.tab);

  } else if (msg.type === 'ACTIVATE_ALL_COUPONS') {
    // Alle angegebenen Coupons im Hintergrund aktivieren.
    // WICHTIG: Tab wird NICHT in refreshTabIds eingetragen und autoCloseTab() überspringt ihn.
    // Er bleibt offen bis PENDING_ACTIVATIONS_DONE empfangen wird (oder 2min Fallback-Alarm).
    const coupons = msg.coupons || [];
    if (coupons.length === 0) return;
    chrome.storage.local.set({ pendingActivations: coupons }, () => {
      chrome.tabs.create({ url: 'https://www.payback.at/coupons', active: false }, tab => {
        if (tab?.id) {
          activationTabIds.add(tab.id);
          // 2-Minuten Fallback falls PENDING_ACTIVATIONS_DONE nie ankommt
          chrome.alarms.create(`${ALARM_ACTIVATION_PREFIX}${tab.id}`, { delayInMinutes: 2 });
        }
      });
      console.log(`[PAYBACK] ${coupons.length} Coupon(s) zur Hintergrund-Aktivierung vorgemerkt`);
    });

  } else if (msg.type === 'PENDING_ACTIVATIONS_DONE') {
    // Content-Script hat alle Aktivierungen abgeschlossen – Tab jetzt schließen
    if (sender.tab?.id) {
      const tabId = sender.tab.id;
      activationTabIds.delete(tabId);
      chrome.alarms.clear(`${ALARM_ACTIVATION_PREFIX}${tabId}`);
      chrome.tabs.remove(tabId).catch(() => {});
      console.log(`[PAYBACK] Aktivierungs-Tab ${tabId} geschlossen`);
    }

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

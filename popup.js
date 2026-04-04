// ============================================================
// PAYBACK Helper – Popup Logik
// domain-map.js geladen davor: PAYBACK_DOMAIN_LOOKUP + normalizeName verfügbar
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  const {
    shops = [], coupons = [],
    shopsLastFetch, couponsLastFetch, couponsLoggedIn,
    pointsBalance, pointsLastFetch,
  } = await chrome.storage.local.get([
    'shops', 'coupons', 'shopsLastFetch', 'couponsLastFetch', 'couponsLoggedIn',
    'pointsBalance', 'pointsLastFetch',
  ]);

  // Show points balance in header if available
  if (typeof pointsBalance === 'number') {
    const pointsEl = document.getElementById('points-display');
    if (pointsEl) {
      const euros = (pointsBalance / 100).toFixed(2).replace('.', ',');
      pointsEl.textContent = `${pointsBalance.toLocaleString('de-AT')} °P ≈ ${euros} €`;
      pointsEl.style.display = 'block';
    }
  }

  if (!shopsLastFetch || shops.length === 0) {
    show('view-no-data');
    setupRefreshButton();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let parsedUrl;
  try { parsedUrl = new URL(tab?.url); } catch {}

  const shop = parsedUrl ? matchShop(parsedUrl.hostname, shops) : null;

  if (!shop) {
    show('view-no-match');
    document.getElementById('footer-no-match').innerHTML =
      buildFooter(shopsLastFetch, couponsLastFetch, couponsLoggedIn);
    setupRefreshButton();
    setupOverlayToggle();
    return;
  }

  show('view-match');
  document.getElementById('shop-name').textContent   = shop.name;
  document.getElementById('shop-points').textContent = shop.points;
  document.getElementById('shop-link').href          = shop.paybackUrl + '#pb-autoclick';

  const matchingCoupons = coupons.filter(c => c.partnerShortName === shop.partnerShortName);
  renderCoupons(matchingCoupons, shop, couponsLoggedIn);
  document.getElementById('footer-match').innerHTML =
    buildFooter(shopsLastFetch, couponsLastFetch, couponsLoggedIn);
  setupRefreshButton();
  setupOverlayToggle();
});

// ---- Domain matching (same logic as background.js) ----

function matchShop(hostname, shops) {
  const cleanHost = hostname.replace(/^www\./, '');

  const normedFromMap = PAYBACK_DOMAIN_LOOKUP[cleanHost];
  if (normedFromMap) {
    const shop = shops.find(s => normalizeName(s.name) === normedFromMap);
    if (shop) return shop;
  }

  for (const [domain, normedName] of Object.entries(PAYBACK_DOMAIN_LOOKUP)) {
    if (cleanHost === domain || cleanHost.endsWith('.' + domain)) {
      const shop = shops.find(s => normalizeName(s.name) === normedName);
      if (shop) return shop;
    }
  }

  const hostParts = cleanHost.split('.');
  for (const shop of shops) {
    const slug = shop.slug.toLowerCase();
    if (hostParts.some(part => part === slug)) return shop;
    if (cleanHost.startsWith(slug + '.') || cleanHost === slug) return shop;
    const normedName = normalizeName(shop.name);
    if (normedName.length > 3 && hostParts.some(p => normalizeName(p) === normedName)) return shop;
  }
  return null;
}

// ---- Render coupons ----

function renderCoupons(coupons, shop, couponsLoggedIn) {
  const section = document.getElementById('coupons-section');

  if (couponsLoggedIn === false) {
    section.innerHTML = `
      <div class="login-warning">
        ⚠ eCoupons nicht geladen –
        <a href="https://www.payback.at/coupons" target="_blank">Bitte einloggen</a>
      </div>`;
    return;
  }

  if (coupons.length === 0) {
    section.innerHTML = `<div class="no-coupons-note">Kein eCoupon für diesen Shop verfügbar</div>`;
    return;
  }

  const unactivated = coupons.filter(c => !c.activated);
  const activated   = coupons.filter(c =>  c.activated);
  let html = '';

  if (unactivated.length > 0) {
    html += `<div class="coupons-header">⚠ Nicht aktivierte eCoupons</div>`;
    unactivated.forEach(c => { html += buildCouponCard(c, 'unactivated'); });
  }
  if (activated.length > 0) {
    html += `<div class="coupons-header">✓ Aktivierte eCoupons</div>`;
    activated.forEach(c => { html += buildCouponCard(c, 'activated'); });
  }

  section.innerHTML = html;
}

function buildCouponCard(coupon, type) {
  const validTo = formatDate(coupon.validTo);
  // URL to payback.at/coupons with partner pre-filtered and scrolled to "nicht aktiviert"
  const filterUrl = `https://www.payback.at/coupons#pbf~${encodeURIComponent(coupon.partnerShortName)}`;

  const isExpired = coupon.validTo ? new Date(coupon.validTo).getTime() < Date.now() : false;

  let statusHtml = '';
  if (type === 'unactivated') {
    if (!isExpired) {
      statusHtml = `<a href="${filterUrl}" target="_blank" class="btn-activate">Jetzt aktivieren →</a>`;
    } else {
      type = 'expired';
      statusHtml = `<div class="coupon-expired-note">⏰ Aktivierungszeitraum abgelaufen</div>`;
    }
  } else {
    statusHtml = `<div class="coupon-activated-badge">✓ Bereits aktiviert</div>`;
  }

  return `
    <div class="coupon-card ${type}">
      <div class="coupon-headline">${esc(coupon.headline)}</div>
      ${coupon.subline ? `<div class="coupon-subline">${esc(coupon.subline)}</div>` : ''}
      ${validTo        ? `<div class="coupon-validity">Gültig bis ${validTo}</div>` : ''}
      ${statusHtml}
    </div>`;
}

// ---- Footer with timestamps + refresh button ----

function buildFooter(shopsLastFetch, couponsLastFetch, couponsLoggedIn) {
  const shopsAge   = shopsLastFetch   ? formatAge(shopsLastFetch)   : 'nie';
  const couponsAge = couponsLastFetch ? formatAge(couponsLastFetch) : 'nie';
  const staleClass = (isStale(shopsLastFetch) || isStale(couponsLastFetch)) ? 'stale' : '';

  const couponStatus = couponsLoggedIn === false
    ? `<span class="warn">nicht eingeloggt</span>`
    : couponsAge;

  const loginHint = couponsLoggedIn === false
    ? `<div class="login-warning">⚠ Bitte auf <a href="https://www.payback.at/coupons" target="_blank">payback.at</a> einloggen, damit eCoupons geladen werden können.</div>`
    : '';

  return `
    ${loginHint}
    <label class="overlay-toggle">
      <input type="checkbox" class="chk-overlay">
      <span>°P Overlay auf Websites anzeigen</span>
    </label>
    <div class="footer-timestamps ${staleClass}">
      Shops: ${shopsAge} · Coupons: ${couponStatus}
    </div>
    <div class="footer-actions">
      <button class="btn-refresh" title="Shops + eCoupons im Hintergrund aktualisieren">↺ Aktualisieren</button>
    </div>`;
}

function setupRefreshButton() {
  // There can be multiple refresh buttons (no-data view + footer), attach to all
  document.querySelectorAll('.btn-refresh').forEach(btn => {
    btn.addEventListener('click', () => {
      // Disable all refresh buttons
      document.querySelectorAll('.btn-refresh').forEach(b => {
        b.textContent = '↺ Wird aktualisiert…';
        b.disabled = true;
      });

      // Open pages directly from popup – no message passing to background needed.
      // Content scripts extract data → send to background → storage updates → popup reloads.
      chrome.tabs.create({ url: 'https://www.payback.at/online-punkten/alle-shops', active: false });
      chrome.tabs.create({ url: 'https://www.payback.at/coupons', active: false });
    });
  });
}

function setupOverlayToggle() {
  const chk = document.querySelector('.chk-overlay');
  if (!chk) return;
  // Read current setting (default: enabled)
  chrome.storage.local.get(['overlayEnabled'], ({ overlayEnabled }) => {
    chk.checked = overlayEnabled !== false; // default true
  });
  chk.addEventListener('change', () => {
    chrome.storage.local.set({ overlayEnabled: chk.checked });
  });
}

// Listen for storage changes to update the popup live after refresh
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.shopsLastFetch || changes.couponsLastFetch || changes.couponsLoggedIn) {
    // Reload the entire popup to show fresh data
    window.location.reload();
  }
});

// ---- Helpers ----

function show(id) {
  ['view-loading','view-no-data','view-no-match','view-match'].forEach(v => {
    document.getElementById(v)?.classList.toggle('hidden', v !== id);
  });
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' }); }
  catch { return ''; }
}

function formatAge(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1)  return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  return `vor ${Math.round(h/24)} Tag(en)`;
}

function isStale(ts) {
  return !ts || (Date.now() - ts) > 25 * 3600 * 1000;
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

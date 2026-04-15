// ============================================================
// PAYBACK Helper – Shop-Overlay auf Partner-Websites
// Läuft auf allen Seiten außer payback.at
// domain-map.js wird vorher geladen (definiert PAYBACK_DOMAIN_LOOKUP + normalizeName)
// ============================================================

(function () {
  if (window !== window.top) return; // Keine iFrames

  const hostname   = window.location.hostname;
  const dismissKey = `pb_dismissed_${hostname}`;

  let _currentWidget     = null;
  let _currentShop       = null;
  let _latestCoupons     = []; // always kept up-to-date by storage listener
  let _couponsLoggedIn   = null;
  let _couponsLastFetch  = null;

  setTimeout(checkAndShow, 1200);

  async function checkAndShow() {
    const { shops = [], coupons = [], shopsLastFetch, couponsLastFetch, couponsLoggedIn, overlayEnabled, [dismissKey]: wasDismissed } =
      await chrome.storage.local.get(['shops', 'coupons', 'shopsLastFetch', 'couponsLastFetch', 'couponsLoggedIn', 'overlayEnabled', dismissKey]);

    // Overlay disabled via popup toggle (default: enabled)
    if (overlayEnabled === false) return;

    if (!shopsLastFetch || shops.length === 0) return;

    const shop = matchShop(hostname, shops);
    if (!shop) return;

    _currentShop   = shop;
    _latestCoupons = coupons.filter(c => c.partnerShortName === shop.partnerShortName);
    _couponsLoggedIn = couponsLoggedIn;
    _couponsLastFetch = couponsLastFetch;

    if (wasDismissed) {
      // Was dismissed earlier in this browser session – show toggle instead of full overlay
      showToggle(shop);
    } else {
      showOverlay(shop, _latestCoupons);
    }
  }

  // React to storage changes: coupon updates, overlay toggle
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Overlay toggled off → remove everything immediately
    if (changes.overlayEnabled && changes.overlayEnabled.newValue === false) {
      if (_currentWidget) { _currentWidget.remove(); _currentWidget = null; }
      if (_toggleBtn) { _toggleBtn.remove(); _toggleBtn = null; }
      return;
    }
    // Overlay toggled on → show overlay (re-run checkAndShow if needed)
    if (changes.overlayEnabled && changes.overlayEnabled.newValue === true) {
      chrome.storage.local.remove(dismissKey);
      if (_currentShop) {
        showOverlay(_currentShop, _latestCoupons);
      } else {
        checkAndShow(); // first time — need to load shop data
      }
      return;
    }

    // Track login state changes
    if (changes.couponsLoggedIn !== undefined) {
      _couponsLoggedIn = changes.couponsLoggedIn.newValue;
    }
    if (changes.couponsLastFetch !== undefined) {
      _couponsLastFetch = changes.couponsLastFetch.newValue;
    }

    if (!_currentShop) return;

    // Update coupons if changed
    if (changes.coupons) {
      _latestCoupons = (changes.coupons.newValue || [])
        .filter(c => c.partnerShortName === _currentShop.partnerShortName);
    }

    // Rebuild overlay if visible (login state or coupons changed)
    if (changes.coupons || changes.couponsLoggedIn) {
      if (_currentWidget && document.body.contains(_currentWidget)) {
        _currentWidget.remove();
        _currentWidget = null;
        showOverlay(_currentShop, _latestCoupons);
      } else if (_toggleBtn && document.body.contains(_toggleBtn)) {
        // Only toggle button visible – update color and store fresh coupons for re-show
        const unactivated = _latestCoupons.filter(c => !c.activated);
        const activated   = _latestCoupons.filter(c => c.activated);
        _toggleBtn.style.background = unactivated.length > 0 ? '#E87722'
                                    : activated.length > 0   ? '#2E7D32'
                                    : '#0046AA';
      }
    }
  });

  // ----------------------------------------------------------
  // Domain-Matching (nutzt PAYBACK_DOMAIN_LOOKUP aus domain-map.js)
  // ----------------------------------------------------------
  function matchShop(hostname, shops) {
    const cleanHost = hostname.replace(/^www\./, '');

    // 1. Direct lookup via domain map
    const normedFromMap = PAYBACK_DOMAIN_LOOKUP[cleanHost];
    if (normedFromMap) {
      const shop = shops.find(s => normalizeName(s.name) === normedFromMap);
      if (shop) return shop;
    }

    // 2. Subdomain variants (e.g. at.ecco.com)
    for (const [domain, normedName] of Object.entries(PAYBACK_DOMAIN_LOOKUP)) {
      if (cleanHost === domain || cleanHost.endsWith('.' + domain)) {
        const shop = shops.find(s => normalizeName(s.name) === normedName);
        if (shop) return shop;
      }
    }

    // 3. Slug/name fallback
    const hostParts = cleanHost.split('.');
    for (const shop of shops) {
      const slug = shop.slug.toLowerCase();
      if (hostParts.some(part => part === slug)) return shop;
      if (cleanHost.startsWith(slug + '.') || cleanHost === slug) return shop;
      const normedName = normalizeName(shop.name);
      if (normedName.length > 3 && hostParts.some(p => normalizeName(p) === normedName)) return shop;
      const normedSlug = normalizeName(slug);
      if (normedSlug.length > 3 && hostParts.some(p => normalizeName(p) === normedSlug)) return shop;
    }
    return null;
  }

  // ----------------------------------------------------------
  // Kleiner Toggle-Button, der nach Schließen des Widgets bleibt
  // ----------------------------------------------------------
  let _toggleBtn = null;

  function showToggle(shop) {
    if (_toggleBtn) return;
    const unactivated = _latestCoupons.filter(c => !c.activated);
    const activated   = _latestCoupons.filter(c => c.activated);
    const btnColor = unactivated.length > 0 ? '#E87722'
                   : activated.length > 0   ? '#2E7D32'
                   : '#0046AA';
    const btn = document.createElement('button');
    _toggleBtn = btn;
    btn.title = 'PAYBACK Helper anzeigen';
    btn.textContent = '°P';
    btn.style.cssText = `
      position:fixed;bottom:20px;right:20px;z-index:2147483647;
      background:${btnColor};color:white;border:none;border-radius:50%;
      width:40px;height:40px;font-size:13px;font-weight:bold;
      cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);
      display:flex;align-items:center;justify-content:center;
    `;
    btn.addEventListener('click', () => {
      btn.remove();
      _toggleBtn = null;
      chrome.storage.local.remove(dismissKey);
      showOverlay(shop, _latestCoupons); // always uses current data
    });
    document.body.appendChild(btn);
  }

  // ----------------------------------------------------------
  // Overlay-Widget
  // ----------------------------------------------------------
  function showOverlay(shop, coupons) {
    const unactivated = coupons.filter(c => !c.activated);
    const activated   = coupons.filter(c => c.activated);
    const hasCoupons  = coupons.length > 0;

    const accentColor = unactivated.length > 0 ? '#E87722'
                      : activated.length > 0   ? '#2E7D32'
                      : '#0046AA';

    const widget = document.createElement('div');
    widget.id = 'pb-assistant-widget';
    widget.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
      width: 300px; max-height: calc(100vh - 40px); background: #fff; border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25); overflow-y: auto; overflow-x: hidden;
      border: 2px solid ${accentColor};
      font-family: Arial, Helvetica, sans-serif; font-size: 14px;
      animation: pb-slide-in 0.3s ease;
    `;

    function formatDate(iso) {
      if (!iso) return '';
      try { return new Date(iso).toLocaleDateString('de-AT', { day:'2-digit', month:'2-digit', year:'numeric' }); }
      catch { return ''; }
    }

    // Build coupon cards HTML
    let couponHtml = '';
    if (hasCoupons) {
      couponHtml += `<div style="padding:0 14px 14px;">`;

      if (unactivated.length > 0) {
        couponHtml += `<div style="font-size:11px;font-weight:bold;color:#E87722;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Nicht aktivierte eCoupons</div>`;
        // "Alle aktivieren" Button – schickt Aktivierungsauftrag an Background
        const activatableList = unactivated.filter(c => !c.validTo || new Date(c.validTo).getTime() > Date.now());
        if (activatableList.length > 0) {
          couponHtml += `
            <button id="pb-activate-all-btn" style="
              display:block;width:100%;margin-bottom:10px;padding:8px 12px;
              background:#E87722;color:white;border:none;border-radius:6px;
              font-size:13px;font-weight:bold;cursor:pointer;text-align:center;
            ">⚡ Alle ${activatableList.length > 1 ? activatableList.length + ' eCoupons' : 'eCoupons'} automatisch aktivieren</button>`;
        }
        unactivated.forEach(c => {
          const validTo    = formatDate(c.validTo);
          const filterUrl  = `https://www.payback.at/coupons#pbf~${encodeURIComponent(c.partnerShortName)}`;
          const isExpired  = c.validTo ? new Date(c.validTo).getTime() < Date.now() : false;
          couponHtml += `
            <div style="background:#FFF3E0;border:1px solid #E87722;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
              <div style="font-weight:bold;color:#E87722;font-size:15px;">${esc(c.headline)}</div>
              ${c.subline ? `<div style="color:#444;font-size:12px;margin-top:2px;">${esc(c.subline)}</div>` : ''}
              ${validTo   ? `<div style="color:#888;font-size:11px;margin-top:4px;">Gültig bis ${validTo}</div>` : ''}
              ${!isExpired
                ? `<a href="${filterUrl}" target="_blank" style="display:inline-block;margin-top:8px;background:#E87722;color:white;padding:5px 12px;border-radius:5px;text-decoration:none;font-size:12px;font-weight:bold;">Auf payback.at ansehen →</a>`
                : `<div style="color:#888;font-size:11px;margin-top:6px;">⏰ Aktivierungszeitraum abgelaufen</div>`
              }
            </div>`;
        });
      }

      if (activated.length > 0) {
        couponHtml += `<div style="font-size:11px;font-weight:bold;color:#2E7D32;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;${unactivated.length > 0 ? 'margin-top:4px;' : ''}">Aktivierte eCoupons</div>`;
        activated.forEach(c => {
          const validTo = formatDate(c.validTo);
          couponHtml += `
            <div style="background:#E8F5E9;border:1px solid #2E7D32;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
              <div style="font-weight:bold;color:#2E7D32;font-size:15px;">${esc(c.headline)} ✓</div>
              ${c.subline ? `<div style="color:#444;font-size:12px;margin-top:2px;">${esc(c.subline)}</div>` : ''}
              ${validTo   ? `<div style="color:#888;font-size:11px;margin-top:4px;">Gültig bis ${validTo}</div>` : ''}
              <div style="color:#2E7D32;font-size:11px;margin-top:4px;font-weight:bold;">✓ Bereits aktiviert</div>
            </div>`;
        });
      }

      couponHtml += `</div>`;
    }

    const couponBadge = unactivated.length > 0
      ? `<div style="padding:0 14px 6px;color:#E87722;font-size:12px;font-weight:bold;">⚠ ${unactivated.length} eCoupon${unactivated.length > 1 ? 's' : ''} nicht aktiviert!</div>`
      : activated.length > 0
        ? `<div style="padding:0 14px 6px;color:#2E7D32;font-size:12px;font-weight:bold;">✓ ${activated.length} eCoupon${activated.length > 1 ? 's' : ''} aktiviert</div>`
        : '';

    widget.innerHTML = `
      <style>
        @keyframes pb-slide-in { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
        #pb-assistant-widget *{box-sizing:border-box;}
      </style>
      <div style="background:${accentColor};color:white;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="font-weight:bold;font-size:15px;">°P PAYBACK</span>
          <span style="margin-left:6px;font-size:13px;opacity:0.9;">${esc(shop.name)}</span>
        </div>
        <button id="pb-close-btn" style="background:none;border:none;cursor:pointer;color:white;font-size:20px;padding:0 4px;line-height:1;" title="Schließen">×</button>
      </div>

      <div style="padding:10px 14px ${hasCoupons ? '12px' : '18px'};display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div style="flex:1 1 auto;min-width:0;">
          <div style="color:#555;font-size:12px;">Punkte sammeln</div>
          <div style="font-weight:bold;color:#0046AA;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(shop.points)}</div>
        </div>
        <a href="${escAttr(shop.paybackUrl + '#pb-autoclick')}" target="_blank"
           style="flex:0 0 auto;background:#0046AA;color:white;padding:7px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold;white-space:nowrap;">
          Über PAYBACK kaufen →
        </a>
      </div>

      ${couponBadge}
      ${couponHtml}
      ${buildWarnings()}
    `;

    document.body.appendChild(widget);
    _currentWidget = widget;

    document.getElementById('pb-close-btn').addEventListener('click', () => {
      widget.style.transition = 'opacity 0.2s';
      widget.style.opacity = '0';
      setTimeout(() => { widget.remove(); _currentWidget = null; showToggle(shop); }, 200);
      chrome.storage.local.set({ [dismissKey]: true });
    });

    const activateAllBtn = document.getElementById('pb-activate-all-btn');
    if (activateAllBtn) {
      activateAllBtn.addEventListener('click', () => {
        const toActivate = _latestCoupons
          .filter(c => !c.activated && (!c.validTo || new Date(c.validTo).getTime() > Date.now()))
          .map(c => ({ couponId: c.couponID, partnerShortName: c.partnerShortName }));
        if (toActivate.length === 0) return;
        chrome.runtime.sendMessage({ type: 'ACTIVATE_ALL_COUPONS', coupons: toActivate });
        activateAllBtn.textContent = '⚡ Wird aktiviert…';
        activateAllBtn.disabled = true;
        activateAllBtn.style.opacity = '0.7';
      });
    }
  }

  function buildWarnings() {
    const warnings = [];
    if (_couponsLoggedIn === false) {
      warnings.push('⚠ Nicht eingeloggt – <a href="https://www.payback.at/coupons" target="_blank" style="color:#E87722;font-weight:bold;">einloggen</a> für eCoupons');
    } else if (_couponsLastFetch && (Date.now() - _couponsLastFetch) > 25 * 3600 * 1000) {
      warnings.push('eCoupon-Daten älter als 24h – werden automatisch aktualisiert');
    }
    if (warnings.length === 0) return '';
    return `<div style="padding:4px 14px 10px;font-size:11px;color:#E87722;text-align:center;">${warnings.join('<br>')}</div>`;
  }

  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escAttr(str) {
    if (!str) return '#';
    return str.replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
})();

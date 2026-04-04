// ============================================================
// PAYBACK Helper – Daten-Extraktion auf payback.at Seiten
// Läuft auf:
//   • /online-punkten/alle-shops  → Shop-Liste
//   • /coupons                    → eCoupons + Partner-Filter via URL-Hash
// ============================================================

(function () {
  const path = window.location.pathname;
  // Capture hash immediately – page JS might clear it later
  const _hash = window.location.hash;
  // Must be declared here (not near showBanner) to avoid TDZ ReferenceError
  let _activeBanner = null;

  console.log('[PAYBACK] content-payback.js läuft | Pfad:', path, '| Hash:', _hash || '(leer)');

  // Extract points balance from nav bar (present on all payback.at pages when logged in)
  extractPointsBalance();

  if (path === '/online-punkten/alle-shops') {
    extractShops();
  } else if (path === '/coupons') {
    extractCoupons();
    handlePartnerFilterFromHash();
  } else if (path.startsWith('/online-punkten/') && path.length > '/online-punkten/'.length) {
    // Individual shop page (z.B. /online-punkten/austrian-airlines)
    handleShopAutoClick();
  }

  // ----------------------------------------------------------
  // Punktestand aus der Navigation extrahieren
  // Element: <span class="pb-navigation__member-text">9 191 °P</span>
  // ----------------------------------------------------------
  function extractPointsBalance() {
    const el = document.querySelector('.pb-navigation__member-text');
    if (!el) return;
    const text = el.textContent.trim(); // e.g. "9 191 °P"
    // Extract numeric part: remove "°P", non-breaking spaces, regular spaces → parse as int
    const numStr = text.replace(/°P/g, '').replace(/\s/g, '').trim();
    const points = parseInt(numStr, 10);
    if (!isNaN(points) && points >= 0) {
      chrome.storage.local.set({
        pointsBalance: points,
        pointsLastFetch: Date.now(),
      });
      console.log('[PAYBACK] Punktestand:', points, '°P');
    }
  }

  // ----------------------------------------------------------
  // Shop-Extraktion
  // ----------------------------------------------------------
  function extractShops() {
    const shops = [];
    const seen = new Set();

    document.querySelectorAll('a[href^="/online-punkten/"][data-tracking]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const slug = href.replace('/online-punkten/', '').trim();
      if (!slug || slug === 'alle-shops' || seen.has(slug)) return;
      seen.add(slug);

      let tracking = {};
      try { tracking = JSON.parse(a.dataset.tracking); } catch {}
      if (!tracking.partnerShortName) return;

      const title = a.title || '';
      const dashIdx = title.lastIndexOf(' - ');
      const name   = dashIdx > -1 ? title.slice(0, dashIdx).trim() : title.trim();
      const points = dashIdx > -1 ? title.slice(dashIdx + 3).trim() : '';

      shops.push({
        slug,
        name,
        points,
        partnerShortName: tracking.partnerShortName,
        paybackUrl: `https://www.payback.at${href}`,
      });
    });

    chrome.runtime.sendMessage({ type: 'SHOPS_DATA', data: shops });
    showBanner(`${shops.length} Shops aktualisiert ✓`);
  }

  // ----------------------------------------------------------
  // eCoupon-Extraktion
  // ----------------------------------------------------------
  function extractCoupons(isInitialLoad = true) {
    // PAYBACK has three body class states:
    //   "logged-in js-logged-in"           → fully authenticated
    //   "weak-logged-in js-weak-logged-in" → session partially valid (coupons visible, points may not show)
    //   neither                            → not logged in
    // Also check for Logout link and pbc-coupon elements as fallback signals.
    const cl = document.body.classList;
    const isLoggedIn = cl.contains('logged-in') || cl.contains('js-logged-in')
                    || cl.contains('weak-logged-in') || cl.contains('js-weak-logged-in')
                    || !!document.querySelector('a[href*="action=Logout"]')
                    || document.querySelectorAll('pbc-coupon[coupon]').length > 0;

    if (!isLoggedIn) {
      chrome.runtime.sendMessage({ type: 'COUPONS_DATA', data: [], loggedIn: false });
      showBanner('Nicht eingeloggt – eCoupons nicht verfügbar', true);
      return;
    }

    const coupons = [];

    document.querySelectorAll('pbc-coupon[coupon]').forEach(el => {
      try {
        const data = JSON.parse(el.getAttribute('coupon'));
        const coupon = data.coupon;
        if (!coupon) return;

        const partner = coupon.partner?.[0] || {};
        if (!partner.partnerShortName) return;

        const texts    = coupon.couponContentSet?.textItem || [];
        const getText  = key => texts.find(t => t.textKey === key)?.textValue || '';

        // couponStatus 2 = activated (primary signal, directly in JSON)
        // DOM position as fallback
        const isActivated = coupon.couponStatus === 2
                         || !!el.closest('.pb-coupon-center__columns-activated');

        // data-activateable is unreliable (can be false for activatable coupons).
        // Use expiry date instead: if validTo is in the future, it's activatable.
        const validTo = coupon.validity?.validTo;
        const isExpired = validTo ? new Date(validTo).getTime() < Date.now() : false;
        const isActivatable = !isActivated && !isExpired;

        coupons.push({
          couponID:          coupon.couponID,
          partnerShortName:  partner.partnerShortName,
          partnerName:       partner.partnerDisplayName || '',
          headline:          getText(5),
          subline:           getText(6),
          shopUrl:           getText(13),
          validTo:           coupon.validity?.validTo || '',
          activated:         isActivated,
          activatable:       isActivatable,
        });
      } catch {}
    });

    chrome.runtime.sendMessage({ type: 'COUPONS_DATA', data: coupons, loggedIn: true });
    if (isInitialLoad) showBanner(`${coupons.length} eCoupons aktualisiert ✓`);

    // Intercept coupon activation XHR calls.
    // The page POSTs to ?:action=CapiProxy with activateCoupon but does NOT
    // update the coupon attribute JSON in the DOM (couponStatus stays 1).
    // We hook XMLHttpRequest.send to detect activation calls and immediately
    // mark the coupon as activated in chrome.storage.
    if (isInitialLoad) {
      interceptActivationRequests();
    }
  }

  // ----------------------------------------------------------
  // Partner-Filter via URL-Hash
  // Geöffnet via: payback.at/coupons#pbf~td_aua_at
  //
  // Format bewusst ohne "=" – payback.at's jQuery tut $(location.hash)
  // und crasht bei ungültigen CSS-Selektoren wie "#pb-partner=...".
  // Der Crash verhindert die Registrierung der Filter-Event-Handler.
  // Mit "#pbf~..." gibt es keinen Crash → .click() funktioniert.
  // ----------------------------------------------------------
  function handlePartnerFilterFromHash() {
    const hashMatch = _hash.match(/^#pbf~(.+)$/);
    if (!hashMatch) return;

    const partnerShortName = decodeURIComponent(hashMatch[1]);
    const itemSelector = `.pb-coupon-center__filter-item[data-value="${CSS.escape(partnerShortName)}"]`;

    const applyFilter = (attempt = 0) => {
      if (attempt > 20) return;

      const filterItem = document.querySelector(itemSelector);
      if (!filterItem) {
        setTimeout(() => applyFilter(attempt + 1), 500);
        return;
      }

      if (filterItem.classList.contains('pb-coupon-center__filter-item_selected')) {
        scrollToNotActivated();
        return;
      }

      // Open dropdown first if collapsed
      if (filterItem.offsetParent === null) {
        document.querySelector('.pb-coupon-center__filter-header')?.click();
        setTimeout(() => { filterItem.click(); setTimeout(() => verifyOrRetry(filterItem, attempt), 600); }, 350);
      } else {
        filterItem.click();
        setTimeout(() => verifyOrRetry(filterItem, attempt), 600);
      }
    };

    function verifyOrRetry(filterItem, attempt) {
      if (filterItem.classList.contains('pb-coupon-center__filter-item_selected')) {
        scrollToNotActivated();
      } else {
        applyFilter(attempt + 1);
      }
    }

    setTimeout(() => applyFilter(0), 800);
  }

  // ----------------------------------------------------------
  // Auto-Redirect via Affiliate-URL
  // Ausgelöst wenn URL-Hash #pb-autoclick gesetzt ist.
  // Navigiert den aktuellen Tab direkt zur Affiliate-URL –
  // kein Background-Script, kein Popup-Blocker-Problem.
  // ----------------------------------------------------------
  function handleShopAutoClick() {
    if (!_hash.includes('pb-autoclick')) {
      console.log('[PAYBACK] handleShopAutoClick: kein #pb-autoclick Hash (hash war:', _hash, ')');
      return;
    }

    history.replaceState(null, '', window.location.pathname);

    // Don't auto-redirect if not logged in – points wouldn't be earned
    const cl = document.body.classList;
    const isLoggedIn = cl.contains('logged-in') || cl.contains('js-logged-in')
                    || cl.contains('weak-logged-in') || cl.contains('js-weak-logged-in')
                    || !!document.querySelector('a[href*="action=Logout"]');
    if (!isLoggedIn) {
      console.log('[PAYBACK] Nicht eingeloggt – Auto-Redirect abgebrochen');
      showBanner('Bitte zuerst einloggen, um °Punkte zu sammeln!', true, true);
      return;
    }

    showBanner('Weiterleitung wird vorbereitet…', false, true);
    console.log('[PAYBACK] handleShopAutoClick: suche Affiliate-URL…');

    const doRedirect = (attempt = 0) => {
      // Primary: read URL directly from form action (already in server-rendered HTML)
      const form = document.querySelector('#shopNowForm');
      const affiliateUrl = form?.action;
      console.log('[PAYBACK] Versuch', attempt, '| form:', !!form, '| action:', affiliateUrl?.substring(0, 60));

      if (affiliateUrl && affiliateUrl.startsWith('http')) {
        console.log('[PAYBACK] Weiterleitung zu:', affiliateUrl.substring(0, 80));
        showBanner('Weiterleitung aktiv ✓');
        // Navigate current tab – no popup blocker, no background needed
        window.location.href = affiliateUrl;
        return;
      }

      // Fallback: parse jtsURL from .jts[data-tracking]
      const jtsSection = document.querySelector('.jts[data-tracking]');
      if (jtsSection) {
        let tracking = {};
        try { tracking = JSON.parse(jtsSection.dataset.tracking); } catch (e) {
          console.log('[PAYBACK] JSON parse Fehler:', e.message);
        }
        const jtsUrl = tracking.jtsURL || tracking.jtsUrl;
        if (jtsUrl) {
          console.log('[PAYBACK] Fallback jtsURL gefunden');
          showBanner('Weiterleitung aktiv ✓');
          window.location.href = jtsUrl;
          return;
        }
      }

      if (attempt < 20) {
        setTimeout(() => doRedirect(attempt + 1), 400);
      } else {
        console.log('[PAYBACK] Kein Affiliate-Link gefunden nach', attempt, 'Versuchen');
        showBanner('Affiliate-Link nicht gefunden – bitte manuell klicken', true);
      }
    };

    setTimeout(() => doRedirect(), 500);
  }

  // ----------------------------------------------------------
  // Listen for coupon activation events from MAIN world script
  // (intercept-activation.js patches XHR.send in the page context)
  // ----------------------------------------------------------
  function interceptActivationRequests() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'PAYBACK_COUPON_ACTIVATED') return;

      const { couponId, partnerShortName } = event.data;
      console.log('[PAYBACK] Coupon-Aktivierung erkannt:', couponId, partnerShortName);

      chrome.runtime.sendMessage({
        type: 'COUPON_ACTIVATED',
        couponId: String(couponId),
        partnerShortName: partnerShortName || null,
      });
    });
  }

  function scrollToNotActivated() {
    setTimeout(() => {
      // Scroll to "Nicht aktivierte eCoupons" section
      const el = document.querySelector('[data-locator="occNotActivated"]')
               || document.querySelector('.pb-coupon-center__columns-not-activated');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 400);
  }

  // ----------------------------------------------------------
  // Kleines Status-Banner
  // persistent = true → bleibt bis zum nächsten Aufruf
  // ----------------------------------------------------------
  function showBanner(text, isWarning = false, persistent = false) {
    if (_activeBanner) { try { _activeBanner.remove(); } catch {} }
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: ${isWarning ? '#E87722' : '#0046AA'};
      color: white; padding: 10px 16px; border-radius: 8px;
      font-family: Arial, sans-serif; font-size: 13px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: opacity 0.5s ease;
    `;
    banner.textContent = `PAYBACK Helper: ${text}`;
    document.body.appendChild(banner);
    _activeBanner = banner;
    if (!persistent) {
      setTimeout(() => { banner.style.opacity = '0'; }, 2500);
      setTimeout(() => { if (_activeBanner === banner) _activeBanner = null; banner.remove(); }, 3100);
    }
  }
})();

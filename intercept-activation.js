// ============================================================
// PAYBACK Assistent – XHR Interception (MAIN world)
//
// Runs in the page's JS context (world: MAIN) to monkey-patch
// XMLHttpRequest.send and detect coupon activation calls.
// Communicates back to the content script via window.postMessage.
//
// payback.at activates coupons via XHR POST to ?:action=CapiProxy
// with body: capiCallData[ExtintServiceName]=activateCoupon
// The DOM is NOT updated after activation (couponStatus stays 1),
// so this interception is the only way to detect it live.
// ============================================================

(function () {
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === 'string' && body.includes('activateCoupon')) {
        const params = new URLSearchParams(body);
        const svc = params.get('capiCallData[ExtintServiceName]');
        if (svc === 'activateCoupon') {
          const couponId = params.get('capiCallData[couponId]');
          const partner = params.get('capiCallData[partnerShortName]');
          this.addEventListener('load', function () {
            if (this.status >= 200 && this.status < 300) {
              window.postMessage({
                type: 'PAYBACK_COUPON_ACTIVATED',
                couponId: couponId,
                partnerShortName: partner,
              }, '*');
            }
          });
        }
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();

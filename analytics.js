/* Privacy-first analytics.
 *
 *  - Cloudflare Web Analytics (in index.html) loads ALWAYS: cookieless, aggregate
 *    only, no personal data — consent-exempt under GDPR/DPDP.
 *  - Google Analytics (GA4) sets cookies, so it is OFF until the visitor clicks
 *    "Allow". No gtag.js is even loaded before then — a hard opt-in. The choice is
 *    remembered in localStorage.
 *  - window.track(name, params) records a custom event, but ONLY when GA is on.
 *    Callers guard with `window.track && track(...)`, so nothing breaks if this
 *    file is blocked.
 */
(function () {
  const GA_ID = 'G-JW9Q3R8KML';
  const KEY = 'uraga_consent';           // 'granted' | 'denied'
  let gaReady = false;

  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }

  function enableGA(){
    if (gaReady) return;
    gaReady = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_ID);               // GA4 anonymises IPs by default
  }

  // custom events fire only with consent; queued via dataLayer until gtag.js lands
  window.track = function (name, params){ if (gaReady) gtag('event', name, params || {}); };

  const DISABLE = 'ga-disable-' + GA_ID;   // GA honours window[this]=true to stop all hits
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (stored === 'granted') enableGA();
  if (stored === 'denied') window[DISABLE] = true;

  // ---- consent banner + a persistent control to change the choice later ----
  function ctrlLabel(){
    const c = (() => { try { return localStorage.getItem(KEY); } catch (e) { return null; } })();
    return c === 'granted' ? 'Analytics: on' : c === 'denied' ? 'Analytics: off' : 'Analytics';
  }
  function choose(v){
    try { localStorage.setItem(KEY, v); } catch (e) {}
    if (v === 'granted'){ window[DISABLE] = false; enableGA(); }
    else window[DISABLE] = true;       // stops GA hits immediately if it was already loaded
    const b = document.getElementById('consent'); if (b) b.remove();
    const c = document.getElementById('consent-ctrl'); if (c) c.textContent = ctrlLabel();
  }
  function openConsent(){ if (!document.getElementById('consent')) banner(); }
  function banner(){
    const el = document.createElement('div');
    el.id = 'consent';
    el.className = 'consent';
    el.innerHTML =
      '<div class="consent-in">' +
        '<p class="consent-msg">We measure how this atlas is used. ' +
          '<b>Cloudflare Web Analytics</b> runs cookie-free either way; ' +
          '<b>Google Analytics</b> uses cookies, so it runs only if you allow it. ' +
          '<button class="consent-more" type="button">Details</button></p>' +
        '<p class="consent-det" hidden>Cloudflare collects only aggregate, cookieless ' +
          'page and visit counts. Google Analytics (GA4) sets cookies and shares aggregated ' +
          'usage with Google; it runs only after you click Allow, and you can withdraw by ' +
          'clearing this site’s data. No personal data is sold; no login or account is tracked.</p>' +
        '<div class="consent-btns">' +
          '<button class="consent-no" type="button">Decline</button>' +
          '<button class="consent-yes" type="button">Allow analytics</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('.consent-yes').onclick = () => choose('granted');
    el.querySelector('.consent-no').onclick = () => choose('denied');
    el.querySelector('.consent-more').onclick = e => {
      const d = el.querySelector('.consent-det'); d.hidden = !d.hidden;
      e.target.textContent = d.hidden ? 'Details' : 'Hide';
    };
  }
  if (!stored) banner();

  // always-available control to review/change the choice, no site-data clearing
  const ctrl = document.createElement('button');
  ctrl.id = 'consent-ctrl';
  ctrl.type = 'button';
  ctrl.textContent = ctrlLabel();
  ctrl.title = 'Change your analytics choice';
  ctrl.onclick = openConsent;
  document.body.appendChild(ctrl);
})();

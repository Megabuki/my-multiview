/**
 * My MultiView - 통나무 수집 방 집중 (모든 치지직 페이지 MAIN 월드)
 *
 * 치지직 통나무 5분/1시간 적립은 플레이어가 30초마다 보내는 POST /polling/v1/watch-event/live (WATCH_CONTINUED) 기준이다.
 * 계정당 동시에 한 방송만 적립되는 것으로 보여, 멀티뷰에서 통나무 수집을 켠 동안에는
 * 통나무 수집 방이 아닌 곳(멀티뷰의 다른 칸 + 따로 연 치지직 탭)의 주기적 WATCH_CONTINUED만 보내지 않는다.
 * (시작/일시정지/종료 이벤트는 그대로 보냄. 화면·소리는 영향 없음)
 *
 * 켜고 끄는 판단은 isolated 스크립트가 <html>에 적어 둔 값으로 한다:
 *  - data-cmv-lp-any="1"    : 멀티뷰가 열려 있고 어떤 방송에서 통나무 수집이 켜져 있음
 *  - data-cmv-lp-active="1" : 이 페이지가 바로 그 통나무 수집 방송
 * 치지직은 이 요청을 axios(XHR)로 보내므로 XHR과 fetch를 모두 처리한다.
 */
(() => {
  if (window.__cmvWatchGuard) return;
  window.__cmvWatchGuard = true;

  const WATCH_URL_RE = /\/watch-event\/live\b/i;
  const FAKE_WATCH_BODY = JSON.stringify({ code: 200, message: null, content: null });

  function shouldDropWatchEvent(url, method, body) {
    if (!WATCH_URL_RE.test(String(url || ''))) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    const de = document.documentElement;
    if (!de || de.dataset.cmvLpAny !== '1' || de.dataset.cmvLpActive === '1') return false;
    try {
      const d = typeof body === 'string' ? JSON.parse(body) : null;
      return !!(d && d.payload && d.payload.watchEventType === 'WATCH_CONTINUED');
    } catch {
      return false;
    }
  }

  // XHR (치지직 기본 방식)
  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;
    XP.open = function (method, url, ...rest) {
      this.__cmvReq = { method, url: String(url) };
      return origOpen.call(this, method, url, ...rest);
    };
    XP.send = function (body) {
      const r = this.__cmvReq;
      if (r && shouldDropWatchEvent(r.url, r.method, body)) {
        // 실제 전송 없이 성공 응답만 흉내 (치지직 쪽 오류 처리/재시도 방지)
        const xhr = this;
        const def = (k, v) => {
          try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch {}
        };
        def('readyState', 4);
        def('status', 200);
        def('statusText', 'OK');
        def('responseURL', r.url);
        def('responseText', FAKE_WATCH_BODY);
        def('response', xhr.responseType === 'json' ? JSON.parse(FAKE_WATCH_BODY) : FAKE_WATCH_BODY);
        xhr.getAllResponseHeaders = () => 'content-type: application/json\r\n';
        xhr.getResponseHeader = (h) => (/^content-type$/i.test(h) ? 'application/json' : null);
        setTimeout(() => {
          for (const type of ['readystatechange', 'load', 'loadend']) {
            try { xhr.dispatchEvent(new Event(type)); } catch {}
          }
        }, 0);
        return undefined;
      }
      return origSend.call(this, body);
    };
  } catch {}

  // fetch (혹시 fetch로 바뀌는 경우 대비)
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        try {
          const a0 = args[0];
          const url = typeof a0 === 'string' ? a0 : a0 instanceof URL ? a0.href : (a0 && a0.url) || '';
          const init = args[1] || {};
          if (shouldDropWatchEvent(url, init.method || (a0 && a0.method), init.body)) {
            return Promise.resolve(
              new Response(FAKE_WATCH_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } }),
            );
          }
        } catch {}
        return origFetch.apply(this, args);
      };
    }
  } catch {}
})();

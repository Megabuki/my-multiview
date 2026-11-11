/**
 * My MultiView - 칸 안 치지직 페이지 MAIN 월드 스크립트
 *
 *  - 지연 시간 다중 추출:
 *    1차: window.__getLiveInfo()
 *    2차: 플레이어 인스턴스 / React Fiber 내 latency 상태값
 *    (3·4차 seekable/buffered 폴백은 tile.js에서 수행)
 *  - 칸별 화질 격리 및 기본 화질(defaultQuality) 지원:
 *    치지직은 화질을 'live-player-video-track' 하나에 저장해 여러 칸이 서로 덮어쓰므로,
 *    채널별 전용 키(cmv-q:<채널ID>)로 분리하고 설정된 기본 화질 폴백을 제공한다.
 */
(() => {
  if (window.top === window) return;
  let params;
  try { params = new URLSearchParams(location.search); } catch { return; }
  if (params.get('cmv_page') !== '1') return;

  /* ---------------- 0. 칸 안에서 '스크롤 미니 플레이어' 모드 끄기 ----------------
   * 치지직은 플레이어 자리가 화면 밖으로 스크롤됐다고 판단하면(IntersectionObserver, threshold [0, 0.99])
   * 광고/방송을 오른쪽 위 작은 창(.pre_ad_mini / .mid_ad_mini)으로 줄인다.
   * 멀티뷰 칸은 확장 프로그램이 페이지 배치를 바꿔 둬서 이 판단이 잘못 켜지고,
   * 그 상태에서 광고가 '표시되지 않음'으로 처리되면 '광고 차단 프로그램을 사용 중이신가요?' 창이 뜬다.
   * 그래서 칸 안에서는 바로 그 관찰자에게만 '플레이어가 항상 화면에 보임'으로 알려 준다.
   */
  try {
    const NativeIO = window.IntersectionObserver;
      const isPlayerPipObserver = (opts) => {
        const th = opts && opts.threshold;
        return Array.isArray(th) && th.length === 2 && th[0] === 0 && th[1] === 0.99;
      };
      if (typeof NativeIO === 'function') {
        const PatchedIO = function IntersectionObserver(callback, options) {
          if (!isPlayerPipObserver(options) || typeof callback !== 'function') {
            return new NativeIO(callback, options);
          }
          const wrapped = (entries, observer) => {
            const fixed = entries.map((en) => ({
              target: en.target,
              time: en.time,
              rootBounds: en.rootBounds,
              boundingClientRect: en.boundingClientRect,
              intersectionRect: en.boundingClientRect,
              isIntersecting: true,
              intersectionRatio: 1,
            }));
            return callback(fixed, observer);
          };
          return new NativeIO(wrapped, options);
        };
        PatchedIO.prototype = NativeIO.prototype;
        window.IntersectionObserver = PatchedIO;
      }
    } catch {}

  /* ---------------- 1. 지연 시간 다중 추출 ---------------- */
  function readLatencyFromPlayer() {
    // 1차: 공식 디버그 함수 __getLiveInfo()
    try {
      if (typeof window.__getLiveInfo === 'function') {
        const info = window.__getLiveInfo();
        const ms = info && Number(info.latency ?? info.currentLatency ?? info.liveLatency);
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
    } catch {}

    // 2차: 플레이어 DOM의 React Fiber / 내부 인스턴스 탐색
    try {
      const el = document.querySelector('.pzp, [class*="pzp"], [class*="player"], video');
      if (el) {
        for (const k of Object.keys(el)) {
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
            let f = el[k];
            for (let i = 0; i < 12 && f; i += 1) {
              const p = f.memoizedProps || f.memoizedState;
              if (p && typeof p === 'object') {
                const lat = Number(p.latency ?? (p.liveInfo && p.liveInfo.latency));
                if (Number.isFinite(lat) && lat > 0) return lat;
              }
              f = f.return;
            }
          }
        }
      }
    } catch {}
    return null;
  }

  setInterval(() => {
    const ms = readLatencyFromPlayer();
    if (ms !== null && Number.isFinite(ms)) {
      window.postMessage({ __myMvLatency: true, ms }, location.origin);
    }
  }, 1000);

  /* ---------------- 2. 칸별 화질 격리 및 기본 화질 ---------------- */
  function currentChannelId() {
    const m = location.pathname.match(/\/live\/([0-9a-f]{32})/i);
    return m ? m[1].toLowerCase() : '';
  }
  function mineKey() {
    const cid = currentChannelId();
    return cid ? 'cmv-q:' + cid : '';
  }

  const TRACK_KEYS = new Set(['live-player-video-track', 'pzp-video-track', 'chzzk-video-track']);
  let defaultQualityHeight = 0; // tile.js에서 전달받는 기본 화질 (예: 1080, 720, 480, 360)

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__myMvDefaultQuality !== true) return;
    const h = parseInt(e.data.quality, 10);
    defaultQualityHeight = Number.isFinite(h) && h > 0 ? h : 0;
  });

  let store;
  try { store = window.localStorage; } catch { return; }
  const proto = Storage.prototype;
  const realGet = proto.getItem;
  const realSet = proto.setItem;

  // 사용자가 화질 메뉴에서 직접 고른 직후에만 채널 전용 화질로 저장
  let pickedAt = 0;
  const notePick = (e) => {
    if (!e.isTrusted) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (
      t &&
      t.closest &&
      t.closest('.pzp-ui-setting-quality-item, [class*="quality_item"], [class*="quality-item"], [role="menuitemradio"]')
    ) {
      pickedAt = Date.now();
    }
  };
  document.addEventListener('click', notePick, true);
  document.addEventListener('keydown', notePick, true);

  function getTrackValue() {
    const k = mineKey();
    const saved = k ? realGet.call(store, k) : null;
    if (saved) return saved;
    if (defaultQualityHeight > 0) {
      const w = Math.round((defaultQualityHeight * 16) / 9);
      return JSON.stringify({
        width: w,
        height: defaultQualityHeight,
        frameRate: 60,
         ABR: false,
      });
    }
    return null;
  }

  function remember(value) {
    if (Date.now() - pickedAt > 5000) return;
    const k = mineKey();
    if (k) realSet.call(store, k, String(value));
    window.postMessage({ __myMvQuality: true, value: String(value) }, location.origin);
  }

  proto.getItem = function (key) {
    if (this === store && TRACK_KEYS.has(key)) {
      const v = getTrackValue();
      if (v) return v;
    }
    return realGet.call(this, key);
  };

  proto.setItem = function (key, value) {
    if (this === store && TRACK_KEYS.has(key)) remember(value);
    return realSet.call(this, key, value);
  };

  try {
    const view = new Proxy(store, {
      get(target, prop) {
        if (TRACK_KEYS.has(prop)) {
          const v = getTrackValue();
          if (v) return v;
        }
        const val = Reflect.get(target, prop, target);
        return typeof val === 'function' ? val.bind(target) : val;
      },
      set(target, prop, value) {
        if (TRACK_KEYS.has(prop)) remember(value);
        return Reflect.set(target, prop, value, target);
      },
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => view });
  } catch {}

  /* ---------------- 3. 단일 방 통나무 집중 보호 (비활성 방의 서버 세션 가로채기 차단 + React 클릭 보조) ----------------
   * 치지직 통나무(5분 자동 적립 + 1시간 120 파워 보상)는 계정당 한 번에 단 하나의 방송에서만 적립된다.
   * 멀티뷰에 여러 방송이 켜져 있을 때 통나무 자동 수집을 켜지 않은 다른 칸(cmvLpActive === '0')이
   * 주기적으로 log-power API를 호출하면 치지직 서버가 시청 중인 방을 그 칸으로 바꿔버려
   * 정작 사용자가 통나무 수집을 켠 방에서 5분/1시간 보상이 쌓이지 않는 문제가 발생한다.
   * 이를 막기 위해 비활성 칸에서는 최초 1회 잔액 조회만 허용하고 이후 주기적 log-power 호출은 캐시로 응답한다.
   */
  let cachedLpBody = JSON.stringify({ code: 200, message: null, content: { amount: 0, claims: [] } });
  let initialLpFetched = false;
  const LP_URL_RE = /\/channels\/[0-9a-f]{32}\/log-power\b/i;

  function isLpActiveTile() {
    return document.documentElement && document.documentElement.dataset.cmvLpActive === '1';
  }

  // 통나무 활성 방이 백그라운드 탭/비활성 상태일 때도 5분·1시간 시청 타이머가 멈추지 않게 가시성 유지
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  } catch {}

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = async function (...args) {
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (LP_URL_RE.test(reqUrl)) {
          if (!isLpActiveTile() && initialLpFetched) {
            return new Response(cachedLpBody, {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const res = await origFetch.apply(this, args);
          if (res && res.ok) {
            initialLpFetched = true;
            try {
              res.clone().text().then((txt) => {
                if (txt && txt.startsWith('{')) cachedLpBody = txt;
              }).catch(() => {});
            } catch {}
          }
          return res;
        }
        return origFetch.apply(this, args);
      };
    }
  } catch {}

  /* 3-1. 시청 이벤트(watch-event) 단일 방 집중은 watch-guard-main.js 에서 모든 치지직 페이지에 공통 적용 */

  // 1시간 시청 통나무 배너의 React onClick 핸들러 직접 호출 폴백
  function triggerReactClick(el) {
    let cur = el;
    for (let depth = 0; depth < 4 && cur && cur !== document.body; depth += 1, cur = cur.parentElement) {
      try {
        for (const k of Object.keys(cur)) {
          if (k.startsWith('__reactProps$')) {
            const p = cur[k];
            if (p && typeof p.onClick === 'function') {
              p.onClick({
                preventDefault() {},
                stopPropagation() {},
                nativeEvent: new MouseEvent('click'),
                target: cur,
                currentTarget: cur,
              });
              return true;
            }
          }
        }
      } catch {}
    }
    return false;
  }

  window.addEventListener('__cmv_lp_click', () => {
    document.querySelectorAll('[data-cmv-lp-click="1"]').forEach((el) => {
      el.removeAttribute('data-cmv-lp-click');
      triggerReactClick(el);
    });
  });
})();

/**
 * My MultiView - 치지직 직접 보기(standalone) 전용: 광고 전체 화면 + 본방송 작게 + 광고 음소거
 *
 * 멀티뷰 칸(iframe)에서는 동작하지 않는다. 치지직 라이브 페이지를 직접 열었을 때만 동작하는 별도 코드로,
 * tile.js와 공유하는 상태나 메시지가 없어서 이 파일에서 에러가 나도 멀티뷰에는 영향을 주지 않는다.
 *
 * 동작:
 *  - 광고가 재생되면 광고를 화면 전체(100vw x 100vh)로 채우고, 본방송은 우측 상단 작은 PIP로 띄운다.
 *  - 광고 음소거 설정(my-multiview:tileAdMute, 기본 켬)이 켜져 있으면 광고 영상만 음소거한다.
 *  - 건너뛰기 버튼이 뜨면 자동으로 누르고, 광고가 멈춰 있으면 재생을 도와준다.
 */
(() => {
  if (window.top !== window) return; // 멀티뷰 칸(iframe)에서는 동작 안 함
  try {
    if (new URLSearchParams(location.search).get('cmv_page') === '1') return;
  } catch {}
  if (!/^\/live\/[0-9a-f]{32}/i.test(location.pathname)) return; // 라이브 페이지에서만
  if (window.__cmvStandaloneAd) return;
  window.__cmvStandaloneAd = true;

  const STYLE_ID = 'cmv-sa-ad';
  const AD_ROOTS =
    '[data-role="gvAdContainerEl"], .vod_player_wrap, .ad_info_area, #preAdVideoContainer, #preAdPlayerWrapper, #preAdContentPlayer, #midAdPlayerWrapper, #midPlayer, #midAdVideoContainer';

  let adMute = true; // 기본 켬
  let adActive = false;
  let lastUserInput = 0;
  let lastLiveKickAt = 0;
  let lastSkipClick = 0;
  const hookedAdVideos = new Set();

  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(ev, () => { lastUserInput = Date.now(); }, { passive: true });
  }

  function addStyle(id, css) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }
  const removeStyle = (id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  }

  function isAdVideo(v) {
    if (!(v instanceof HTMLVideoElement)) return false;
    if (v.getAttribute('title') === 'Advertisement') return true;
    if (v.getAttribute('data-role') === 'videoEl' && !v.classList.contains('webplayer-internal-video')) return true;
    return !!v.closest(AD_ROOTS + ', [class*="pzp-ad"], [class*="ad_overlay"], [class*="advertisement"]');
  }
  function adVideos() {
    return [...document.querySelectorAll('video')].filter(isAdVideo);
  }
  function activeAdVideos() {
    return adVideos().filter((v) => {
      if (!v.isConnected || v.ended) return false;
      const hasSrc = !!(v.currentSrc || v.getAttribute('src') || v.srcObject);
      if (!hasSrc && v.readyState === 0) return false;
      return visible(v);
    });
  }
  /** 본방송 <video> 요소를 우선 반환 (광고 video와 혼동하지 않도록 분리) */
  function mainVideo() {
    let best = null;
    let bestScore = -1;
    for (const v of document.querySelectorAll('video')) {
      if (isAdVideo(v)) continue;
      const r = v.getBoundingClientRect();
      const score =
        r.width * r.height +
        (v.paused ? 0 : 1e9) +
        (v.readyState >= 2 ? 1e8 : 0) +
        (v.currentSrc || v.getAttribute('src') || v.srcObject ? 1e7 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }
  function adRoots() {
    return [...document.querySelectorAll(AD_ROOTS)].filter(visible);
  }

  function isAdPlaying() {
    if (activeAdVideos().length > 0) return true;
    for (const el of document.querySelectorAll(
      '.ad_info_area, [data-role="countDownEl"], [class*="pzp-ad"], .pzp-pc--adbreak, .pzp--adbreak',
    )) {
      if (!visible(el)) continue;
      if (el.matches('.pzp-pc--adbreak, .pzp--adbreak')) return true;
      const root = el.closest(AD_ROOTS);
      const v = (root && root.querySelector('video')) || document.querySelector('video[title="Advertisement"]');
      if (v && !v.ended && (v.currentSrc || v.getAttribute('src') || v.srcObject || v.readyState > 0)) {
        return true;
      }
    }
    return false;
  }

  function hookAdVideo(av) {
    if (!(av instanceof HTMLVideoElement) || hookedAdVideos.has(av)) return;
    hookedAdVideos.add(av);
    av.addEventListener('volumechange', () => {
      if (adMute && !av.muted) av.muted = true;
    });
    const onAdEnd = () => setTimeout(checkAd, 30);
    av.addEventListener('ended', onAdEnd);
    av.addEventListener('emptied', onAdEnd);
  }

  // 광고 영역을 화면 전체 크기로 맞춤.
  // 치지직은 플레이어가 화면 밖으로 스크롤됐다고 판단하면 프리롤 광고를 '.pre_ad_mini'(오른쪽 위 작은 창)로 줄이는데,
  // 직접 보기에서는 페이지 배치가 그대로라 이 상태가 잘못 켜질 수 있어서 강제로 화면 전체 크기로 되돌린다.
  const AD_FILL_CSS = `
    *:has(> #preAdPlayerWrapper), *:has(> #preAdVideoContainer), *:has(> [data-role="gvAdContainerEl"]),
    *:has(> #midAdPlayerWrapper), *:has(> #midAdVideoContainer) {
      transform: none !important;
      contain: none !important;
      filter: none !important;
    }
    #preAdPlayerWrapper, #preAdPlayerWrapper.pre_ad_mini {
      position: fixed !important;
      inset: 0 !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      background: #000 !important;
    }
    #midAdPlayerWrapper:not([style*="display: none"]), #midAdPlayerWrapper.mid_ad_mini {
      position: fixed !important;
      inset: 0 !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483646 !important;
      background: #000 !important;
    }
    #midAdVideoContainer {
      width: 100% !important;
      height: 100% !important;
    }
    #midAdPlayerWrapper video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    }
    #preAdVideoContainer, [data-role="gvAdContainerEl"] {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      z-index: 2147483646 !important;
      background: #000 !important;
    }
    #preAdVideoContainer .vod_player_wrap, [data-role="gvAdContainerEl"] .vod_player_wrap {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
    }
    #preAdPlayerWrapper video, #preAdVideoContainer video, [data-role="gvAdContainerEl"] video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    }
  `;
  // 본방송 작은 PIP (광고 중 우측 상단)
  const PIP_CSS = `
    :root {
      --cmv-sa-pip-w: clamp(140px, 30vw, 300px);
    }
    *:has(video[data-cmv-sa-pip="1"]) {
      transform: none !important;
      perspective: none !important;
      filter: none !important;
      contain: none !important;
      clip-path: none !important;
      overflow: visible !important;
    }
    video[data-cmv-sa-pip="1"] {
      position: fixed !important;
      top: 28px !important;
      right: 0 !important;
      left: auto !important;
      bottom: auto !important;
      width: var(--cmv-sa-pip-w) !important;
      height: calc(var(--cmv-sa-pip-w) * 9 / 16) !important;
      max-width: var(--cmv-sa-pip-w) !important;
      max-height: calc(var(--cmv-sa-pip-w) * 9 / 16) !important;
      z-index: 2147483647 !important;
      background: #000 !important;
      object-fit: contain !important;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.65) !important;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
  `;

  function syncAdPipLayout(adPlaying) {
    if (!adPlaying) {
      document.querySelectorAll('video[data-cmv-sa-pip]').forEach((v) => v.removeAttribute('data-cmv-sa-pip'));
      removeStyle(STYLE_ID);
      return;
    }
    const lv = mainVideo();
    const lvSrc = lv ? String(lv.currentSrc || lv.getAttribute('src') || '') : '';
    const hasLiveStream = !!(
      lv &&
      !lv.ended &&
      !lv.paused &&
      lv.readyState >= 2 &&
      !lv.closest(AD_ROOTS) &&
      (lv.srcObject || lvSrc.startsWith('blob:'))
    );
    for (const v of document.querySelectorAll('video[data-cmv-sa-pip]')) {
      if (v !== lv || !hasLiveStream) v.removeAttribute('data-cmv-sa-pip');
    }
    if (lv && hasLiveStream) lv.setAttribute('data-cmv-sa-pip', '1');
    // 광고는 화면 전체로, 본방송은 우측 상단 작은 PIP로만 띄운다.
    addStyle(STYLE_ID, AD_FILL_CSS + (hasLiveStream ? PIP_CSS : ''));
  }

  function tryClickSkipButton() {
    if (Date.now() - lastSkipClick < 800) return false;
    const roots = adRoots();
    if (!roots.length) roots.push(document.body);
    const seen = new Set();
    for (const root of roots) {
      const cands = root.querySelectorAll(
        '[data-role*="skip" i], [class*="skip" i], button, [role="button"], a',
      );
      for (const el of cands) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        if (el.closest('[data-role="adLink"], .link_more, .link_btn_area')) continue; // '광고 페이지 보기'는 누르면 안 됨
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/skip|건너뛰기/i.test(t) || t.length > 20) continue;
        if (/\d\s*초|초\s*후/.test(t)) continue; // 아직 카운트다운 중
        const target = el.closest('button, [role="button"], a') || el;
        try {
          lastSkipClick = Date.now();
          target.click();
          return true;
        } catch {}
      }
    }
    return false;
  }

  function ensureAdProgress() {
    const avs = activeAdVideos();
    let anyPlaying = false;
    for (const av of avs) {
      hookAdVideo(av);
      if (!av.paused && av.currentTime > 0) {
        anyPlaying = true;
        continue;
      }
      // 프리롤 광고가 자동재생 정책에 걸려 멈추지 않도록 즉시 재생 시도 (막히면 음소거 후 재생)
      if (av.paused && !av.ended) {
        if (adMute) av.muted = true;
        av.play().catch(() => {
          av.muted = true;
          av.play().catch(() => {});
        });
      }
    }
    // 광고가 재생되는 동안에도 본방송(PIP)이 멈추지 않고 계속 재생되도록 보장
    const lv = mainVideo();
    if (lv && anyPlaying && lv.paused && !lv.ended && (lv.currentSrc || lv.getAttribute('src') || lv.srcObject)) {
      lv.play().catch(() => {});
    }
  }

  function ensureLiveProgress() {
    const lv = mainVideo();
    if (!lv) return;
    if (lv.paused && !lv.ended && Date.now() - lastUserInput > 2500 && Date.now() - lastLiveKickAt > 1200) {
      lastLiveKickAt = Date.now();
      lv.play().catch(() => {
        lv.muted = true;
        lv.play().catch(() => {});
      });
    }
  }

  function checkAd() {
    try {
      const adPlaying = isAdPlaying();
      syncAdPipLayout(adPlaying);
      if (adPlaying) {
        adActive = true;
        if (adMute) {
          for (const av of adVideos()) {
            hookAdVideo(av);
            if (!av.muted) av.muted = true;
          }
        }
        ensureAdProgress();
        tryClickSkipButton();
      } else if (adActive) {
        adActive = false;
      } else {
        ensureLiveProgress();
      }
    } catch {}
  }

  // 광고 음소거 설정 읽기 (멀티뷰 팝업 설정과 같은 저장소 — 읽기만 함)
  function refreshSettings() {
    try {
      chrome.storage.local.get('my-multiview:settings').then((o) => {
        const s = (o && o['my-multiview:settings']) || {};
        adMute = s['my-multiview:tileAdMute'] !== '0'; // 기본 켬
      }).catch(() => {});
    } catch {}
  }
  refreshSettings();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['my-multiview:settings']) refreshSettings();
    });
  } catch {}

  setInterval(checkAd, 350);
})();

/**
 * My MultiView - 멀티뷰 칸 안의 치지직 방송 페이지 정리 및 다중 방어 스크립트
 * 멀티뷰가 띄운 치지직 iframe(주소에 cmv_page=1)에서만 동작한다.
 *
 *  - 치지직 플레이어 4단계 다중 탐색 및 칸 꽉 채우기
 *  - 넓은 화면 유지 및 채팅 접기 (사용자가 직접 연 채팅은 유지)
 *  - 방송별 볼륨·음소거 저장/복원 + 멀티뷰 오디오 포커스/마우스 호버 음소거 연동
 *  - 방송별 화질 저장/복원 + 기본 화질(defaultQuality) 연동
 *  - 지연 시간 4중 측정, 지연 줄이기(FF), 싱크 맞추기
 *  - 통나무(Log Power) 갯수 확인 및 자동 획득 (API v1/v2 + 백그라운드 프록시 + DOM 버튼 3중 폴백, 무중단 토글)
 *  - 오디오 컴프레서(음량 평준화), 영상 필터(밝기/대비/채도/감마), 영상 비율(contain/cover), 광고 자동 음소거·스킵
 */
(() => {
  let params;
  try { params = new URLSearchParams(location.search); } catch { return; }
  if (params.get('cmv_page') !== '1' || window.top === window) return;

  const segs = location.pathname.split('/');
  const liveIdx = segs.indexOf('live');
  const channelId = (liveIdx >= 0 ? segs[liveIdx + 1] || '' : '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(channelId)) return;

  const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  const LP_STORE_KEY = 'my-multiview:lp';
  let claimOn = params.get('cmv_lp') === '1';
  const MARK = 'data-cmv-player';
  // #preAdPlayerWrapper / #preAdContentPlayer: 치지직 프리롤 광고 플레이어 (광고 영상이 여기서 재생되기도 함)
  // #midAdPlayerWrapper / #midPlayer / #midAdVideoContainer: 방송 중간 광고 플레이어
  const AD_ROOTS =
    '[data-role="gvAdContainerEl"], .vod_player_wrap, .ad_info_area, #preAdVideoContainer, #preAdPlayerWrapper, #preAdContentPlayer, #midAdPlayerWrapper, #midPlayer, #midAdVideoContainer';

  function syncLpDataset() {
    if (document.documentElement) {
      document.documentElement.dataset.cmvLpActive = claimOn ? '1' : '0';
    }
  }
  syncLpDataset();

  const toParent = (data) => {
    try { window.parent.postMessage({ cmv: 1, ...data }, EXT_ORIGIN); } catch {}
  };

  /* ---------------- 방송 꺼진 페이지 ----------------
   * 방송이 꺼져 있으면 칸 정리(꽉 채우기, 채팅 접기, 사이드바 숨김 등)를 모두 풀고
   * 치지직 페이지를 평소 모습 그대로(위 메뉴, 왼쪽 메뉴, 스크롤) 보여준다.
   */
  let offlinePage = false;
  const PAGE_STYLES = new Set(['cmv-tile', 'cmv-fill', 'cmv-hide-chat', 'cmv-minimal-ui', 'cmv-ad-pip']);

  /* ---------------- 스타일 유틸리티 ---------------- */
  function addStyle(id, css) {
    if (offlinePage && PAGE_STYLES.has(id)) return;
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

  addStyle(
    'cmv-tile',
    `
    html, body { overflow: hidden !important; background: #000 !important; margin: 0 !important; padding: 0 !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    /* 치지직 왼쪽 메뉴(사이드바)는 칸 안에서 내용 없이 빈 사각형으로만 남아서 숨김 */
    #sidebar, aside[class*="sidebar"] { display: none !important; }
    /* 페이지 최소 폭(950px)이 칸보다 넓어서 화면이 잘리던 것 풀기 */
    #root > [class*="_glive_"] { min-width: 0 !important; }
  `,
  );

  let currentVideoFit = 'contain';
  function buildFillCss() {
    return `
      header, nav, footer,
      [class*="header_container"], [class*="navigation_bar"], [class*="aside_container"],
      [class*="live_information_container"], [class*="footer_container"] {
        display: none !important;
      }
      #layout-body, [class*="layout_glounge"], [class*="layout_main"], [class*="live_container"], main {
        padding-left: 0 !important;
        margin-left: 0 !important;
      }
      [${MARK}] {
        position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
        max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
        z-index: 2147483646 !important; background: #000 !important;
      }
      [${MARK}] video, video {
        width: 100% !important; height: 100% !important;
        object-fit: ${currentVideoFit} !important;
      }
    `;
  }

  const textOf = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const insideChat = (el) =>
    !!el.closest('[class*="chatting_list"],[class*="chatting_message"],[data-chat-message]');
  const buttons = () =>
    [...document.querySelectorAll('button,[role="button"]')].filter((b) => !insideChat(b));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  }

  /* ---------------- 1. 영상 및 플레이어 4단계 다중 탐색 (광고 영상과 본방송 영상 분리) ---------------- */
  function isAdVideo(v) {
    if (!(v instanceof HTMLVideoElement)) return false;
    if (v.getAttribute('title') === 'Advertisement') return true;
    if (v.getAttribute('data-role') === 'videoEl' && !v.classList.contains('webplayer-internal-video')) return true;
    return !!v.closest(AD_ROOTS + ', [class*="pzp-ad"], [class*="ad_overlay"], [class*="advertisement"]');
  }

  function adVideos() {
    return [...document.querySelectorAll('video')].filter(isAdVideo);
  }

  /** 실제로 현재 재생/로딩 중인 광고 <video>만 반환 (빈 컨테이너 잔류로 인한 오탐 방지) */
  function activeAdVideos() {
    return adVideos().filter((v) => {
      if (!v.isConnected || v.ended) return false;
      const hasSrc = !!(v.currentSrc || v.getAttribute('src') || v.srcObject);
      if (!hasSrc && v.readyState === 0) return false;
      return visible(v);
    });
  }

  /** 본방송 <video> 요소를 우선 반환 (광고 재생 중에도 광고 video와 혼동하지 않도록 분리) */
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

  function markPlayer() {
    const v = mainVideo() || document.querySelector('video');
    const anchor =
      v ||
      document.querySelector('.pzp, [class*="live_player"], #preAdVideoContainer, [data-role="gvAdContainerEl"]');
    if (!anchor) return;
    let root = null;

    // 1단계: 알려진 플레이어 래퍼 클래스 탐색 (pzp 및 치지직 플레이어 레이아웃)
    for (let p = anchor.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cls = typeof p.className === 'string' ? p.className : '';
      const id = p.id || '';
      if (/(^|\s|_|-)(pzp|live_player|video_player|webplayer|player_container)/i.test(cls + ' ' + id)) {
        // 채팅 영역까지 포함하는 최상위 레이아웃은 제외
        if (!p.querySelector('aside[class*="chatting"], [class*="live_chatting_container"]')) {
          root = p;
        }
      }
    }

    // 2단계: 클래스명이 바뀌었더라도 컨트롤 버튼을 포함하고 채팅창은 포함하지 않는 가장 바깥 컨테이너 탐색
    if (!root) {
      for (let p = anchor.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (p.querySelector('aside[class*="chatting"], [class*="live_chatting_container"], header')) break;
        root = p;
      }
    }

    // 3단계: 최소한 anchor의 부모 요소 보장
    if (!root) root = anchor.parentElement || anchor;

    // 4단계: 프리롤 광고 컨테이너(#preAdVideoContainer / gvAdContainerEl)가 형제 요소로 따로 있는 경우 함께 품는 상위 래퍼로 확장
    const adContainer = document.querySelector('#preAdVideoContainer, [data-role="gvAdContainerEl"]');
    if (root && adContainer && !root.contains(adContainer)) {
      for (let p = root.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (p.querySelector('header, nav, aside[class*="chatting"], [class*="live_chatting_container"]')) break;
        if (p.contains(adContainer)) {
          root = p;
          break;
        }
      }
    }

    if (root && !root.hasAttribute(MARK)) {
      document.querySelectorAll(`[${MARK}]`).forEach((el) => el.removeAttribute(MARK));
      root.setAttribute(MARK, '');
    }
  }

  /* ---------------- 2. 기본 화면 유지 및 백그라운드 채팅 마운트 ----------------
   * 치지직은 '기본 화면'에서 우측 채팅창(aside[class*="live_chatting"])이 펼쳐져 있어야
   *  1) 광고 재생 중 채팅창 상단에 본방송 미니플레이어(PIP)가 동시에 표시되고
   *  2) 통나무 5분 자동 수집 타이머 및 1시간 시청 보상 배너가 작동한다.
   * 따라서 생방송 중에는 항상 기본 화면 + 채팅창 펼침 상태를 유지하되,
   * 평상시에는 CSS로 플레이어가 칸 전체(100vw x 100vh)를 꽉 채우고 채팅창은 뒤에 숨겨 두었다가
   * 광고가 재생될 때만 메인(좌측) = 광고(음소거), 우측 채팅창 상단 = 본방송(소리 재생) 레이아웃으로 자동 전환한다.
   */
  let wideClickedAt = 0;
  function keepWide() {
    if (isAdPlaying()) return;
    const v = mainVideo();
    if (!v || v.readyState < 2) return;
    const btn =
      document.querySelector('.pzp-pc__viewmode-button, [class*="viewmode-button"], [class*="viewmode_button"]') ||
      buttons().find((b) => /넓은\s*화면|기본\s*화면|일반\s*화면/.test(textOf(b)));
    if (!btn) return;
    const t = textOf(btn);
    // 이전에 '넓은 화면'이 켜져 있었다면 '기본 화면'으로 되돌려 우측 채팅창 상단 미니플레이어가 작동하게 함
    const isWideNow = /기본\s*화면|일반\s*화면/.test(t) || btn.getAttribute('aria-pressed') === 'true';
    if (!isWideNow) return;
    if (Date.now() - wideClickedAt < 4000) return;
    wideClickedAt = Date.now();
    btn.click();
  }

  const HIDE_CHAT = 'cmv-hide-chat';
  let chatHidden = true;
  function hideChat(on) {
    chatHidden = on;
    if (on) {
      // 생방송 중에는 채팅창이 언마운트되지 않도록 플레이어(z-index: 2147483646) 뒤쪽에 투명 마운트 유지
      addStyle(
        HIDE_CHAT,
        `
          aside[class*="live_chatting"], [class*="live_chatting_container"] {
            position: fixed !important;
            right: 0 !important;
            top: 0 !important;
            width: 320px !important;
            height: 100vh !important;
            opacity: 0.001 !important;
            pointer-events: none !important;
            z-index: 1 !important;
            overflow: hidden !important;
          }
        `,
      );
      addStyle('cmv-fill', buildFillCss());
    } else {
      addStyle(
        HIDE_CHAT,
        `
          header, nav, [class*="header_container"], [class*="navigation_bar"], [class*="gnb"] { display: none !important; }
          #layout-body, [class*="layout_glounge"], [class*="layout_main"], [class*="live_container"], main {
            padding-left: 0 !important;
            margin-left: 0 !important;
            padding-top: 0 !important;
          }
          aside[class*="live_chatting"], [class*="live_chatting_container"] {
            padding-top: 30px !important;
            box-sizing: border-box !important;
          }
        `,
      );
      removeStyle('cmv-fill');
    }
  }
  hideChat(true);

  let lastUserInput = 0;
  let userChat = false;
  let chatWasOpen = false;
  let chatClickedAt = 0;
  // 전체화면/크게 보기 전환 직후의 채팅 상태 변화는 '사용자가 직접 연 것'으로 보지 않는다
  // 칸 안에서 치지직 채팅을 직접 열어 보는 것을 허용할지 (false: 칸은 항상 영상만 꽉 채우고 채팅은 멀티뷰 채팅 패널로만)
  const ALLOW_TILE_CHAT = false;
  // 이 칸이 전체화면인지: 칸 안 플레이어가 전체화면이거나, 칸(iframe) 자체가 화면 크기만큼 커졌을 때
  const inTileFullscreen = () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) return true;
      return window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2;
    } catch {
      return false;
    }
  };
  let wasFullscreen = false;
  let ignoreChatChangeUntil = 0;
  const settleChat = () => {
    ignoreChatChangeUntil = Date.now() + 3000;
    lastUserInput = 0;
  };
  document.addEventListener('fullscreenchange', settleChat, true);
  document.addEventListener('webkitfullscreenchange', settleChat, true);
  const noteInput = (e) => {
    if (e.isTrusted) {
      lastUserInput = Date.now();
      tryUnmutePendingAutoplay();
    }
  };
  document.addEventListener('pointerdown', noteInput, true);
  document.addEventListener('keydown', noteInput, true);
  // 사용자가 치지직 플레이어의 음소거 버튼을 직접 누른 시각 (직접 음소거/해제 의도 판단용)
  // 코드가 버튼을 직접 누르는 경우(.click())는 pointerdown이 안 생겨서 구분된다.
  const MUTE_BTN_SEL = '.pzp-pc-volume-button, .pzp-pc-volume-button button, .pzp-volume-button, button[aria-label*="음소거"]';
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    if (e.target && e.target.closest && e.target.closest(MUTE_BTN_SEL)) {
      lastMuteBtnPointerAt = Date.now();
    }
  }, true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const b = e.target && e.target.closest && e.target.closest('button,[role="button"]');
      if ((ALLOW_TILE_CHAT || inTileFullscreen()) && b && /채팅/.test(textOf(b)) && !/접기|닫기|숨기기/.test(textOf(b))) {
        userChat = true;
        hideChat(false);
      }
    },
    true,
  );

  function chatOpenNow() {
    for (const el of document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')) {
      const hint =
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('data-placeholder') ||
        '';
      if (/채팅/.test(hint) && el.isConnected) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      }
    }
    return false;
  }

  function keepChatFolded() {
    const open = chatOpenNow();
    // 스크립트가 직접 펼친 직후 / 전체화면·크게 보기 전환 직후엔 사용자 조작으로 오인하지 않음
    const settling = Date.now() < ignoreChatChangeUntil || Date.now() - chatClickedAt < 3000;
    const fs = inTileFullscreen();
    if (fs !== wasFullscreen) {
      wasFullscreen = fs;
      // 전체화면이 끝나는 순간엔 채팅 표시 상태를 남기지 않고 칸 꽉 채움 상태로 복귀
      if (!fs && !ALLOW_TILE_CHAT) {
        userChat = false;
        hideChat(true);
      }
    }
    if (!ALLOW_TILE_CHAT && !fs) {
      // 칸 안 채팅 표시 차단(전체화면 제외): 어떤 경로로든 보이는 상태가 되면 즉시 숨김으로 되돌림
      userChat = false;
      if (!chatHidden) hideChat(true);
    } else if (!settling && open && !chatWasOpen && Date.now() - lastUserInput < 4000) userChat = true;
    if (!open && chatWasOpen && Date.now() - lastUserInput < 4000) {
      userChat = false;
      hideChat(true);
    }
    chatWasOpen = open;
    if (userChat) {
      hideChat(false);
      return;
    }
    // 생방송 중에는 광고 시 채팅창 상단 미니플레이어(PIP) 및 통나무 타이머가 작동하도록 채팅창을 펼친 상태로 마운트 유지
    if (!offlinePage) {
      if (!open && Date.now() - chatClickedAt >= 3000) {
        const unfold = buttons().find((b) => /채팅\s*창?\s*(펼치기|열기|보이기)|채팅\s*보기/.test(textOf(b)));
        if (unfold) {
          chatClickedAt = Date.now();
          unfold.click();
        }
      }
      return;
    }
    if (!open || Date.now() - chatClickedAt < 3000) return;
    const fold = buttons().find((b) => /채팅\s*창?\s*(접기|닫기|숨기기)/.test(textOf(b)));
    if (!fold) return;
    chatClickedAt = Date.now();
    fold.click();
  }

  /* ---------------- 3. 볼륨·음소거 (광고 음소거 오염 방지 및 자동재생 차단 복구) ---------------- */
  const VOL_KEY = 'my-multiview:vol:' + channelId;
  const hooked = new WeakSet();
  const hookedAdVideos = new WeakSet();
  let ignoreVolumeUntil = 0;
  let focusMute = null;          // 크게 보기 또는 마우스 호버 오디오로 멀티뷰가 정한 음소거 (null이면 해제)
  let beforeFocus = null;        // 포커스/호버 전 원래 상태
  let focusUserOverride = null;  // 크게 보기 중 사용자가 이 칸에서 직접 켜거나 끈 소리 (null = 없음)
  let lastFocusInstr = null;     // 멀티뷰가 마지막으로 보낸 크게 보기 음소거 지시
  let userDesiredMuted = false;  // 사용자가 의도한 본방송 음소거 상태 (광고 음소거에 절대 오염되지 않음)
  let userDesiredVolume = 0.5;   // 사용자가 의도한 본방송 볼륨
  let pendingAutoplayUnmute = false; // 브라우저 자동재생 정책 때문에 임시 음소거된 경우
  let adActive = false;
  let adMuted = false;
  let wasMutedBeforeAd = false;
  let lastAdEndedAt = 0;
  let lastUnmuteBtnClickAt = 0;
  let lastKnownMuted = false; // 마지막으로 확인한 본방송 음소거 상태 (사용자 직접 변경 감지용)
  let lastProgrammaticMuteAt = 0; // 우리가 코드로 음소거를 바꾼 마지막 시각
  let lastMuteBtnPointerAt = 0; // 사용자가 치지직 음소거 버튼을 직접 누른 마지막 시각

  function shouldMuteLive() {
    return focusMute !== null ? focusMute : userDesiredMuted;
  }

  function reportAudioState(v, user = false) {
    if (!v || isAdVideo(v)) return;
    toParent({ type: 'CMV_AUDIO_STATE', muted: !!v.muted, volume: Number(v.volume), user: !!user });
  }

  /** 치지직 플레이어(또는 미니플레이어) 내부 음소거 버튼이 '음소거 해제' 상태면 클릭하여 내부 상태까지 동기화 */
  function clickUnmuteButtonIfNeeded() {
    if (Date.now() - lastUnmuteBtnClickAt < 600) return false;
    const cands = document.querySelectorAll(
      '.pzp-pc-volume-button[aria-label*="음소거 해제"], button[aria-label*="음소거 해제"], button[title*="음소거 해제"]',
    );
    for (const btn of cands) {
      if (btn.closest(AD_ROOTS)) continue;
      lastUnmuteBtnClickAt = Date.now();
      ignoreVolumeUntil = Date.now() + 1200;
      try {
        btn.click();
        return true;
      } catch {}
    }
    return false;
  }

  /**
   * 우리가 영상을 직접 음소거하면 치지직 플레이어 내부는 여전히 '소리 켜짐'으로 알고 있어서,
   * 사용자가 스피커 버튼을 눌러도 첫 클릭은 플레이어가 '음소거'로 처리해 소리가 안 켜진다.
   * 그래서 음소거할 때 플레이어 버튼이 아직 '음소거'(= 지금 소리 켜짐) 상태면 눌러서 내부 상태도 맞춘다.
   */
  let lastMuteBtnClickAt = 0;
  function clickMuteButtonIfNeeded(v) {
    if (!v || !v.muted || Date.now() - lastMuteBtnClickAt < 600) return false;
    const cands = document.querySelectorAll(
      '.pzp-pc-volume-button, .pzp-pc-volume-button button, .pzp-volume-button, button[aria-label*="음소거"]',
    );
    for (const btn of cands) {
      if (btn.closest(AD_ROOTS)) continue;
      const label = btn.getAttribute('aria-label') || btn.getAttribute('title') || '';
      if (!/음소거/.test(label) || /해제/.test(label)) continue;
      lastMuteBtnClickAt = Date.now();
      ignoreVolumeUntil = Date.now() + 1200;
      try {
        btn.click();
        // 플레이어가 버튼 처리 중 소리를 켜버린 경우 다시 음소거 유지
        setTimeout(() => {
          if (shouldMuteLive() && !v.muted) {
            ignoreVolumeUntil = Date.now() + 800;
            v.muted = true;
          }
        }, 120);
        return true;
      } catch {}
    }
    return false;
  }

  function tryUnmutePendingAutoplay() {
    if (!pendingAutoplayUnmute) return;
    if (shouldMuteLive()) {
      pendingAutoplayUnmute = false;
      return;
    }
    const v = mainVideo();
    if (!v) return;
    pendingAutoplayUnmute = false;
    setMuted(v, false);
  }

  function setMuted(v, muted) {
    if (!v || isAdVideo(v)) return;
    ignoreVolumeUntil = Date.now() + 1500;
    v.muted = muted;
    lastProgrammaticMuteAt = Date.now();
    lastKnownMuted = muted;
    if (!muted) {
      if (v.volume === 0) v.volume = userDesiredVolume > 0 ? userDesiredVolume : 0.5;
      clickUnmuteButtonIfNeeded();
      v.muted = false;
      const recoverPlay = () => {
        if (!v.paused || v.ended) return;
        v.play().catch((err) => {
          // AbortError(스트림 전환 중 로드)는 무시하고, NotAllowedError(자동재생 차단)일 때만 임시 음소거 후 재생 보장
          if (!err || err.name === 'NotAllowedError') {
            ignoreVolumeUntil = Date.now() + 1500;
            v.muted = true;
            pendingAutoplayUnmute = true;
            v.play().catch(() => {});
          }
        });
      };
      recoverPlay();
      // 크롬이 비활성 프레임의 음소거 해제 직후 비동기로 일시정지시키는 경우까지 방어
      setTimeout(() => {
        if (v.paused && !v.ended) recoverPlay();
      }, 90);
    } else {
      pendingAutoplayUnmute = false;
      // 플레이어 버튼 표시가 반영될 시간을 조금 두고 내부 상태 동기화
      setTimeout(() => {
        if (v.isConnected && v.muted) clickMuteButtonIfNeeded(v);
      }, 200);
    }
    reportAudioState(v);
  }

  function applyVolume(v, s) {
    if (!v || !s || isAdVideo(v)) return;
    ignoreVolumeUntil = Date.now() + 1500;
    if (typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1) {
      if (s.volume > 0) userDesiredVolume = s.volume;
      v.volume = s.volume > 0 ? s.volume : userDesiredVolume;
    }
    const nextMuted = typeof s.userMuted === 'boolean' ? s.userMuted : typeof s.muted === 'boolean' ? s.muted : false;
    userDesiredMuted = nextMuted;
    setMuted(v, shouldMuteLive());
    reportAudioState(v);
  }

  function hookVideo() {
    const v = mainVideo();
    if (!v || hooked.has(v)) return;
    hooked.add(v);
    toParent({ type: 'CMV_FRAME_READY' });
    chrome.storage.local
      .get(VOL_KEY)
      .then((o) => {
        const s = o && o[VOL_KEY];
        if (s) {
          if (typeof s.volume === 'number' && s.volume > 0 && s.volume <= 1) userDesiredVolume = s.volume;
          // 과거 광고 버그로 오염된 s.muted는 무시하고, 사용자가 명시적으로 누른 s.userMuted만 반영
          if (typeof s.userMuted === 'boolean') userDesiredMuted = s.userMuted;
        }
        v.volume = userDesiredVolume > 0 ? userDesiredVolume : 0.5;
        setMuted(v, shouldMuteLive());
        setTimeout(() => {
          if (v.isConnected) setMuted(v, shouldMuteLive());
        }, 2000);
      })
      .catch(() => {});

    let t = 0;
    v.addEventListener('volumechange', () => {
      if (isAdVideo(v)) {
        if (cachedAdMuteSetting && !v.muted) v.muted = true;
        return;
      }

      // 사용자가 직접 음소거 버튼을 눌러 음소거 상태를 바꾼 경우: 광고·자동재생 대기 중이라도 의도로 인정한다.
      // (기존에는 pendingAutoplayUnmute/광고 중이면 사용자 조작을 전부 무시해서, 직접 해제해도 다시 음소거됐다.)
      // 코드가 바꾼 직후(300ms 이내)에 생긴 변경은 우리 것이므로 의도로 보지 않는다.
      const mutedFlipped = v.muted !== lastKnownMuted;
      lastKnownMuted = v.muted;
      if (
        mutedFlipped &&
        Date.now() - lastProgrammaticMuteAt > 300 &&
        (Date.now() - lastMuteBtnPointerAt < 1500 || Date.now() - lastUserInput < 1200)
      ) {
        if (!v.muted) pendingAutoplayUnmute = false; // 직접 해제면 자동재생 대기 해제
        userDesiredMuted = v.muted;
        if (v.volume > 0) userDesiredVolume = v.volume;
        if (focusMute !== null) {
          focusUserOverride = v.muted;
          focusMute = v.muted;
        }
        clearTimeout(t);
        t = setTimeout(() => {
          chrome.storage.local
            .set({ [VOL_KEY]: { volume: userDesiredVolume, userMuted: userDesiredMuted } })
            .catch(() => {});
        }, 300);
        reportAudioState(v, true); // 사용자가 칸 안에서 직접 바꾼 소리 상태 (멀티뷰 전체 음소거 버튼 해제 판단용)
        return;
      }

      // 사용자가 직접 칸 내부를 클릭/조작한 직후(1.2초 이내)이고 광고 중이 아닐 때만 사용자 볼륨/음소거 변경으로 인정
      const userInitiated =
        Date.now() - lastUserInput < 1200 &&
        focusMute === null &&
        !adActive &&
        !adMuted &&
        !pendingAutoplayUnmute &&
        !isAdPlaying() &&
        Date.now() >= ignoreVolumeUntil &&
        Date.now() - lastAdEndedAt >= 3500;

      // 크게 보기(또는 마우스 올린 방송만 소리) 중에 사용자가 이 칸 소리를 직접 켜거나 끈 경우:
      // 그 상태를 이번 크게 보기 동안만 유지하고, 원래 소리 설정(beforeFocus)은 건드리지 않음 → 크게 보기를 끄면 원래대로 복원
      if (
        focusMute !== null &&
        Date.now() - lastUserInput < 1200 &&
        !adActive &&
        !adMuted &&
        !pendingAutoplayUnmute &&
        !isAdPlaying() &&
        Date.now() >= ignoreVolumeUntil
      ) {
        focusUserOverride = v.muted;
        focusMute = v.muted;
        reportAudioState(v);
        return;
      }

      if (userInitiated) {
        // 음소거 상태 변경은 위에서(직접 버튼 조작) 이미 처리했으므로, 여기서는 볼륨만 저장한다.
        // (음소거된 채로 볼륨만 올렸을 때 muted=true가 의도로 굳어지는 것을 방지)
        if (v.volume > 0) userDesiredVolume = v.volume;
        clearTimeout(t);
        t = setTimeout(() => {
          chrome.storage.local
            .set({ [VOL_KEY]: { volume: userDesiredVolume, userMuted: userDesiredMuted } })
            .catch(() => {});
        }, 300);
        reportAudioState(v, true); // 사용자가 칸 안에서 직접 바꾼 소리 상태 (멀티뷰 전체 음소거 버튼 해제 판단용)
        return;
      }

      // 사용자 조작이 아닌데 치지직/광고 스크립트가 본방송 비디오를 멋대로 음소거한 경우 즉시 복원!
      const targetMuted = shouldMuteLive();
      if (!targetMuted && !pendingAutoplayUnmute && Date.now() >= ignoreVolumeUntil) {
        if (v.muted || v.volume === 0) {
          ignoreVolumeUntil = Date.now() + 1000;
          if (v.volume === 0) v.volume = userDesiredVolume > 0 ? userDesiredVolume : 0.5;
          v.muted = false;
          clickUnmuteButtonIfNeeded();
        }
      }
      reportAudioState(v);
    });
    // 초기 오디오 효과 및 필터 반영
    refreshTileFx();
    reportAudioState(v);
  }

  /* ---------------- 4. 오디오 압축 + 영상 필터 + 비율 (스타일시트 기반으로 경량화) ---------------- */
  const SET_KEY = 'my-multiview:settings';
  let audioCtx = null;
  let audioSrc = null;
  let audioComp = null;
  let audioVideo = null;

  function readTileSettings() {
    return chrome.storage.local
      .get(SET_KEY)
      .then((o) => {
        const s = (o && o[SET_KEY]) || {};
        return {
          compress: s['my-multiview:tileAudioCompress'] === '1',
          brightness: Math.min(200, Math.max(0, parseInt(s['my-multiview:tileBrightness'], 10) || 100)),
          contrast: Math.min(200, Math.max(0, parseInt(s['my-multiview:tileContrast'], 10) || 100)),
          saturate: Math.min(200, Math.max(0, parseInt(s['my-multiview:tileSaturate'], 10) || 100)),
          gamma: Math.min(200, Math.max(50, parseInt(s['my-multiview:tileGamma'], 10) || 100)),
          videoFit: s['my-multiview:tileVideoFit'] === 'cover' || s['my-multiview:videoFit'] === 'cover' ? 'cover' : 'contain',
          defaultQuality: s['my-multiview:defaultQuality'] || 'auto',
          adMute: s['my-multiview:tileAdMute'] !== '0', // 기본 켬: 광고 자동 음소거 및 종료 후 복원
        };
      })
      .catch(() => ({
        compress: false,
        brightness: 100,
        contrast: 100,
        saturate: 100,
        gamma: 100,
        videoFit: 'contain',
        defaultQuality: 'auto',
        adMute: true,
      }));
  }

  function ensureGammaFilter(gammaPct) {
    let svg = document.getElementById('cmv-gamma-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'cmv-gamma-svg';
      svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;';
      svg.innerHTML = `<filter id="cmv-gamma"><feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="1" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="1" offset="0"/><feFuncB type="gamma" amplitude="1" exponent="1" offset="0"/></feComponentTransfer></filter>`;
      document.documentElement.appendChild(svg);
    }
    const exp = (100 / Math.max(50, gammaPct)).toFixed(3);
    svg.querySelectorAll('feFuncR, feFuncG, feFuncB').forEach((el) => {
      el.setAttribute('exponent', exp);
    });
  }

  function applyFilterStyle(st) {
    const parts = [];
    if (st.brightness !== 100 || st.contrast !== 100 || st.saturate !== 100) {
      parts.push(`brightness(${st.brightness}%) contrast(${st.contrast}%) saturate(${st.saturate}%)`);
    }
    if (st.gamma !== 100) {
      ensureGammaFilter(st.gamma);
      parts.push('url(#cmv-gamma)');
    }
    if (parts.length) {
      addStyle('cmv-video-fx', `video { filter: ${parts.join(' ')} !important; }`);
    } else {
      removeStyle('cmv-video-fx');
    }
  }

  function ensureAudioGraph(v) {
    if (audioVideo === v && audioCtx) return true;
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioSrc = audioCtx.createMediaElementSource(v);
      audioComp = audioCtx.createDynamicsCompressor();
      audioComp.threshold.value = -24;
      audioComp.knee.value = 30;
      audioComp.ratio.value = 12;
      audioComp.attack.value = 0.003;
      audioComp.release.value = 0.25;
      audioSrc.connect(audioComp);
      audioComp.connect(audioCtx.destination);
      audioVideo = v;
      return true;
    } catch {
      audioCtx = null;
      return false;
    }
  }

  function applyAudioCompress(v, on) {
    if (!on) {
      if (audioComp) audioComp.ratio.value = 1;
      return;
    }
    if (!ensureAudioGraph(v)) return;
    audioComp.ratio.value = 12;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  let cachedAdMuteSetting = true;
  function refreshTileFx() {
    readTileSettings().then((st) => {
      cachedAdMuteSetting = st.adMute;
      if (currentVideoFit !== st.videoFit) {
        currentVideoFit = st.videoFit;
        if (chatHidden) addStyle('cmv-fill', buildFillCss());
      }
      applyFilterStyle(st);
      window.postMessage({ __myMvDefaultQuality: true, quality: st.defaultQuality }, location.origin);
      const v = mainVideo();
      if (v) applyAudioCompress(v, st.compress);
    });
  }

  /** 멀티뷰 어느 칸에서든 통나무 수집이 켜져 있는지 (MAIN 월드의 시청 이벤트 집중 처리에서 사용) */
  function setLpAny(lpId) {
    if (document.documentElement) {
      document.documentElement.dataset.cmvLpAny = /^[0-9a-f]{32}$/.test(lpId) ? '1' : '0';
    }
  }

  function applyClaimOnState(nextOn) {
    const boolOn = !!nextOn;
    const changed = claimOn !== boolOn;
    claimOn = boolOn;
    syncLpDataset();
    if (changed && !offlinePage) {
      if (chatHidden) hideChat(true);
      keepChatFolded();
    }
    if (claimOn) {
      checkLogPower(true);
    }
  }

  chrome.storage.local
    .get(LP_STORE_KEY)
    .then((o) => {
      const lp = o && typeof o[LP_STORE_KEY] === 'string' ? o[LP_STORE_KEY].toLowerCase() : '';
      setLpAny(lp);
      if (lp) applyClaimOnState(lp === channelId);
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SET_KEY]) refreshTileFx();
    if (changes[LP_STORE_KEY]) {
      const nextLp = String(changes[LP_STORE_KEY].newValue || '').toLowerCase();
      setLpAny(nextLp);
      applyClaimOnState(nextLp === channelId);
    }
  });
  refreshTileFx();

  /* ---------------- 5. 화질 백업 ---------------- */
  const MY_TRACK = 'cmv-q:' + channelId;
  const Q_KEY = 'my-multiview:q:' + channelId;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  if (!lsGet(MY_TRACK)) {
    chrome.storage.local
      .get(Q_KEY)
      .then((o) => {
        const v = o && o[Q_KEY];
        if (v && !lsGet(MY_TRACK)) lsSet(MY_TRACK, v);
      })
      .catch(() => {});
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__myMvQuality !== true) return;
    chrome.storage.local.set({ [Q_KEY]: String(e.data.value) }).catch(() => {});
  });

  /* ---------------- 6. 지연 시간 4중 측정 및 동기화 ---------------- */
  let pageLatency = null;
  let pageLatencyAt = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__myMvLatency !== true) return;
    const n = Number(e.data.ms);
    if (Number.isFinite(n) && n > 0) {
      pageLatency = n;
      pageLatencyAt = Date.now();
    }
  });

  function latencyMs() {
    // 1·2차: tile-main.js가 플레이어/React에서 추출한 지연 시간
    if (pageLatency != null && Date.now() - pageLatencyAt < 3500) return pageLatency;
    const v = mainVideo();
    if (!v) return null;
    // 3차: video.seekable 범위
    try {
      const r = v.seekable;
      if (r && r.length) {
        const diff = (r.end(r.length - 1) - v.currentTime) * 1000;
        if (Number.isFinite(diff) && diff >= 0 && diff < 300000) return diff;
      }
    } catch {}
    // 4차: video.buffered 범위
    try {
      const b = v.buffered;
      if (b && b.length) {
        const diff = (b.end(b.length - 1) - v.currentTime) * 1000;
        if (Number.isFinite(diff) && diff >= 0 && diff < 300000) return diff;
      }
    } catch {}
    return null;
  }

  setInterval(() => {
    const ms = latencyMs();
    if (ms != null && ms > 0) toParent({ type: 'CMV_LATENCY', ms });
  }, 1000);

  function fastForward(marginSec) {
    const v = mainVideo();
    if (!v) return;
    try {
      const b = v.buffered && v.buffered.length ? v.buffered : v.seekable;
      if (!b || !b.length) return;
      const to = b.end(b.length - 1) - marginSec;
      if (to > v.currentTime && to > b.start(b.length - 1)) v.currentTime = to;
    } catch {}
  }

  function syncTo(targetMs) {
    const v = mainVideo();
    if (!v) return;
    try {
      const r = v.seekable && v.seekable.length ? v.seekable : v.buffered;
      if (!r || !r.length) return;
      const to = Math.max(r.start(0) + 0.2, r.end(r.length - 1) - targetMs / 1000);
      if (Number.isFinite(to)) v.currentTime = to;
    } catch {}
  }

  /* ---------------- 7. 크게 보기 UI 숨김 ---------------- */
  // 크게 보기 모드의 작은 창: 영상만 남기고 치지직 플레이어 UI를 숨기되,
  // 음소거/볼륨 버튼과 화질 설정(톱니바퀴) 버튼·설정 창만은 보이게 한다.
  // (visibility는 자식이 visible이면 부모가 hidden이어도 보이므로 해당 요소만 다시 켬)
  // 크게 보기 모드의 작은 창: 치지직 플레이어 화면 요소 중 '플레이어 조작 UI'(아래 조작 막대 전체 +
  // 그 뒤 어두운 그림자 + 설정 창)만 원래 모습 그대로 보이고, 방송 제목·채팅 등 나머지는 숨긴다.
  // (visibility는 자식이 visible이면 부모가 hidden이어도 보이므로 해당 요소만 다시 켬)
  const MINIMAL_KEEP = [
    '.pzp-pc__bottom',
    '.pzp-pc__bottom-shadow',
    '.pzp-pc__settings',
    '.pzp-pc-settings',
    '.pzp-pc-ui-setting-pane',
  ];
  const setMinimal = (on) =>
    on
      ? addStyle(
          'cmv-minimal-ui',
          `[${MARK}] *:not(video):not(:has(video)){visibility:hidden !important;}
          ${MINIMAL_KEEP.map((k) => `[${MARK}] ${k}, [${MARK}] ${k} *`).join(', ')} {
            visibility: visible !important;
          }
          /* 버튼 이름 말풍선(음소거 (m), 설정 등)은 작은 창에서 표시하지 않음 */
          [${MARK}] .pzp-button__tooltip,
          [${MARK}] .pzp-pc-ui-button__tooltip,
          [${MARK}] .pzp-ui-tooltip,
          [${MARK}] [class*="tooltip"] {
            display: none !important;
          }`,
        )
      : removeStyle('cmv-minimal-ui');

  /* ---------------- 8. 멀티뷰에서 오는 신호 ---------------- */
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== EXT_ORIGIN) return;
    const d = e.data;
    if (!d || d.cmv !== 1) return;
    const v = mainVideo();
    switch (d.type) {
      case 'CMV_AUDIO': {
        if (focusMute === null) beforeFocus = { volume: userDesiredVolume, userMuted: userDesiredMuted };
        const want = !!d.muted;
        // 큰 화면/작은 창 역할이 바뀌면 사용자가 바꿔 둔 소리 상태는 초기화
        if (want !== lastFocusInstr) focusUserOverride = null;
        lastFocusInstr = want;
        focusMute = focusUserOverride !== null ? focusUserOverride : want;
        if (v) setMuted(v, focusMute);
        break;
      }
      case 'CMV_AUDIO_RESTORE':
        focusUserOverride = null;
        lastFocusInstr = null;
        if (focusMute === null) break;
        focusMute = null;
        if (v && beforeFocus) applyVolume(v, beforeFocus);
        else if (v) setMuted(v, userDesiredMuted);
        beforeFocus = null;
        break;
      case 'CMV_TOGGLE_MUTE': {
        focusMute = null;
        const nextMute = typeof d.muted === 'boolean' ? d.muted : !userDesiredMuted;
        userDesiredMuted = nextMute;
        wasMutedBeforeAd = nextMute;
        if (v) setMuted(v, nextMute);
        chrome.storage.local
          .set({ [VOL_KEY]: { volume: userDesiredVolume, userMuted: nextMute } })
          .catch(() => {});
        break;
      }
      case 'CMV_UI':
        settleChat(); // 크게 보기 켜고 끌 때 채팅 상태 변화 오인 방지
        setMinimal(!!d.minimal);
        break;
      case 'CMV_FF':
        fastForward(Number.isFinite(d.marginSec) ? d.marginSec : 0.6);
        break;
      case 'CMV_SYNC':
        if (Number.isFinite(d.targetMs)) syncTo(d.targetMs);
        break;
      case 'CMV_SET_LP':
        // 방송 새로고침 없이 통나무 자동 획득 즉시 켜기/끄기
        applyClaimOnState(!!d.on);
        break;
      case 'CMV_CHECK_LP':
        checkLogPower(true);
        break;
    }
  });

  /* ---------------- 9. 통나무 (단일 방 전용 5분·1시간 자동 수집: API v1/v2 + 프록시 + DOM/React 클릭) ---------------- */
  const LP_APIS = [
    `https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`,
    `https://api.chzzk.naver.com/service/v2/channels/${channelId}/log-power`,
  ];
  let lastKnownLpAmount = undefined;

  async function fetchJsonWithFallback(url, init = {}) {
    // 1차: 직접 fetch
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { credentials: 'include', ...init, signal: ctrl.signal });
      if (res.ok) return await res.json();
    } catch {} finally {
      clearTimeout(t);
    }
    // 2차: 백그라운드 서비스 워커 프록시 폴백
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'mv:fetch-api',
        url,
        method: init.method || 'GET',
      });
      if (resp && resp.ok && resp.data) return resp.data;
    } catch {}
    return null;
  }

  function clickLpEl(el) {
    if (!(el instanceof HTMLElement)) return false;
    const now = Date.now();
    const prev = Number(el.dataset.cmvLpClickedAt || '0');
    if (now - prev < 3000) return false;
    el.dataset.cmvLpClickedAt = String(now);
    el.dataset.cmvLpClick = '1';
    try {
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      // MAIN 월드(tile-main.js)에서도 React __reactProps$.onClick을 직접 호출하도록 신호 전달
      window.dispatchEvent(new CustomEvent('__cmv_lp_click'));
      return true;
    } catch {
      return false;
    }
  }

  function tryDomLogClaim() {
    if (!claimOn) return false;
    let clicked = false;
    try {
      // 1차: 명시적 통나무/파워 관련 클래스 및 속성 탐색
      const candidates = document.querySelectorAll(
        '[class*="log_power" i], [class*="logpower" i], [class*="chatting_power" i], [class*="power_toast" i], [class*="power_banner" i], [class*="power_button" i], button[aria-label*="통나무"], button[title*="통나무"]',
      );
      for (const el of candidates) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/받기|획득|수령|claim|배달\s*완료|인증하기/i.test(txt)) continue;
        const innerBtns = el.querySelectorAll('button, [role="button"], a');
        for (const b of innerBtns) {
          if (!b.disabled && clickLpEl(b)) clicked = true;
        }
        if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || /받기|인증하기/.test(txt)) && !el.disabled) {
          if (clickLpEl(el)) clicked = true;
        }
      }

      // 2차: "1시간 시청 통나무 파워 배달 완료! 120 받기" 문구 기반 가장 안쪽(innermost) 요소 정밀 타겟팅
      // '받기'·'인증하기' 글자가 아예 없으면 전체 요소 탐색을 건너뜀 (1.5초마다 도는 검사라 가볍게)
      const hasClaimText = /받기|인증하기/.test((document.body && document.body.textContent) || '');
      for (const el of hasClaimText ? document.querySelectorAll('button, [role="button"], div, span, a') : []) {
        if (insideChat(el)) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 90) continue;

        // 케이스 A: "+120 받기" / "120 받기" / "받기" / "1시간 라이브 시청 후 인증하기" 버튼·요소 자체
        if (/^(\+?\s*\d+\s*)?받기$/.test(txt) || /1시간.*시청.*인증하기/.test(txt)) {
          let anc = el.parentElement;
          let hasLpContext = /인증하기/.test(txt);
          for (let i = 0; i < 4 && anc; i += 1, anc = anc.parentElement) {
            const ancTxt = (anc.textContent || '').replace(/\s+/g, ' ').trim();
            if (ancTxt.length <= 120 && /통나무|파워\s*배달|1시간\s*시청/.test(ancTxt)) {
              hasLpContext = true;
              break;
            }
          }
          if (hasLpContext) {
            const target = el.closest('button, [role="button"]') || el;
            if (clickLpEl(target)) clicked = true;
            if (target !== el && clickLpEl(el)) clicked = true;
            if (el.parentElement && (el.parentElement.textContent || '').trim().length <= 45) {
              clickLpEl(el.parentElement);
            }
          }
        } else if (/1시간\s*시청\s*통나무|통나무\s*파워\s*배달\s*완료/.test(txt) && /받기/.test(txt)) {
          // 케이스 B: 배너 컨테이너 자체인 경우 (상위 외부 래퍼는 건너뛰고 가장 안쪽 배너만 클릭!)
          const hasInnerBanner = [...el.children].some((ch) => {
            const ct = (ch.textContent || '').replace(/\s+/g, ' ').trim();
            return /1시간\s*시청\s*통나무|통나무\s*파워\s*배달\s*완료/.test(ct) && /받기/.test(ct);
          });
          if (hasInnerBanner) continue;

          for (const sub of el.querySelectorAll('button, [role="button"], span, div, a')) {
            const st = (sub.textContent || '').replace(/\s+/g, ' ').trim();
            if (sub.tagName === 'BUTTON' || sub.getAttribute('role') === 'button' || /받기/.test(st)) {
              if (clickLpEl(sub)) clicked = true;
            }
          }
          if (clickLpEl(el)) clicked = true;
        }
      }
    } catch {}
    return clicked;
  }

  async function checkLogPower(force = false) {
    // 여러 방송이 켜져 있을 때 다른 방이 치지직 서버의 통나무 시청 세션을 뺏지 않도록,
    // 최초 1회 잔액 확인(force=true) 이후 주기적 폴링은 통나무 자동 수집을 켠 단 하나의 방(claimOn=true)에서만 수행!
    if (!force && !claimOn) return;

    let body = null;
    let activeApi = LP_APIS[0];
    for (const api of LP_APIS) {
      const res = await fetchJsonWithFallback(api);
      if (res && (res.code === undefined || res.code === 200) && res.content) {
        body = res;
        activeApi = api;
        break;
      }
    }

    if (!body) {
      const domClaimed = claimOn ? tryDomLogClaim() : false;
      toParent({
        type: 'CMV_LP_STATUS',
        ok: domClaimed || typeof lastKnownLpAmount === 'number',
        amount: lastKnownLpAmount,
        claimed: domClaimed,
        at: Date.now(),
      });
      return;
    }

    const c = body.content || {};
    let amount = [c.amount, c.logPower, c.balance, c.totalAmount, c.point].find((x) => typeof x === 'number');
    if (typeof amount === 'number') lastKnownLpAmount = amount;
    let claimed = false;

    const claimList = c.claims || c.availableClaims || c.activeClaims;
    if (claimOn && Array.isArray(claimList) && claimList.length) {
      for (const x of claimList) {
        const claimId = x && (x.claimId || x.id || x.powerClaimId);
        if (!claimId) continue;
        let ok = await fetchJsonWithFallback(`${activeApi}/claims/${encodeURIComponent(claimId)}`, {
          method: 'PUT',
        });
        if (!ok) {
          ok = await fetchJsonWithFallback(`${activeApi}/claims/${encodeURIComponent(claimId)}`, {
            method: 'POST',
          });
        }
        if (ok) claimed = true;
      }
      if (claimed) {
        const again = await fetchJsonWithFallback(activeApi);
        const c2 = (again && again.content) || {};
        const a2 = [c2.amount, c2.logPower, c2.balance, c2.totalAmount, c2.point].find(
          (x) => typeof x === 'number',
        );
        if (typeof a2 === 'number') {
          amount = a2;
          lastKnownLpAmount = a2;
        }
      }
    }
    if (claimOn && !claimed) {
      if (tryDomLogClaim()) {
        claimed = true;
        setTimeout(() => checkLogPower(true), 1200);
      }
    }

    toParent({ type: 'CMV_LP_STATUS', ok: true, amount, claimed, at: Date.now() });
  }
  // 최초 로드 시 1회 통나무 잔액 표시 후, 이후 25초 주기는 통나무 자동 수집이 켜진 방(claimOn)에서만 작동
  setTimeout(() => checkLogPower(true), 3500 + Math.random() * 1500);
  setInterval(() => {
    if (claimOn) checkLogPower(false);
  }, 25 * 1000);
  setInterval(() => {
    if (claimOn && tryDomLogClaim()) {
      setTimeout(() => checkLogPower(true), 1200);
    }
  }, 1500);

  /* ---------------- 9-1. 이 칸의 치지직 로그인 상태 확인 → 멀티뷰 칸 상단에 표시 ----------------
   * 칸(치지직 페이지)이 실제로 보내는 요청과 같은 조건으로 확인해야 하므로 백그라운드 우회 없이 직접 요청한다.
   * 로그인이 풀린 칸에서는 시청이 비로그인으로 잡혀 통나무가 쌓이지 않는다.
   */
  async function checkTileLogin() {
    if (offlinePage) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const body = await res.json();
      const c = (body && body.content) || {};
      if (typeof c.loggedIn !== 'boolean') return;
      toParent({ type: 'CMV_LOGIN', loggedIn: c.loggedIn, nickname: String(c.nickname || '') });
    } catch {
      // 네트워크 오류 등은 '모름'으로 두고 표시를 바꾸지 않음
    } finally {
      clearTimeout(t);
    }
  }
  setTimeout(checkTileLogin, 5000 + Math.random() * 2000);
  setInterval(checkTileLogin, 3 * 60 * 1000);

  /* ---------------- 10. 반복 확인 ---------------- */
  let lastReportedLiveStatus = null;
  function reportLiveStatus(status) {
    if (lastReportedLiveStatus === status) return;
    lastReportedLiveStatus = status;
    toParent({ type: 'CMV_LIVE_STATUS', status });
  }

  function checkOfflinePage() {
    if (offlinePage || !document.body) return;
    const playing = [...document.querySelectorAll('video')].some((v) => !v.paused && v.readyState >= 2 && visible(v));
    if (playing) {
      reportLiveStatus('OPEN');
      return;
    }
    const txt = (document.body.innerText || '').slice(0, 6000);
    if (!/다음 라이브를 기대해주세요|오프라인|방송 준비 중/.test(txt)) return;
    offlinePage = true;
    reportLiveStatus('CLOSE');
    // 숨겨 둔 채팅창 스타일을 풀기 전에 먼저 채팅창 숨김을 걸어 순간적으로 튀어나오는 것 방지
    if (!userChat) {
      addStyle(
        'cmv-offline-chat',
        'aside[class*="live_chatting"], [class*="live_chatting_container"] { display: none !important; }',
      );
    }
    PAGE_STYLES.forEach(removeStyle);
    // 스크롤바는 얇고 흐리게 (눈에 덜 띄게)
    addStyle('cmv-offline-scroll', `
      * { scrollbar-width: auto !important; }
      ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
      ::-webkit-scrollbar-track { background: transparent !important; }
      ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16) !important; border-radius: 3px !important; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3) !important; }
      ::-webkit-scrollbar-corner, ::-webkit-scrollbar-button { display: none !important; background: transparent !important; }
    `);
    document.querySelectorAll(`[${MARK}]`).forEach((el) => el.removeAttribute(MARK));
    stopOfflineVideos();
  }
  setInterval(checkOfflinePage, 2000);

  /* ---------------- 꺼진 방송 페이지: 영상 불러오기 막기 (리소스 절약) ----------------
   * 추천 방송 카드에 마우스를 올리면 미리보기 영상이 재생되고, 일부는 저절로 재생되기도 해서
   * 꺼진 방송 칸이 많으면 무거워진다. 꺼진 방송 페이지에서는
   *  - 마우스를 올려도 미리보기가 시작되지 않게 하고 (치지직이 '마우스 올림'을 못 알아채게)
   *  - 이미 있거나 새로 생기는 영상은 멈추고 불러오기를 끊는다. 썸네일 사진은 그대로 보인다.
   */
  function killVideo(v) {
    if (!(v instanceof HTMLVideoElement) || v.dataset.cmvStopped === '1') return;
    v.dataset.cmvStopped = '1';
    try {
      v.pause();
      v.muted = true;
      v.removeAttribute('src');
      v.querySelectorAll('source').forEach((x) => x.remove());
      if ('srcObject' in v) v.srcObject = null;
      v.load(); // 받던 데이터 끊기
    } catch {}
  }
  function stopOfflineVideos() {
    addStyle('cmv-offline-novideo', 'video { display: none !important; }');
    document.querySelectorAll('video').forEach(killVideo);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLVideoElement) killVideo(n);
          else if (n.querySelectorAll) n.querySelectorAll('video').forEach(killVideo);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    // 재생이 시작되려 하면 바로 멈춤 (src를 다시 넣는 경우 대비)
    document.addEventListener('play', (e) => {
      const v = e.target;
      if (v instanceof HTMLVideoElement) killVideo(v);
    }, true);
    // 마우스 올림을 치지직에 안 알려서 미리보기 자체가 시작 안 되게 (클릭은 그대로 됨)
    const swallow = (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('a[class*="_thumbnail_"], [class*="_thumbnail_"], [class*="_card_"], [class*="preview" i]')) {
        e.stopImmediatePropagation();
      }
    };
    for (const type of ['mouseover', 'mouseenter', 'pointerover', 'pointerenter', 'mousemove', 'pointermove']) {
      window.addEventListener(type, swallow, true);
    }
  }

  setInterval(() => {
    if (offlinePage) {
      keepChatFolded();
      if (userChat) removeStyle('cmv-offline-chat');
      else
        addStyle(
          'cmv-offline-chat',
          'aside[class*="live_chatting"], [class*="live_chatting_container"] { display: none !important; }',
        );
      return;
    }
    markPlayer();
    hookVideo();
    keepWide();
    keepChatFolded();
  }, 900);

  /* ---------------- 11. 시청자 수 및 채널 이름 추출 → 부모에 전달 (API 장애 대비 DOM 폴백) ---------------- */
  let lastViewers = -1;
  let lastName = '';

  function reportMeta() {
    let n = -1;
    const cand = document.querySelector(
      '[class*="video_information_count"], [class*="_count_"], [class*="live_information_count"]',
    );
    if (cand) {
      const m = cand.textContent.replace(/[^0-9]/g, '');
      if (m) n = parseInt(m, 10);
    }
    if (n < 0) {
      for (const el of document.querySelectorAll('[class*="view"], [class*="count"]')) {
        const t = el.textContent || '';
        const m = t.match(/([0-9,]+)\s*명\s*(시청|참여)/);
        if (m) {
          n = parseInt(m[1].replace(/,/g, ''), 10);
          break;
        }
      }
    }
    if (n >= 0 && n !== lastViewers) {
      lastViewers = n;
      toParent({ type: 'CMV_VIEWERS', viewers: n });
    }

    // 채널 이름 DOM 추출 폴백
    if (!lastName) {
      const nameEl = document.querySelector(
        '[class*="video_information_name"], [class*="channel_name"], [class*="streamer_name"]',
      );
      let name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name && document.title) {
        const tm = document.title.match(/^(.+?)\s*[-:·|]\s*치지직/);
        if (tm) name = tm[1].trim();
      }
      if (name) {
        lastName = name;
        toParent({ type: 'CMV_META', name });
      }
    }
  }
  setInterval(reportMeta, 4000);

  /* ---------------- 12. 광고 자동 음소거 + 광고 중 채팅창 상단 본방송 동시 재생(PIP) + 광고 종료 후 음소거 즉시 해제 ---------------- */
  /* 치지직 광고는 네이버 광고 플레이어(data-role="gvAdContainerEl" 안의 .vod_player_wrap)로 나온다.
   * 주의: #preAdVideoContainer 나 [data-role="gvAdContainerEl"] 빈 래퍼가 광고 종료 후에도 DOM에 남아 있을 수 있으므로
   * 반드시 실제 활성 광고 <video>나 가시적인 광고 UI(.ad_info_area / countDownEl)가 있을 때만 광고 중으로 판별한다. */
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
      if (cachedAdMuteSetting && !av.muted) {
        av.muted = true;
      }
    });
    const onAdEnd = () => setTimeout(checkAd, 30);
    av.addEventListener('ended', onAdEnd);
    av.addEventListener('emptied', onAdEnd);
  }

  /**
   * 광고 재생 중(adPlaying === true)일 때:
   *  - 메인 화면(좌측)에는 광고가 재생(음소거)되고
   *  - 우측에는 채팅창과 함께 채팅창 상단에 본방송 화면(PIP)이 위치하여 본방송 영상·소리가 끊기지 않고 재생되도록 레이아웃 전환
   * 광고가 끝나면(adPlaying === false) 즉시 원래 전체화면(100vw x 100vh)으로 복원한다.
   */
  // 광고 플레이어 영역을 칸 전체 크기로 맞춤 (크게 보기 등 칸 크기가 바뀌어도 광고가 작게 남지 않도록).
  // 치지직은 플레이어가 화면 밖으로 스크롤됐다고 판단하면 프리롤 광고를 '.pre_ad_mini'(오른쪽 위 작은 창)로 줄이는데,
  // 멀티뷰 칸에서는 페이지 배치를 바꿔 두어서 이 상태가 잘못 켜지므로 강제로 칸 전체 크기로 되돌린다.
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
      z-index: 2147483647 !important; /* 프리롤 중에는 본방송이 아직 안 나오므로 맨 위 */
      background: #000 !important;
    }
    /* 방송 중간 광고: 숨김(display:none) 상태가 아닐 때만 칸 전체로. 본방송 작은 화면이 위에 오도록 한 단계 아래 */
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

  function syncAdPipLayout(adPlaying) {
    if (offlinePage || !adPlaying) {
      document.querySelectorAll('video[data-cmv-pip-video]').forEach((v) => v.removeAttribute('data-cmv-pip-video'));
      removeStyle('cmv-ad-pip');
      return;
    }

    const lv = mainVideo();
    // 본방송은 MSE(blob:) 스트림이다. 광고 영상(mp4 등 일반 주소)을 본방송으로 잘못 잡아
    // 광고가 작은 미니플레이어로 들어가는 일이 없도록, 광고 영역 밖의 blob:/srcObject 영상만 본방송으로 인정
    const lvSrc = lv ? String(lv.currentSrc || lv.getAttribute('src') || '') : '';
    const hasLiveStream = !!(
      lv &&
      !lv.ended &&
      !lv.paused &&
      lv.readyState >= 2 &&
      !lv.closest(AD_ROOTS) &&
      (lv.srcObject || lvSrc.startsWith('blob:'))
    );
    const nativeInChat = !!(lv && lv.closest('aside[class*="live_chatting"], [class*="live_chatting_container"]'));

    for (const v of document.querySelectorAll('video[data-cmv-pip-video]')) {
      if (v !== lv || nativeInChat || !hasLiveStream) v.removeAttribute('data-cmv-pip-video');
    }
    if (lv && hasLiveStream && !nativeInChat) {
      lv.setAttribute('data-cmv-pip-video', '1');
    }

    // 치지직의 '스크롤 미니 광고'(.pre_ad_mini) 상태를 원래 플레이어 크기로 되돌리는 규칙 (채팅창을 연 경우용)
    const PRE_AD_UNMINI_CSS = `
      #preAdPlayerWrapper.pre_ad_mini, #midAdPlayerWrapper.mid_ad_mini {
        position: absolute !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100% !important;
        height: 100% !important;
      }
    `;

    if (!hasLiveStream && !nativeInChat && userChat) {
      addStyle('cmv-ad-pip', PRE_AD_UNMINI_CSS);
      return;
    }

    const needCustomPip = hasLiveStream && !nativeInChat;

    // 사용자가 채팅창을 직접 열지 않았다면 광고 중에도 채팅창을 펼치지 않는다.
    // 광고는 칸 전체에 그대로 두고, 본방송은 우측 상단 작은 미니플레이어로만 띄운다.
    if (!userChat) {
      const adFillCss = AD_FILL_CSS;
      if (!needCustomPip) {
        addStyle('cmv-ad-pip', adFillCss);
        return;
      }
      // 광고 영역이 플레이어 묶음([MARK]) 밖에 있으면, 플레이어 묶음이 별도 층(stacking context)이 되어
      // 미니플레이어가 광고 아래에 깔리므로 광고 중에는 플레이어 묶음의 층을 풀어 준다
      const root = document.querySelector(`[${MARK}]`);
      const adC = document.querySelector(
        '#midAdPlayerWrapper, #preAdPlayerWrapper, #preAdVideoContainer, [data-role="gvAdContainerEl"]',
      );
      const adOutsideRoot = !!(root && adC && !root.contains(adC));
      addStyle(
        'cmv-ad-pip',
        `
          ${adFillCss}
          ${adOutsideRoot ? `[${MARK}] { position: static !important; z-index: auto !important; }` : ''}
          :root {
            --cmv-ad-pip-w: clamp(140px, 30vw, 300px);
          }
          *:has(video[data-cmv-pip-video="1"]) {
            transform: none !important;
            perspective: none !important;
            filter: none !important;
            contain: none !important;
            clip-path: none !important;
            overflow: visible !important;
          }
          video[data-cmv-pip-video="1"] {
            position: fixed !important;
            top: 28px !important;
            right: 0 !important;
            left: auto !important;
            bottom: auto !important;
            width: var(--cmv-ad-pip-w) !important;
            height: calc(var(--cmv-ad-pip-w) * 9 / 16) !important;
            max-width: var(--cmv-ad-pip-w) !important;
            max-height: calc(var(--cmv-ad-pip-w) * 9 / 16) !important;
            z-index: 2147483647 !important;
            background: #000 !important;
            object-fit: contain !important;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.65) !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
          }
        `,
      );
      return;
    }

    addStyle(
      'cmv-ad-pip',
      `
        ${PRE_AD_UNMINI_CSS}
        :root {
          --cmv-ad-chat-w: clamp(180px, 32vw, 320px);
        }
        [${MARK}] {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          right: auto !important;
          bottom: 0 !important;
          width: calc(100vw - var(--cmv-ad-chat-w)) !important;
          height: 100vh !important;
          z-index: 2147483645 !important;
          background: #000 !important;
        }
        #preAdVideoContainer, [data-role="gvAdContainerEl"], .vod_player_wrap {
          max-width: calc(100vw - var(--cmv-ad-chat-w)) !important;
          overflow: hidden !important;
        }
        aside[class*="live_chatting"], [class*="live_chatting_container"] {
          display: flex !important;
          flex-direction: column !important;
          position: fixed !important;
          top: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          left: auto !important;
          width: var(--cmv-ad-chat-w) !important;
          min-width: 0 !important;
          max-width: var(--cmv-ad-chat-w) !important;
          height: 100vh !important;
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
          z-index: 2147483646 !important;
          padding-top: ${needCustomPip ? 'calc(var(--cmv-ad-chat-w) * 9 / 16 + 28px)' : '28px'} !important;
          box-sizing: border-box !important;
          background: #141517 !important;
          border-left: 1px solid rgba(255, 255, 255, 0.08) !important;
        }
        aside[class*="live_chatting"] video, [class*="live_chatting_container"] video {
          width: 100% !important;
          height: auto !important;
          aspect-ratio: 16 / 9 !important;
          object-fit: contain !important;
          background: #000 !important;
        }
        *:has(video[data-cmv-pip-video="1"]) {
          transform: none !important;
          perspective: none !important;
          filter: none !important;
          contain: none !important;
          clip-path: none !important;
          overflow: visible !important;
        }
        video[data-cmv-pip-video="1"] {
          position: fixed !important;
          top: 28px !important;
          right: 0 !important;
          left: auto !important;
          bottom: auto !important;
          width: var(--cmv-ad-chat-w) !important;
          height: calc(var(--cmv-ad-chat-w) * 9 / 16) !important;
          max-width: var(--cmv-ad-chat-w) !important;
          max-height: calc(var(--cmv-ad-chat-w) * 9 / 16) !important;
          z-index: 2147483647 !important;
          background: #000 !important;
          object-fit: contain !important;
          border-bottom: 1px solid rgba(255, 255, 255, 0.16) !important;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.65) !important;
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          pointer-events: auto !important;
        }
      `,
    );
  }

  let lastSkipClick = 0;
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

  let adStallSince = 0;
  let lastLiveKickAt = 0;
  let lastAutoplayRetryAt = 0;

  /**
   * 1) 처음 방송을 켰을 때 프리롤 광고가 자동재생 정책에 막혀 멈춰 있거나 무한 대기하는 현상 자동 복구
   * 2) 광고 도중에도 본방송 비디오(채팅창 상단 미니플레이어)가 멈추지 않고 재생·소리 출력 유지
   * 3) 광고가 없는데도 본방송 플레이어가 일시정지 상태로 멈춰 있는 현상 자동 재생
   */
  function ensurePlaybackProgress(adPlaying) {
    if (offlinePage) return;

    if (adPlaying) {
      const avs = activeAdVideos();
      let anyPlaying = false;
      for (const av of avs) {
        hookAdVideo(av);
        if (!av.paused && av.currentTime > 0) {
          anyPlaying = true;
          continue;
        }
        // 프리롤 광고가 크롬 비음소거 자동재생 정책에 걸려 멈추지 않도록 즉시 재생 시도 (막히면 음소거 후 재생)
        if (av.paused && !av.ended) {
          if (cachedAdMuteSetting) {
            av.muted = true;
          }
          av.play().catch(() => {
            av.muted = true;
            av.play().catch(() => {});
          });
        }
      }

      // 광고가 재생되는 동안에도 채팅창 상단 본방송(lv)이 멈추지 않고 계속 재생되도록 보장
      const lv = mainVideo();
      if (lv && anyPlaying && lv.paused && !lv.ended && (lv.currentSrc || lv.getAttribute('src') || lv.srcObject)) {
        lv.play().catch(() => {});
      }

      if (anyPlaying) {
        adStallSince = 0;
      } else {
        if (!adStallSince) adStallSince = Date.now();
        const stalledMs = Date.now() - adStallSince;

        // (예전에는 1.2초 이상 멈추면 광고 영역 안의 '재생' 비슷한 요소를 마구 눌렀는데,
        //  광고 시스템이 정상 표시가 아닌 것으로 볼 수 있어 제거함)

        // 주의: 예전에는 5.5초 이상 멈추면 광고 '끝남/오류' 신호를 가짜로 보내고 광고 영역을 숨겨 넘겼는데,
        // 이렇게 하면 치지직 서버가 광고를 정상 시청하지 않은 것으로 보고 '광고 차단 프로그램을 사용 중이신가요?' 창을 띄우며
        // 방송을 열어주지 않는다. 그래서 광고는 재생(음소거 재생)만 도와주고 강제로 끝내지 않는다.
      }
      return;
    }

    adStallSince = 0;

    // 광고 중이 아닐 때: 본방송 영상이 처음 로드 시 자동재생 차단 등으로 멈춰 있으면 자동 재생
    const lv = mainVideo();
    if (!lv) return;
    if (lv.paused && !lv.ended && Date.now() - lastUserInput > 2500 && Date.now() - lastLiveKickAt > 1200) {
      lastLiveKickAt = Date.now();
      lv.play().catch((err) => {
        if (!err || err.name === 'NotAllowedError') {
          ignoreVolumeUntil = Date.now() + 1500;
          lv.muted = true;
          lastProgrammaticMuteAt = Date.now();
          lastKnownMuted = true;
          pendingAutoplayUnmute = true;
          lv.play().catch(() => {});
        }
      });
      const pzpPlayBtn = document.querySelector(
        '.pzp-pc__playback-switch[aria-label*="재생"], button[aria-label="재생"]',
      );
      if (pzpPlayBtn && visible(pzpPlayBtn) && lv.readyState >= 2) {
        try { pzpPlayBtn.click(); } catch {}
      }
    }
  }

  /** 본방송 비디오(lv)의 음소거 해제 및 볼륨을 사용자/포커스 설정에 맞게 강제 동기화 */
  function enforceLiveAudioState() {
    const lv = mainVideo();
    if (!lv) return;
    const targetMuted = shouldMuteLive();
    if (pendingAutoplayUnmute && !targetMuted && Date.now() - lastAutoplayRetryAt > 2000) {
      lastAutoplayRetryAt = Date.now();
      tryUnmutePendingAutoplay();
      return;
    }
    if (!targetMuted && !pendingAutoplayUnmute) {
      const wantVol = typeof userDesiredVolume === 'number' && userDesiredVolume > 0 ? userDesiredVolume : 0.5;
      if (lv.volume === 0) {
        ignoreVolumeUntil = Date.now() + 1000;
        lv.volume = wantVol;
      }
      if (lv.muted) {
        ignoreVolumeUntil = Date.now() + 1000;
        lv.muted = false;
        lastProgrammaticMuteAt = Date.now();
        lastKnownMuted = false;
      }
      clickUnmuteButtonIfNeeded();
      if (lv.muted) {
        lv.muted = false;
        lastProgrammaticMuteAt = Date.now();
        lastKnownMuted = false;
      }
    } else if (targetMuted && !lv.muted) {
      ignoreVolumeUntil = Date.now() + 1000;
      lv.muted = true;
      lastProgrammaticMuteAt = Date.now();
      lastKnownMuted = true;
    }
    reportAudioState(lv);
  }

  /** 광고가 끝나고 본방송으로 돌아왔을 때 원래 소리 상태를 다중 타이밍으로 확실하게 복원 */
  function restoreAudioAfterAd() {
    if (offlinePage || isAdPlaying() || adActive || adMuted) return;
    const lv = mainVideo();
    if (!lv) return;
    const targetMuted = shouldMuteLive();
    ignoreVolumeUntil = Date.now() + 1800;
    if (typeof userDesiredVolume === 'number' && userDesiredVolume > 0) {
      lv.volume = userDesiredVolume;
    } else if (!targetMuted && lv.volume === 0) {
      lv.volume = 0.5;
    }
    setMuted(lv, targetMuted);
    if (!targetMuted && !pendingAutoplayUnmute) {
      clickUnmuteButtonIfNeeded();
      lv.muted = false;
    }
    reportAudioState(lv);
  }

  function scheduleRestoreAudioAfterAd() {
    restoreAudioAfterAd();
    for (const delay of [120, 300, 650, 1200, 2200, 3500, 5000]) {
      setTimeout(restoreAudioAfterAd, delay);
    }
  }

  function checkAd() {
    if (offlinePage) return; // 꺼진 방송 페이지엔 광고 없음
    const adPlaying = isAdPlaying();

    syncAdPipLayout(adPlaying);
    ensurePlaybackProgress(adPlaying);

    if (adPlaying) {
      if (!adActive) {
        wasMutedBeforeAd = shouldMuteLive();
        adActive = true;
      }
      if (cachedAdMuteSetting) {
        if (!adMuted) {
          adMuted = true;
          toParent({ type: 'CMV_AD_STATUS', ad: true });
        }
        // 오직 광고 <video>(adVideos)만 음소거하고, 채팅창 상단 본방송 <video>(mainVideo)는 음소거하지 않고 소리 유지!
        for (const av of adVideos()) {
          hookAdVideo(av);
          if (!av.muted) av.muted = true;
        }
      }
      // 광고 도중에도 본방송 비디오가 존재하면 본방송 소리가 꺼지지 않도록 유지
      enforceLiveAudioState();
      tryClickSkipButton();
    } else if (adActive || adMuted) {
      adActive = false;
      adMuted = false;
      lastAdEndedAt = Date.now();
      toParent({ type: 'CMV_AD_STATUS', ad: false });
      scheduleRestoreAudioAfterAd();
    } else {
      // 평상시에도 광고 종료 여파 등으로 본방송 음소거가 남아 있으면 즉시 해제 보장
      enforceLiveAudioState();
    }
  }

  setInterval(checkAd, 350);
})();

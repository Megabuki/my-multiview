/**
 * My MultiView - 치지직 채팅 커스텀, 관리자 채팅 모아보기, 블라인드(클린봇·관리자) 복원, 1시간 시청 통나무 자동 수령 스크립트
 *
 *  - 멀티뷰 채팅 패널(/live/{id}/chat) 및 타일 내 채팅창(/live/{id}) 모두 지원
 *  - 1시간 시청 통나무 파워 배달 완료! 배너 감지 시 즉시 자동 클릭 + API 수령 폴백
 *  - 클린봇 및 관리자가 블라인드 처리한 댓글 원문 복원 표시 (WebSocket + React Fiber + DOM 3중 캐시)
 *  - 채팅창 상단 '채팅' 글씨 왼쪽에 [👑 관리자] 온오프 토글 버튼 및 상단 플로팅 팝업 표시
 *  - 채팅 타임스탬프 실시간 토글, 채팅 크기, 치즈·구독·블라인드·랭킹·미션·승부예측·후원 숨기기
 *  - 특정 유저 채팅 고정, 채팅 저장소 문구 자동 입력, 로그인 풀림 자동 복구
 */
(() => {
  if (window.top === window) return;

  const STYLE_ID = 'cmv-chat-custom';
  const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  const anc = location.ancestorOrigins;
  const inMultiview = !!(anc && anc.length && anc[0] === EXT_ORIGIN);
  const urlParams = new URLSearchParams(location.search);
  const isChatOnlyFallback = urlParams.get('cmv_chat_only') === '1';
  const isStandaloneChat = /\/live\/[^/]+\/chat/i.test(location.pathname);

  const K = {
    chatTime: 'my-multiview:chatTime',
    fontSize: 'my-multiview:chatFontSize',
    hideCheese: 'my-multiview:chatHideCheese',
    hideSub: 'my-multiview:chatHideSub',
    hideBlind: 'my-multiview:chatHideBlind',
    hideRank: 'my-multiview:chatHideRank',
    hideMission: 'my-multiview:chatHideMission',
    hidePredict: 'my-multiview:chatHidePredict',
    hideDonation: 'my-multiview:chatHideDonation',
    hideBadge: 'my-multiview:chatHideBadge',
    colorMode: 'my-multiview:chatColorMode',
    nickColor: 'my-multiview:chatNickColor',
    bodyColor: 'my-multiview:chatBodyColor',
    pinUsers: 'my-multiview:chatPinUsers',
    restoreBlind: 'my-multiview:chatRestoreBlind',
    autoLp: 'my-multiview:autoLp',
  };

  const num = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };

  let S = {
    chatTime: urlParams.get('ts') === '1',
    fontSize: 14,
    hideCheese: false,
    hideSub: false,
    hideBlind: false,
    hideRank: false,
    hideMission: false,
    hidePredict: false,
    hideDonation: false,
    hideBadge: false,
    colorMode: 'default',
    nickColor: '#2dd4bf',
    bodyColor: '#dbe2f1',
    pinUsers: [],
    restoreBlind: true, // 기본 켬: 클린봇·관리자 블라인드 댓글 표시
    autoLp: true,       // 기본 켬: 1시간 시청 통나무 파워 자동 받기
  };

  function readSettings(obj) {
    const s = (obj && obj['my-multiview:settings']) || {};
    S = {
      chatTime: s[K.chatTime] !== undefined ? s[K.chatTime] === '1' : urlParams.get('ts') === '1',
      fontSize: Math.min(24, Math.max(10, num(s[K.fontSize], 14))),
      hideCheese: s[K.hideCheese] === '1',
      hideSub: s[K.hideSub] === '1',
      hideBlind: s[K.hideBlind] === '1',
      hideRank: s[K.hideRank] === '1',
      hideMission: s[K.hideMission] === '1',
      hidePredict: s[K.hidePredict] === '1',
      hideDonation: s[K.hideDonation] === '1',
      hideBadge: s[K.hideBadge] === '1',
      colorMode: s[K.colorMode] === 'custom' ? 'custom' : 'default',
      nickColor: s[K.nickColor] || '#2dd4bf',
      bodyColor: s[K.bodyColor] || '#dbe2f1',
      pinUsers: (() => {
        try {
          const v = JSON.parse(s[K.pinUsers] || '[]');
          return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
        } catch {
          return [];
        }
      })(),
      restoreBlind: s[K.restoreBlind] !== '0',
      autoLp: s[K.autoLp] !== '0',
    };
  }

  /* ---------------- 다중 폴백 DOM 셀렉터 ---------------- */
  const ROW = [
    '[class*="live_chatting_list_item__"]',
    '[class*="chatting_list_item"]',
    '[class*="chat_item"]',
    '[data-chat-message]',
  ].join(',');

  const NICK = [
    '[class*="live_chatting_username_nickname"]',
    '[class*="live_chatting_message_nickname"]',
    '[class*="username_nickname"]',
    '[class*="nickname"]',
  ].join(',');

  // 주의: [class*="chatting_message"]는 상위 컨테이너(live_chatting_message_container)를 잡으므로 제외!
  const TEXT_SEL = [
    '[class*="live_chatting_message_text"]',
    '[class*="chatting_message_text"]',
    '[class*="message_text"]',
  ].join(',');

  const BLIND_EL_SEL = [
    '[class*="live_chatting_message_blind"]',
    '[class*="chatting_message_blind"]',
    '[class*="message_blind"]',
    '[class*="blind_text"]',
    '[class*="cleanbot"]',
  ].join(',');

  const BADGE = [
    '[class*="live_chatting_badge"]',
    '[class*="live_chatting_username_icon"]',
    '[class*="chat_badge"]',
    'img[class*="badge"]',
    'span[class*="badge"]',
  ].join(',');

  const BLIND_TEXT_RE =
    /클린봇이\s*부적절한|클린봇이\s*숨긴|클린봇이\s*감지|클린봇에\s*의해|부적절한\s*표현을\s*감지|메시지가\s*블라인드\s*처리|블라인드\s*처리되었습니다|관리자에\s*의해\s*블라인드|스트리머에\s*의해\s*블라인드|블라인드\s*처리된\s*메시지|숨겨진\s*메시지입니다|차단된\s*사용자의\s*메시지/;

  function buildCss() {
    const css = [];
    if (inMultiview && isStandaloneChat) {
      css.push(
        'html,body{overflow:hidden !important;min-width:0 !important;max-width:100vw !important;background:#0b0e14 !important;}',
        '::-webkit-scrollbar{width:0 !important;height:0 !important;}',
        '*{scrollbar-width:none !important;}',
      );
    }
    if (isChatOnlyFallback) {
      css.push(
        'header,nav,[class*="header_container"],[class*="navigation"],[class*="live_information"],[class*="player_layout"],video{display:none !important;}',
        'aside[class*="live_chatting"],[class*="live_chatting_container"]{position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;max-width:none !important;z-index:2147483647 !important;display:flex !important;}',
      );
    }
    if (S.chatTime) {
      css.push(
        '[data-cmv-time]::before{content:attr(data-cmv-time);color:var(--color-content-04,#8b95ad);margin-right:5px;font-size:0.9em;font-variant-numeric:tabular-nums;}',
      );
    }
    if (S.fontSize !== 14) {
      css.push(`${ROW},${TEXT_SEL}{font-size:${S.fontSize}px !important;line-height:1.45 !important;}`);
    }
    if (S.hideCheese) {
      css.push(
        '[class*="cheese" i],[class*="donation" i],[class*="live_chatting_list_item"]:has([class*="donation" i]),[class*="live_chatting_list_item"]:has([class*="cheese" i]){display:none !important;}',
      );
    }
    if (S.hideSub) {
      css.push(
        '[class*="subscribe" i],[class*="subscription" i],[class*="live_chatting_list_item"]:has([class*="subscribe" i]){display:none !important;}',
      );
    }
    // 블라인드 댓글 숨기기는 '블라인드 원문 복원'이 꺼져 있을 때만 숨김
    if (S.hideBlind && !S.restoreBlind) {
      css.push(
        '[class*="blind" i],[class*="live_chatting_list_item"]:has([class*="blind" i]){display:none !important;}',
      );
    }
    if (S.hideRank) {
      css.push('[class*="ranking" i],[class*="live_chatting_ranking" i]{display:none !important;}');
    }
    if (S.hideMission) {
      css.push(
        '[class*="mission" i],[class*="live_chatting_fixed_mission" i],[class*="live_chatting_list_item"]:has([class*="mission" i]){display:none !important;}',
      );
    }
    if (S.hidePredict) {
      css.push(
        '[class*="prediction" i],[class*="betting" i],[class*="poll" i],[class*="live_chatting_list_item"]:has([class*="prediction" i]){display:none !important;}',
      );
    }
    if (S.hideDonation) {
      css.push(
        '[class*="sponsor" i],[class*="support" i],[class*="donation" i],[class*="live_chatting_donation" i],[class*="live_chatting_list_item"]:has([class*="donation" i]){display:none !important;}',
      );
    }
    if (S.hideBadge) {
      css.push(`${BADGE}{display:none !important;}`);
    }
    if (S.colorMode === 'custom') {
      css.push(`${NICK},${NICK} *{color:${S.nickColor} !important;}`);
      css.push(`${TEXT_SEL}{color:${S.bodyColor} !important;}`);
    }

    // 블라인드 복원 스타일 및 관리자 채팅 모아보기 버튼/팝업 스타일
    css.push(`
      [data-cmv-blind-hidden="1"] { display: none !important; }
      .cmv-restored-blind {
        color: #fbbf24 !important;
        font-style: normal !important;
        opacity: 1 !important;
      }
      .cmv-blind-tag {
        display: inline-block;
        padding: 0 5px;
        margin-right: 4px;
        border-radius: 4px;
        font-size: 10.5px;
        font-weight: 700;
        vertical-align: baseline;
      }
      .cmv-blind-tag.cleanbot {
        background: rgba(56, 189, 248, 0.18);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
      }
      .cmv-blind-tag.manager {
        background: rgba(251, 191, 36, 0.18);
        color: #fbbf24;
        border: 1px solid rgba(251, 191, 36, 0.35);
      }
      #cmv-mgr-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin-right: 6px;
        padding: 2px 7px;
        border: 1px solid #2b3550;
        border-radius: 6px;
        background: #151b28;
        color: #dbe2f1;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.3;
        cursor: pointer;
        vertical-align: middle;
        user-select: none;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      #cmv-mgr-btn:hover {
        border-color: #2dd4bf;
        color: #2dd4bf;
      }
      #cmv-mgr-btn.on {
        background: rgba(45, 212, 191, 0.18);
        border-color: #2dd4bf;
        color: #2dd4bf;
      }
      #cmv-mgr-btn .cmv-mgr-cnt {
        padding: 0 4px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.1);
        font-size: 10px;
      }
      #cmv-fallback-chat-header {
        position: sticky;
        top: 0;
        z-index: 1500;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 7px 10px;
        background: #141517;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        color: #dfe2ea;
        font-size: 13px;
        font-weight: 700;
        flex: none;
      }
      #cmv-mgr-popup {
        position: absolute;
        top: 40px;
        left: 6px;
        right: 6px;
        z-index: 2147483640;
        display: none;
        flex-direction: column;
        max-height: 280px;
        border: 1px solid #2b3550;
        border-radius: 8px;
        background: rgba(15, 19, 28, 0.96);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(8px);
        color: #dbe2f1;
        font-size: var(--mgr-fs, 13px);
        overflow: hidden;
      }
      #cmv-mgr-popup.open {
        display: flex;
      }
      .cmv-mgr-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        background: #151b28;
        border-bottom: 1px solid #232c40;
        font-size: 11px;
        font-weight: 700;
        color: #2dd4bf;
      }
      .cmv-mgr-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        background: rgba(21, 27, 40, 0.85);
        border-bottom: 1px solid #232c40;
        font-size: 11px;
        color: #8b95ad;
      }
      .cmv-mgr-filters {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .cmv-mgr-filters label {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        cursor: pointer;
        user-select: none;
      }
      .cmv-mgr-fs-ctrl {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cmv-mgr-fs-btn {
        background: none;
        border: 1px solid #2b3550;
        border-radius: 4px;
        color: #dbe2f1;
        font-size: 10px;
        padding: 1px 5px;
        cursor: pointer;
      }
      .cmv-mgr-fs-btn:hover { border-color: #2dd4bf; color: #2dd4bf; }
      .cmv-mgr-actions {
        display: flex;
        gap: 6px;
      }
      .cmv-mgr-actions button {
        background: none;
        border: none;
        color: #8b95ad;
        font-size: 11px;
        cursor: pointer;
        padding: 0 3px;
      }
      .cmv-mgr-actions button:hover {
        color: #dbe2f1;
      }
      #cmv-mgr-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 200px;
      }
      .cmv-mgr-empty {
        padding: 12px 6px;
        text-align: center;
        color: #8b95ad;
        font-size: 11px;
      }
      .cmv-mgr-item {
        padding: 4px 6px;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.04);
        line-height: 1.4;
        word-break: break-word;
        font-size: var(--mgr-fs, 13px);
      }
      .cmv-mgr-item.streamer {
        border-left: 2px solid #ff7abf;
      }
      .cmv-mgr-item.manager {
        border-left: 2px solid #60a5fa;
      }
      .cmv-mgr-item.bot {
        border-left: 2px solid #a78bfa;
      }
      .cmv-mgr-tag {
        display: inline-block;
        padding: 0 5px;
        margin-right: 4px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
      }
      .cmv-mgr-tag.streamer {
        background: rgba(255, 122, 191, 0.18);
        color: #ff7abf;
      }
      .cmv-mgr-tag.manager {
        background: rgba(96, 165, 250, 0.18);
        color: #7db4fb;
      }
      .cmv-mgr-tag.bot {
        background: rgba(167, 139, 250, 0.18);
        color: #c4b5fd;
      }
      .cmv-mgr-nick {
        font-weight: 700;
        margin-right: 5px;
      }
      .cmv-mgr-time {
        float: right;
        color: #8b95ad;
        font-size: 10px;
        margin-left: 6px;
      }
      /* 일반 치지직 웹사이트용 플로팅 채팅 저장소 팝업 */
      #cmv-direct-storage-pop {
        position: absolute;
        bottom: 50px;
        right: 12px;
        width: 260px;
        max-height: 320px;
        z-index: 2147483640;
        display: none;
        flex-direction: column;
        border: 1px solid #2b3550;
        border-radius: 10px;
        background: rgba(15, 19, 28, 0.97);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(8px);
        color: #dbe2f1;
        font-size: 12px;
        overflow: hidden;
      }
      #cmv-direct-storage-pop.open { display: flex; }
      .cmv-dsp-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        background: #151b28;
        border-bottom: 1px solid #232c40;
        font-weight: 700;
        color: #2dd4bf;
      }
      .cmv-dsp-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 210px;
      }
      .cmv-dsp-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.04);
        cursor: pointer;
        line-height: 1.35;
        word-break: break-word;
      }
      .cmv-dsp-item:hover {
        background: rgba(45, 212, 191, 0.12);
        color: #2dd4bf;
      }
      .cmv-dsp-del {
        background: none;
        border: none;
        color: #8b95ad;
        font-size: 11px;
        cursor: pointer;
        padding: 0 4px;
        border-radius: 4px;
      }
      .cmv-dsp-del:hover { background: rgba(248, 113, 113, 0.2); color: #f87171; }
      .cmv-dsp-form {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        border-top: 1px solid #232c40;
        background: #151b28;
      }
      .cmv-dsp-input {
        flex: 1;
        min-width: 0;
        height: 26px;
        padding: 0 6px;
        border: 1px solid #2b3550;
        border-radius: 4px;
        background: #0b0e14;
        color: #dbe2f1;
        font-size: 11.5px;
        outline: none;
      }
      .cmv-dsp-input:focus { border-color: #2dd4bf; }
      .cmv-dsp-add {
        height: 26px;
        padding: 0 8px;
        border: 0;
        border-radius: 4px;
        background: #2dd4bf;
        color: #06201c;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .cmv-dsp-empty {
        padding: 14px 8px;
        text-align: center;
        color: #8b95ad;
        font-size: 11px;
      }
    `);

    return css.join('\n');
  }

  function applyCss() {
    // 블라인드 원문 보이기 켜짐/꺼짐을 페이지 쪽(blind-main.js)에 알려줌
    document.documentElement.dataset.cmvRestoreBlind = S.restoreBlind ? '1' : '0';
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = buildCss();
  }

  /* ---------------- 도우미 함수 ---------------- */
  function channelIdFromUrl() {
    const m = location.pathname.match(/\/live\/([0-9a-f]{32})/i);
    return m ? m[1].toLowerCase() : '';
  }

  function nickOf(row) {
    const n = row.querySelector(NICK);
    return n ? n.textContent.trim() : '';
  }

  /** 닉네임·배지 컨테이너를 제외한 순수 댓글 본문(또는 블라인드 문구) 요소만 반환 */
  function findMessageBodyEl(row) {
    const t = row.querySelector(TEXT_SEL);
    if (t && !t.querySelector(NICK)) return t;

    const b = row.querySelector(BLIND_EL_SEL);
    if (b && !b.querySelector(NICK)) return b;

    const msgContainer =
      row.querySelector('[class*="live_chatting_message_container"]') ||
      row.querySelector('[class*="chatting_message_container"]') ||
      row;
    for (const child of msgContainer.children) {
      if (
        child.matches(NICK) ||
        child.querySelector(NICK) ||
        child.matches('[class*="username" i], [class*="badge" i], button')
      ) {
        continue;
      }
      return child;
    }
    return t || b || null;
  }

  function textOf(row) {
    const t = findMessageBodyEl(row);
    if (!t) return '';
    const clone = t.cloneNode(true);
    clone.querySelectorAll('.cmv-blind-tag').forEach((tag) => tag.remove());
    clone.querySelectorAll('img').forEach((img) => {
      const alt = img.getAttribute('alt') || '이모티콘';
      img.replaceWith(document.createTextNode(` ${alt} `));
    });
    return clone.textContent.trim();
  }

  function findChatRoot() {
    return (
      document.querySelector('aside[class*="live_chatting"]') ||
      document.querySelector('[class*="live_chatting_container"]') ||
      (isStandaloneChat ? document.body : null)
    );
  }

  function findChatList() {
    return (
      document.querySelector('[class*="live_chatting_list_wrapper"]') ||
      document.querySelector('[class*="live_chatting_list"]') ||
      document.querySelector('[class*="chatting_list"]')
    );
  }

  /* ---------------- 1. 관리자 · 봇 채팅 모아보기 창 & '채팅' 글씨 왼쪽 버튼 ---------------- */
  const mgrChats = [];
  const MGR_MAX = 500;
  const MGR_STORE_KEY = 'my-multiview:mgrChats';
  const MGR_ROLES_KEY = 'my-multiview:mgrRoles';
  const MGR_FS_KEY = 'my-multiview:mgrFontSize';

  let mgrRoles = new Set(['manager', 'streamer']);
  let mgrFontSize = 13;
  let mgrPopupOpen = false;
  let mgrStorageTimer = 0;

  function loadStoredMgrSettings() {
    try {
      chrome.storage.local.get([MGR_ROLES_KEY, MGR_FS_KEY, MGR_STORE_KEY]).then((o) => {
        if (!o) return;
        if (Array.isArray(o[MGR_ROLES_KEY])) {
          mgrRoles = new Set(o[MGR_ROLES_KEY].filter((r) => r !== 'bot'));
        }
        if (typeof o[MGR_FS_KEY] === 'number') {
          mgrFontSize = Math.min(20, Math.max(10, o[MGR_FS_KEY]));
        }
        const cid = channelIdFromUrl();
        const stored = (o[MGR_STORE_KEY] && cid && o[MGR_STORE_KEY][cid]) || [];
        if (Array.isArray(stored) && stored.length) {
          for (const item of stored) {
            if (!mgrChats.some((x) => x.nick === item.nick && x.text === item.text && Math.abs(x.at - item.at) < 2000)) {
              mgrChats.push(item);
            }
          }
          while (mgrChats.length > MGR_MAX) mgrChats.shift();
          updateMgrCount();
          if (mgrPopupOpen) renderMgrPopupList();
        }
      }).catch(() => {});
    } catch {}
  }
  loadStoredMgrSettings();

  function saveStoredMgrChats() {
    clearTimeout(mgrStorageTimer);
    mgrStorageTimer = setTimeout(() => {
      const cid = channelIdFromUrl();
      if (!cid) return;
      chrome.storage.local.get(MGR_STORE_KEY).then((o) => {
        const obj = (o && o[MGR_STORE_KEY]) || {};
        obj[cid] = mgrChats.slice(-MGR_MAX);
        chrome.storage.local.set({ [MGR_STORE_KEY]: obj }).catch(() => {});
      }).catch(() => {});
    }, 1500);
  }

  function recordMgrChatItem(item) {
    if (!item || !item.nick || !item.text) return;
    const isDup = mgrChats.some((x) => x.nick === item.nick && x.text === item.text && Math.abs(x.at - item.at) < 2000);
    if (isDup) return;
    mgrChats.push(item);
    while (mgrChats.length > MGR_MAX) mgrChats.shift();
    updateMgrCount();
    saveStoredMgrChats();
    const listEl = document.getElementById('cmv-mgr-list');
    if (mgrPopupOpen && listEl && mgrRoles.has(item.role === 'bot' ? 'manager' : item.role)) {
      appendMgrItemDOM(listEl, item);
    }
  }

  // blind-main.js가 실시간 감지한 관리자/스트리머 채팅 이벤트 수신 (일반 치지직 탭 대응)
  window.addEventListener('__cmv_role_chat', (e) => {
    const d = e.detail;
    if (!d || !d.channelId) return;
    const cid = channelIdFromUrl();
    if (d.channelId !== cid) return;
    const now = new Date(d.at || Date.now());
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    recordMgrChatItem({
      role: d.role === 'bot' ? 'manager' : d.role,
      nick: d.nick,
      text: d.text,
      time: timeStr,
      at: d.at || Date.now(),
      color: d.color || '',
    });
  });

  const BOT_NICK_RE =
    /(?:^|\s|[_\-[\]()])(나이트\s*봇|night\s*bot|치지직\s*봇|chzzk\s*bot|안내\s*봇|공지\s*봇|명령어\s*봇|노래\s*봇|음악\s*봇|타이머\s*봇|스트리머\s*봇|클린\s*봇|삐부\s*봇|익명\s*봇|마법소녀\s*봇|시스템\s*봇|매니저\s*봇|챗봇|chatbot|moobot|streamelements|streamlabs|fossabot|wizebot)(?:$|\s|[_\-[\]()])|(?:봇|bot)$/i;

  function isVisuallyRenderedHeaderTitle(el) {
    if (!(el instanceof HTMLElement)) return false;
    // 네이버/치지직 스크린리더 전용 숨김 요소(.blind)는 절대 매칭하지 않음!
    if (el.classList.contains('blind') || /\bblind\b/i.test(typeof el.className === 'string' ? el.className : '')) {
      return false;
    }
    if (el.closest('.blind, button, [role="button"], a, [class*="input" i], [class*="footer" i], [class*="bottom" i]')) {
      return false;
    }
    try {
      const cs = getComputedStyle(el);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        cs.opacity === '0' ||
        cs.clip === 'rect(0px, 0px, 0px, 0px)' ||
        cs.clipPath === 'inset(50%)' ||
        cs.width === '1px' ||
        cs.height === '1px'
      ) {
        return false;
      }
      const r = el.getBoundingClientRect();
      // 미리 불러온 숨김 iframe(display: none)이 아닌 실제 렌더링 상태일 때만 좌표/크기 검증
      if (window.innerWidth > 20 && window.innerHeight > 20 && (r.width > 0 || r.height > 0)) {
        if (r.width < 10 || r.height < 6) return false;
        if (r.top < 0 || r.top > 250 || r.left < 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 화면에 실제로 보이는 치지직 채팅 헤더의 '채팅' 글씨 요소를 찾는다 */
  function findRealChatHeaderTitleEl() {
    if (!document.body) return null;

    // 1순위: 치지직 채팅 헤더 타이틀 명시 클래스 및 헤더 내부 태그
    const explicitList = document.querySelectorAll(
      '[class*="live_chatting_header"] h1, [class*="live_chatting_header"] h2, [class*="live_chatting_header"] h3, [class*="live_chatting_header"] strong, [class*="live_chatting_header"] span, [class*="chatting_header"] h1, [class*="chatting_header"] h2, [class*="chatting_header"] h3, [class*="chatting_header"] strong, [class*="chatting_header"] span, [class*="header_title"]',
    );
    for (const el of explicitList) {
      if (el.id === 'cmv-fallback-chat-title' || el.closest('#cmv-mgr-btn, #cmv-mgr-popup')) continue;
      if (!isVisuallyRenderedHeaderTitle(el)) continue;
      const directText = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join('');
      if (directText === '채팅' || (el.children.length === 0 && el.textContent.trim() === '채팅')) return el;
    }

    // 2순위: document.body 전체 TreeWalker로 '채팅' 텍스트 노드 직접 탐색
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || '').trim() !== '채팅') continue;
      const el = node.parentElement;
      if (!el || el.id === 'cmv-fallback-chat-title') continue;
      if (el.closest('#cmv-fallback-chat-header, #cmv-mgr-btn, #cmv-mgr-popup, #' + PIN_ID + ', ' + ROW)) continue;
      if (isVisuallyRenderedHeaderTitle(el)) return el;
    }
    return null;
  }

  function createMgrButton() {
    const btn = document.createElement('button');
    btn.id = 'cmv-mgr-btn';
    btn.type = 'button';
    btn.title = '관리자 · 스트리머 채팅 모아보기 팝업 켜기/끄기';
    btn.innerHTML = `<span>🛡️ 관리자·봇</span><span class="cmv-mgr-cnt" id="cmv-mgr-cnt">0</span>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMgrPopup();
    });
    return btn;
  }

  function ensureMgrPopup(chatRoot) {
    let popup = document.getElementById('cmv-mgr-popup');
    if (popup && popup.isConnected) return popup;

    if (getComputedStyle(chatRoot).position === 'static') {
      chatRoot.style.position = 'relative';
    }

    popup = document.createElement('div');
    popup.id = 'cmv-mgr-popup';
    popup.className = mgrPopupOpen ? 'open' : '';
    popup.style.setProperty('--mgr-fs', mgrFontSize + 'px');

    const head = document.createElement('div');
    head.className = 'cmv-mgr-head';
    const title = document.createElement('span');
    title.textContent = '🛡️ 관리자 · 👑 스트리머 채팅';

    const actions = document.createElement('div');
    actions.className = 'cmv-mgr-actions';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '비우기';
    clearBtn.title = '수집된 목록 비우기';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mgrChats.length = 0;
      saveStoredMgrChats();
      renderMgrPopupList();
      updateMgrCount();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = '닫기';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMgrPopup(false);
    });

    actions.append(clearBtn, closeBtn);
    head.append(title, actions);

    // 툴바: 필터 체크박스 및 글자 크기 조절
    const toolbar = document.createElement('div');
    toolbar.className = 'cmv-mgr-toolbar';

    const filters = document.createElement('div');
    filters.className = 'cmv-mgr-filters';

    const mkCheck = (role, labelText) => {
      const lbl = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = mgrRoles.has(role);
      box.addEventListener('change', () => {
        if (box.checked) mgrRoles.add(role);
        else mgrRoles.delete(role);
        chrome.storage.local.set({ [MGR_ROLES_KEY]: [...mgrRoles] }).catch(() => {});
        renderMgrPopupList();
      });
      lbl.append(box, document.createTextNode(labelText));
      return lbl;
    };
    filters.append(mkCheck('streamer', '👑스트리머'), mkCheck('manager', '🛡️관리자'));

    const fsCtrl = document.createElement('div');
    fsCtrl.className = 'cmv-mgr-fs-ctrl';
    const fsDown = document.createElement('button');
    fsDown.type = 'button';
    fsDown.className = 'cmv-mgr-fs-btn';
    fsDown.textContent = '가−';
    const fsVal = document.createElement('span');
    fsVal.textContent = String(mgrFontSize);
    const fsUp = document.createElement('button');
    fsUp.type = 'button';
    fsUp.className = 'cmv-mgr-fs-btn';
    fsUp.textContent = '가+';

    const setFs = (delta) => {
      mgrFontSize = Math.min(20, Math.max(10, mgrFontSize + delta));
      fsVal.textContent = String(mgrFontSize);
      popup.style.setProperty('--mgr-fs', mgrFontSize + 'px');
      chrome.storage.local.set({ [MGR_FS_KEY]: mgrFontSize }).catch(() => {});
    };
    fsDown.addEventListener('click', (e) => { e.stopPropagation(); setFs(-1); });
    fsUp.addEventListener('click', (e) => { e.stopPropagation(); setFs(1); });
    fsCtrl.append(fsDown, fsVal, fsUp);

    toolbar.append(filters, fsCtrl);

    const list = document.createElement('div');
    list.id = 'cmv-mgr-list';
    popup.append(head, toolbar, list);

    chatRoot.prepend(popup);
    renderMgrPopupList();
    return popup;
  }

  function ensureMgrHeaderUI() {
    // 멀티뷰 안에서는 multiview.html의 #mvMgrChatBtn이 직접 렌더링되므로 iframe 내부 헤더/버튼을 생성하지 않음
    if (inMultiview) {
      const fbHeader = document.getElementById('cmv-fallback-chat-header');
      if (fbHeader) fbHeader.remove();
      const existingBtn = document.getElementById('cmv-mgr-btn');
      if (existingBtn) existingBtn.remove();
      const popup = document.getElementById('cmv-mgr-popup');
      if (popup) popup.remove();
      return;
    }

    let existingBtn = document.getElementById('cmv-mgr-btn');
    if (existingBtn && existingBtn.isConnected) {
      updateMgrCount();
      return;
    }

    const chatRoot = findChatRoot();
    if (!chatRoot) return;

    ensureMgrPopup(chatRoot);

    const realTitleEl = findRealChatHeaderTitleEl();

    // 실제 '채팅' 헤더 글씨가 화면에 나타나면 폴백 헤더는 제거하고 실제 '채팅' 글씨 바로 왼쪽으로 버튼 배치
    if (realTitleEl) {
      const fbHeader = document.getElementById('cmv-fallback-chat-header');
      if (fbHeader) fbHeader.remove();

      if (!existingBtn) existingBtn = createMgrButton();
      const p = realTitleEl.parentElement;
      if (p) {
        p.insertBefore(existingBtn, realTitleEl);
      } else {
        realTitleEl.insertAdjacentElement('beforebegin', existingBtn);
      }
      updateMgrCount();
      return;
    }

    // 독립 채팅창(/live/{id}/chat) 등 상단 '채팅' 헤더가 없는 환경에서는 상단 고정 헤더 생성
    let fbHeader = document.getElementById('cmv-fallback-chat-header');
    if (!fbHeader) {
      fbHeader = document.createElement('div');
      fbHeader.id = 'cmv-fallback-chat-header';
      const span = document.createElement('span');
      span.id = 'cmv-fallback-chat-title';
      span.style.cssText = 'display:inline-flex;align-items:center;';
      span.textContent = '채팅';
      fbHeader.appendChild(span);
      chatRoot.prepend(fbHeader);
    }
    const fbTitle = document.getElementById('cmv-fallback-chat-title');
    if (fbTitle) {
      const btn = existingBtn || createMgrButton();
      fbTitle.insertBefore(btn, fbTitle.firstChild);
      updateMgrCount();
    }
  }

  function toggleMgrPopup(force) {
    mgrPopupOpen = typeof force === 'boolean' ? force : !mgrPopupOpen;
    const chatRoot = findChatRoot();
    if (chatRoot) ensureMgrPopup(chatRoot);
    const popup = document.getElementById('cmv-mgr-popup');
    const btn = document.getElementById('cmv-mgr-btn');
    if (popup) popup.classList.toggle('open', mgrPopupOpen);
    if (btn) btn.classList.toggle('on', mgrPopupOpen);
    if (mgrPopupOpen) renderMgrPopupList();
  }

  function updateMgrCount() {
    const cntEl = document.getElementById('cmv-mgr-cnt');
    if (cntEl) {
      const str = String(mgrChats.length);
      if (cntEl.textContent !== str) {
        cntEl.textContent = str;
      }
    }
  }

  function roleLabel(role) {
    if (role === 'streamer') return '👑 스트리머';
    if (role === 'bot') return '🤖 봇';
    return '🛡️ 관리자';
  }

  function appendMgrItemDOM(listEl, item) {
    const emptyEl = listEl.querySelector('.cmv-mgr-empty');
    if (emptyEl) emptyEl.remove();

    const div = document.createElement('div');
    div.className = `cmv-mgr-item ${item.role}`;

    const time = document.createElement('span');
    time.className = 'cmv-mgr-time';
    time.textContent = item.time;

    const tag = document.createElement('span');
    tag.className = `cmv-mgr-tag ${item.role}`;
    tag.textContent = roleLabel(item.role);

    const nick = document.createElement('span');
    nick.className = 'cmv-mgr-nick';
    if (item.color) nick.style.color = item.color;
    nick.textContent = item.nick;

    const body = document.createElement('span');
    body.textContent = item.text;

    div.append(time, tag, nick, body);
    listEl.appendChild(div);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function renderMgrPopupList() {
    const listEl = document.getElementById('cmv-mgr-list');
    if (!listEl) return;
    listEl.textContent = '';
    const filtered = mgrChats.filter((x) => mgrRoles.has(x.role === 'bot' ? 'manager' : x.role));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cmv-mgr-empty';
      empty.textContent = mgrRoles.size ? '아직 모인 채팅이 없습니다.' : '모을 채팅 종류를 하나 이상 체크해 주세요.';
      listEl.appendChild(empty);
      return;
    }
    for (const item of filtered) {
      appendMgrItemDOM(listEl, item);
    }
  }

  function detectManagerBotOrStreamerRole(row) {
    const nick = nickOf(row);
    // 0차: 닉네임이 봇(나이트봇, 치지직봇, 안내봇, *봇, *bot 등)인 경우 최우선 'bot' 분류
    if (nick && BOT_NICK_RE.test(nick)) return 'bot';

    // 1차: chat-main.js가 React/WebSocket에서 스탬핑한 userRoleCode
    if (
      row.dataset.cmvRole === 'streamer' ||
      row.dataset.cmvRole === 'manager' ||
      row.dataset.cmvRole === 'bot'
    ) {
      return row.dataset.cmvRole;
    }

    // 2차: 배지 이미지/아이콘 속성 검사
    const badges = row.querySelectorAll(BADGE);
    for (const b of badges) {
      const alt = (
        b.getAttribute('alt') ||
        b.getAttribute('title') ||
        b.getAttribute('aria-label') ||
        ''
      ).toLowerCase();
      const cls = (typeof b.className === 'string' ? b.className : '').toLowerCase();
      const src = (b.getAttribute('src') || '').toLowerCase();
      const hay = `${alt} ${cls} ${src}`;
      if (/streamer|스트리머|broadcaster|방장|channel_owner|crown|왕관/.test(hay)) return 'streamer';
      if (/bot|챗봇|자동/.test(hay)) return 'bot';
      if (/manager|매니저|moderator|관리자|운영자|admin|staff/.test(hay)) return 'manager';
    }

    // 3차: 스트리머 본인 확인
    if (nick) {
      const pageStreamerEl = document.querySelector(
        '[class*="video_information_name"], [class*="channel_name"]',
      );
      const pageStreamer = pageStreamerEl ? pageStreamerEl.textContent.trim() : '';
      if (pageStreamer && nick === pageStreamer) return 'streamer';
      if (row.querySelector('[class*="verified"], [aria-label*="파트너"], svg[class*="mark"]')) {
        return 'streamer';
      }
    }
    return null;
  }

  function handleManagerAndBadgeRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.dataset.cmvMgrCollected === '1') return;

    const role = detectManagerBotOrStreamerRole(row);
    const nick = nickOf(row);
    const text = textOf(row);
    if (!nick || !text) return;

    if (role === 'streamer' || role === 'manager' || role === 'bot') {
      row.dataset.cmvMgrCollected = '1';
      const now = new Date();
      const timeStr =
        (row.querySelector('[data-cmv-time]') && row.querySelector('[data-cmv-time]').dataset.cmvTime) ||
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      let color = '';
      const nickEl = row.querySelector(NICK);
      if (nickEl) color = getComputedStyle(nickEl).color || '';

      const item = { role: role === 'bot' ? 'manager' : role, nick, text: text.slice(0, 500), time: timeStr, at: Date.now(), color };
      recordMgrChatItem(item);
    }

    const cid = channelIdFromUrl();
    const badgeType = role || (row.querySelectorAll(BADGE).length ? 'badge' : null);
    if (cid && badgeType && row.dataset.cmvBadgeSent !== '1') {
      if (badgeType === 'badge') {
        const hay = row.innerHTML.slice(0, 2000).toLowerCase();
        if (/subscriber|구독|fan|팬|tier/.test(hay) && !/streamer|manager|스트리머|매니저|관리자/.test(hay)) {
          return;
        }
      }
      row.dataset.cmvBadgeSent = '1';
      try {
        window.parent.postMessage(
          {
            cmv: 1,
            type: 'CMV_BADGE_CHAT',
            channelId: cid,
            nick,
            text: text.slice(0, 500),
            role: role || '',
            badge: badgeType === 'bot' ? 'manager' : badgeType,
            at: Date.now(),
          },
          '*',
        );
      } catch {}
    }
  }

  /* ---------------- 2. 특정 유저 채팅 고정 ---------------- */
  const PIN_ID = 'cmv-pin-area';
  const PIN_LIST_ID = 'cmv-pin-list';

  function ensurePinArea() {
    let area = document.getElementById(PIN_ID);
    if (area && area.isConnected) return document.getElementById(PIN_LIST_ID);
    const host = findChatRoot();
    if (!host) return null;

    area = document.createElement('div');
    area.id = PIN_ID;
    area.style.cssText =
      'position:sticky;top:0;z-index:100;background:rgba(11,14,20,.96);border-bottom:1px solid #232c40;max-height:32%;overflow-y:auto;display:none;font-size:12px;';

    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;background:#151b28;color:#8b95ad;font-size:11px;border-bottom:1px solid #232c40;';
    const title = document.createElement('span');
    title.textContent = '📌 고정 유저 채팅';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '비우기';
    clearBtn.style.cssText =
      'background:none;border:none;color:#8b95ad;cursor:pointer;font-size:11px;padding:0 4px;';
    clearBtn.addEventListener('click', () => {
      const listEl = document.getElementById(PIN_LIST_ID);
      if (listEl) listEl.textContent = '';
      area.style.display = 'none';
    });
    head.append(title, clearBtn);

    const listEl = document.createElement('div');
    listEl.id = PIN_LIST_ID;
    area.append(head, listEl);
    host.prepend(area);
    return listEl;
  }

  function handlePinRow(row) {
    if (!S.pinUsers.length) return;
    if (row.closest('#' + PIN_ID) || row.closest('#cmv-mgr-popup')) return;
    const nick = nickOf(row);
    if (!nick) return;
    const matched = S.pinUsers.some((u) => u.toLowerCase() === nick.toLowerCase());
    if (!matched) return;

    const listEl = ensurePinArea();
    const area = document.getElementById(PIN_ID);
    if (!listEl || !area) return;

    const clone = row.cloneNode(true);
    clone.style.cssText =
      'border-left:2px solid #2dd4bf;padding:3px 6px;margin:2px 0;position:relative;';
    listEl.appendChild(clone);
    while (listEl.children.length > 20) listEl.firstChild.remove();
    area.style.display = 'block';
    listEl.scrollTop = listEl.scrollHeight;
  }

  function refreshPin() {
    const area = document.getElementById(PIN_ID);
    if (!S.pinUsers.length) {
      if (area) area.remove();
      return;
    }
    ensurePinArea();
  }

  /* ---------------- 3. 클린봇 · 관리자 블라인드 댓글 원문 복원 ---------------- */
  const blindCache = new WeakMap();        // row -> original text
  const nickHistoryCache = new Map();      // nick -> [{ text, at, used }]
  const NICK_HIST_MAX = 25;

  function cacheOriginalText(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.querySelector('.cmv-restored-blind')) return;

    const bodyText = textOf(row);
    if (!bodyText || BLIND_TEXT_RE.test(bodyText)) return;

    blindCache.set(row, bodyText);
    if (!row.dataset.cmvOrigText) {
      row.dataset.cmvOrigText = bodyText;
    }

    const nick = nickOf(row);
    if (nick) {
      if (!nickHistoryCache.has(nick)) nickHistoryCache.set(nick, []);
      const arr = nickHistoryCache.get(nick);
      if (!arr.some((x) => x.text === bodyText && Date.now() - x.at < 3000)) {
        arr.push({ text: bodyText, at: Date.now(), used: false });
        while (arr.length > NICK_HIST_MAX) arr.shift();
      }
    }
  }

  /** 블라인드 문구가 들어 있는 대상 요소를 찾는다 (닉네임 영역은 절대 건드리지 않음) */
  function findBlindNoticeEl(row) {
    // 1순위: 명시적 블라인드 클래스 요소
    const explicit = row.querySelector(BLIND_EL_SEL);
    if (explicit && !explicit.querySelector(NICK)) return explicit;

    // 2순위: 메시지 텍스트 요소
    const bodyEl = findMessageBodyEl(row);
    if (bodyEl && !bodyEl.querySelector(NICK)) return bodyEl;

    // 3순위: 블라인드 문구 텍스트 노드를 직접 품고 있는 하위 요소
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (BLIND_TEXT_RE.test(node.nodeValue || '')) {
        const parent = node.parentElement;
        if (parent && !parent.querySelector(NICK)) return parent;
      }
    }
    return null;
  }

  function tryRestoreBlindRow(row) {
    if (document.documentElement.dataset.cmvBlindV2 === '1') return; // 새 방식(blind-main.js)이 처리함
    if (!S.restoreBlind || !(row instanceof HTMLElement)) return;
    if (row.querySelector('.cmv-restored-blind')) return;

    const rawRowText = row.textContent || '';
    const isBlindedByText = BLIND_TEXT_RE.test(rawRowText);
    const isBlindedByClass =
      !!row.querySelector(BLIND_EL_SEL) ||
      /blind|cleanbot/i.test(typeof row.className === 'string' ? row.className : '');

    if (!isBlindedByText && !isBlindedByClass) return;

    const isCleanbot =
      /클린봇|부적절/.test(rawRowText) ||
      row.dataset.cmvBlindType === 'cleanbot' ||
      !!row.querySelector('[class*="cleanbot" i]');

    // 원문 탐색: 1차(React/WS 스탬프) -> 2차(DOM row 캐시) -> 3차(닉네임별 최근 캐시)
    let original = row.dataset.cmvOrigText || blindCache.get(row) || '';
    if (original && BLIND_TEXT_RE.test(original)) original = '';

    if (!original) {
      const nick = nickOf(row);
      if (nick && nickHistoryCache.has(nick)) {
        const arr = nickHistoryCache.get(nick);
        for (let i = arr.length - 1; i >= 0; i -= 1) {
          if (Date.now() - arr[i].at > 3 * 60 * 1000) break; // 3분 넘은 채팅은 짐작하지 않음
          if (!arr[i].used && !BLIND_TEXT_RE.test(arr[i].text)) {
            original = arr[i].text;
            arr[i].used = true;
            break;
          }
        }
      }
    }

    // (치지직 '보기' 버튼은 누르지 않음: 누르면 원문이 따로 뜨는 창으로 나와서, 채팅 자리에 바로 보여주는 방식만 씀)
    if (!original) return;

    const targetEl = findBlindNoticeEl(row);
    if (!targetEl) return;

    // 치지직(React)이 관리하는 글자를 지우면 채팅창이 깨질 수 있어서, 블라인드 문구는 숨기고 바로 옆에 원문을 붙임
    targetEl.dataset.cmvBlindHidden = '1';
    const wrapper = document.createElement('span');
    wrapper.className = 'cmv-restored-blind';

    const tag = document.createElement('span');
    tag.className = `cmv-blind-tag ${isCleanbot ? 'cleanbot' : 'manager'}`;
    tag.textContent = isCleanbot ? '🤖 클린봇 블라인드' : '🛡️ 관리자 블라인드';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = original;

    wrapper.append(tag, msgSpan);
    targetEl.after(wrapper);
    row.dataset.cmvBlindRestored = '1';
  }

  function scanAllBlindRows() {
    if (!S.restoreBlind) return;
    try {
      document.querySelectorAll(ROW).forEach((row) => {
        cacheOriginalText(row);
        tryRestoreBlindRow(row);
      });
    } catch {}
  }

  /* ---------------- 4. 1시간 시청 통나무 파워 배달 완료! 자동 받기 (통나무 켜진 단일 방 전용) ---------------- */
  const LP_STORE_KEY = 'my-multiview:lp';
  let claimOn = urlParams.get('cmv_lp') === '1';
  let lastLpClaimAt = 0;

  function setChatClaimOn(nextOn) {
    claimOn = !!nextOn;
    if (document.documentElement) {
      document.documentElement.dataset.cmvLpActive = claimOn ? '1' : '0';
    }
    if (claimOn) {
      tryClaimChatLogPower();
    }
  }
  setChatClaimOn(claimOn);

  async function fetchLpJsonWithFallback(url, init = {}) {
    try {
      const res = await fetch(url, { credentials: 'include', ...init });
      if (res.ok) return await res.json();
    } catch {}
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

  async function claimLogPowerViaApi(cid) {
    if (!cid || !claimOn) return;
    const apis = [
      `https://api.chzzk.naver.com/service/v1/channels/${cid}/log-power`,
      `https://api.chzzk.naver.com/service/v2/channels/${cid}/log-power`,
    ];
    for (const api of apis) {
      try {
        const body = await fetchLpJsonWithFallback(api);
        if (!body || !body.content) continue;
        const c = body.content || {};
        const claims = c.claims || c.availableClaims || c.activeClaims || [];
        let claimed = false;
        if (Array.isArray(claims)) {
          for (const x of claims) {
            const claimId = x && (x.claimId || x.id || x.powerClaimId);
            if (!claimId) continue;
            let ok = await fetchLpJsonWithFallback(`${api}/claims/${encodeURIComponent(claimId)}`, {
              method: 'PUT',
            });
            if (!ok) {
              ok = await fetchLpJsonWithFallback(`${api}/claims/${encodeURIComponent(claimId)}`, {
                method: 'POST',
              });
            }
            if (ok) claimed = true;
          }
        }
        let amount = [c.amount, c.logPower, c.balance, c.totalAmount, c.point].find(
          (v) => typeof v === 'number',
        );
        if (claimed) {
          const again = await fetchLpJsonWithFallback(api);
          const c2 = (again && again.content) || {};
          const a2 = [c2.amount, c2.logPower, c2.balance, c2.totalAmount, c2.point].find(
            (v) => typeof v === 'number',
          );
          if (typeof a2 === 'number') amount = a2;
        }
        try {
          window.parent.postMessage(
            { cmv: 1, type: 'CMV_LP_STATUS', channelId: cid, ok: true, amount, claimed: true, at: Date.now() },
            EXT_ORIGIN,
          );
        } catch {}
        break;
      } catch {}
    }
  }

  function clickElementSafely(el) {
    if (!(el instanceof HTMLElement)) return false;
    const now = Date.now();
    const prev = Number(el.dataset.cmvLpClickedAt || '0');
    if (now - prev < 3000) return false;
    el.dataset.cmvLpClickedAt = String(now);
    el.dataset.cmvLpClick = '1';
    try {
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      // MAIN 월드(chat-main.js)에서도 React __reactProps$.onClick을 직접 호출하도록 신호 전달
      window.dispatchEvent(new CustomEvent('__cmv_lp_click'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 채팅창 하단 "1시간 시청 통나무 파워 배달 완료! 120 받기" 배너 및 버튼을 감지해 자동 클릭
   * (여러 방송이 켜져 있어도 사용자가 통나무 자동 수집을 켠 단 하나의 방(claimOn === true)에서만 작동)
   */
  function tryClaimChatLogPower() {
    if (!S.autoLp || !claimOn) return false;
    const now = Date.now();
    if (now - lastLpClaimAt < 1000) return false;

    const root = findChatRoot() || document.body;
    if (!root) return false;

    let clicked = false;

    try {
      // 1차: 명시적 통나무/파워/보상 관련 클래스나 속성 내부 버튼 탐색
      const powerSelectors = [
        '[class*="log_power" i]',
        '[class*="logpower" i]',
        '[class*="chatting_power" i]',
        '[class*="power_toast" i]',
        '[class*="power_banner" i]',
        '[class*="power_button" i]',
        'button[aria-label*="통나무"]',
        'button[title*="통나무"]',
      ].join(',');

      for (const el of root.querySelectorAll(powerSelectors)) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/받기|획득|수령|배달\s*완료|통나무\s*파워|인증하기/i.test(txt)) continue;
        const innerBtns = el.querySelectorAll('button, [role="button"], a');
        for (const b of innerBtns) {
          if (!b.disabled && clickElementSafely(b)) clicked = true;
        }
        if (
          (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || /받기|인증하기/.test(txt)) &&
          clickElementSafely(el)
        ) {
          clicked = true;
        }
      }

      // 2차: "1시간 시청 통나무 파워 배달 완료! 120 받기" 가장 안쪽(innermost) 요소 정밀 탐색
      // '받기'·'인증하기' 글자가 아예 없으면 전체 요소 탐색을 건너뜀 (1.5초마다 도는 검사라 가볍게)
      const candidates = /받기|인증하기/.test(root.textContent || '')
        ? root.querySelectorAll('button, [role="button"], div, span, a')
        : [];
      for (const el of candidates) {
        if (el.closest('#cmv-mgr-popup, #' + PIN_ID + ', ' + ROW)) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 90) continue;

        // 케이스 A: "120 받기" / "받기" / "1시간 라이브 시청 후 인증하기" 버튼·요소 자체인 경우
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
            const btn = el.closest('button, [role="button"]') || el;
            if (clickElementSafely(btn)) clicked = true;
            if (btn !== el && clickElementSafely(el)) clicked = true;
            if (el.parentElement && (el.parentElement.textContent || '').trim().length <= 45) {
              clickElementSafely(el.parentElement);
            }
          }
        } else if (
          /1시간\s*시청\s*통나무|통나무\s*파워\s*배달\s*완료/.test(txt) &&
          /받기/.test(txt)
        ) {
          // 케이스 B: 배너 컨테이너 자체인 경우 (상위 외부 래퍼는 건너뛰고 가장 안쪽 배너만 클릭!)
          const hasInnerBanner = [...el.children].some((ch) => {
            const ct = (ch.textContent || '').replace(/\s+/g, ' ').trim();
            return /1시간\s*시청\s*통나무|통나무\s*파워\s*배달\s*완료/.test(ct) && /받기/.test(ct);
          });
          if (hasInnerBanner) continue;

          for (const sub of el.querySelectorAll('button, [role="button"], span, div, a')) {
            const st = (sub.textContent || '').replace(/\s+/g, ' ').trim();
            if (sub.tagName === 'BUTTON' || sub.getAttribute('role') === 'button' || /받기/.test(st)) {
              if (clickElementSafely(sub)) clicked = true;
            }
          }
          if (clickElementSafely(el)) clicked = true;
        }
      }
    } catch {}

    if (clicked) {
      lastLpClaimAt = now;
      const cid = channelIdFromUrl();
      if (cid) {
        claimLogPowerViaApi(cid);
        setTimeout(() => claimLogPowerViaApi(cid), 1200);
      }
    }
    return clicked;
  }

  /* ---------------- 5. 통합 MutationObserver 및 초기 채팅 스캔 ---------------- */
  const processedRows = new WeakSet();
  let mainObserver = null;

  function processRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.closest('#cmv-mgr-popup') || row.closest('#' + PIN_ID)) return;

    cacheOriginalText(row);
    tryRestoreBlindRow(row);

    // chat-main.js가 React/WebSocket에서 스탬핑한 직후 한 번 더 블라인드 복원 확인
    setTimeout(() => {
      cacheOriginalText(row);
      tryRestoreBlindRow(row);
    }, 60);

    if (processedRows.has(row)) return;
    processedRows.add(row);
    handlePinRow(row);
    setTimeout(() => handleManagerAndBadgeRow(row), 40);
    setTimeout(() => handleManagerAndBadgeRow(row), 250);
  }

  function processAddedNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(ROW)) {
      processRow(node);
    } else {
      const parentRow = node.closest(ROW);
      if (parentRow) {
        cacheOriginalText(parentRow);
        tryRestoreBlindRow(parentRow);
      }
      node.querySelectorAll(ROW).forEach(processRow);
    }
  }

  function startObserver() {
    if (mainObserver) return;
    const root = document.documentElement;
    if (!root) return;

    document.querySelectorAll(ROW).forEach(processRow);
    ensureMgrHeaderUI();
    tryClaimChatLogPower();

    mainObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          if (m.target instanceof HTMLElement) {
            const parentRow = m.target.closest(ROW);
            if (parentRow) {
              cacheOriginalText(parentRow);
              tryRestoreBlindRow(parentRow);
            }
          }
          for (const node of m.addedNodes) {
            processAddedNode(node);
          }
        } else if (m.type === 'characterData') {
          const parentEl = m.target && m.target.parentElement;
          const parentRow = parentEl ? parentEl.closest(ROW) : null;
          if (parentRow) {
            cacheOriginalText(parentRow);
            tryRestoreBlindRow(parentRow);
          }
        } else if (m.type === 'attributes') {
          if (m.target instanceof HTMLElement && m.target.matches(ROW)) {
            tryRestoreBlindRow(m.target);
          }
        }
      }
      if (S.pinUsers.length && !document.getElementById(PIN_ID)) {
        ensurePinArea();
      }
    });
    mainObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-cmv-orig-text', 'data-cmv-blind-type', 'class'],
    });
  }

  // 주기적 안전망: 관리자·봇 헤더 버튼 유지, 블라인드 댓글 복원, 1시간 시청 통나무 배너 자동 클릭
  setInterval(() => {
    ensureMgrHeaderUI();
    scanAllBlindRows();
    tryClaimChatLogPower();
  }, 1500);

  /* ---------------- 6. 로그인 풀림 자동 복구 & 로그인 버튼 인터셉트 ---------------- */
  function isLoggedOutChatUI() {
    const inputs = document.querySelectorAll(
      'textarea, input, [contenteditable="true"], button, [class*="chatting_input"]',
    );
    for (const el of inputs) {
      const txt =
        (el.getAttribute('placeholder') || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.textContent || '');
      if (/로그인\s*후|로그인이\s*필요|로그인\s*하기/.test(txt)) return true;
    }
    return false;
  }

  function checkAutoLoginRecovery() {
    if (!inMultiview || !isStandaloneChat) return;
    if (!isLoggedOutChatUI()) return;
    const key = 'cmv_auth_retried_' + channelIdFromUrl();
    try {
      const prev = Number(sessionStorage.getItem(key) || '0');
      if (Date.now() - prev < 15000) return;
      chrome.runtime.sendMessage({ type: 'mv:sync-cookies' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.ok && resp.auth && resp.auth.loggedIn) {
          try { sessionStorage.setItem(key, String(Date.now())); } catch {}
          location.reload();
        }
      });
    } catch {}
  }
  setTimeout(checkAutoLoginRecovery, 2000);
  setTimeout(checkAutoLoginRecovery, 5000);

  document.addEventListener(
    'click',
    (e) => {
      if (!inMultiview || !e.isTrusted) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) return;

      const link = target.closest('a[href*="nid.naver.com"]');
      const btn = target.closest('button, [role="button"], [class*="input"], [class*="login"]');
      const text =
        ((link || btn || target).textContent || '') +
        ' ' +
        ((link || btn || target).getAttribute('placeholder') || '');

      if (link || (/로그인/.test(text) && isLoggedOutChatUI())) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'mv:open-login' }, () => void chrome.runtime.lastError);
        try {
          window.parent.postMessage({ cmv: 1, type: 'CMV_LOGIN_OPENED' }, EXT_ORIGIN);
        } catch {}
      }
    },
    true,
  );

  /* ---------------- 7. 방송 재연결 감지 및 채팅 자가 복구 ---------------- */
  const CHAT_DISCONNECTED_RE =
    /방송이\s*종료|채팅이\s*비활성화|채팅\s*서버와의\s*연결이\s*끊|연결할\s*수\s*없습니다|다시\s*연결하는\s*중|채팅방에\s*입장할\s*수\s*없습니다/;

  function isChatDisconnectedOrEnded() {
    // 1. 화면에 방종이나 소켓 연결 끊김 문구가 표시되어 있는지 검사
    // 페이지 전체 글자에 해당 문구가 아예 없으면 요소를 하나하나 뒤지지 않음 (5초마다 도는 검사라 가볍게)
    const pageText = (document.body && document.body.textContent) || '';
    const mayHaveNotice = CHAT_DISCONNECTED_RE.test(pageText);
    for (const el of mayHaveNotice ? document.querySelectorAll(
      '[class*="notice"], [class*="status"], [class*="empty"], [class*="error"], [class*="disconnect"], [class*="disabled"], [class*="chatting_message"], p, div, span',
    ) : []) {
      if (el.children.length > 2) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length < 50 && CHAT_DISCONNECTED_RE.test(txt)) return true;
    }
    // 2. 웹소켓 상태가 closed이고 12초 이상 경과한 경우
    const wsState = document.documentElement.dataset.cmvWsState;
    const closedAt = Number(document.documentElement.dataset.cmvWsClosedAt || '0');
    if (wsState === 'closed' && closedAt > 0 && Date.now() - closedAt > 12000) {
      return true;
    }
    return false;
  }

  let lastChatRecoveryCheck = 0;
  let isCheckingChatRecovery = false;

  async function checkChatAutoReconnect() {
    if (isCheckingChatRecovery) return;
    const cid = channelIdFromUrl();
    if (!cid) return;

    const disconnected = isChatDisconnectedOrEnded();
    if (!disconnected) return;

    if (Date.now() - lastChatRecoveryCheck < 12000) return;
    lastChatRecoveryCheck = Date.now();
    isCheckingChatRecovery = true;

    try {
      // 치지직 라이브 상태 API로 현재 방송 상태 확인
      const resp = await chrome.runtime.sendMessage({
        type: 'mv:fetch-api',
        url: `https://api.chzzk.naver.com/polling/v2/channels/${cid}/live-status`,
        method: 'GET',
      });
      const content = resp && resp.ok && resp.data && resp.data.content;
      const status = content && (content.status || content.liveStatus);

      // 방송이 OPEN 상태인데 채팅이 끊겨 있거나 방종 상태라면 즉시 재연결!
      if (status === 'OPEN') {
        try {
          window.parent.postMessage({ cmv: 1, type: 'CMV_REQ_CHAT_RECONNECT', channelId: cid }, EXT_ORIGIN);
        } catch {}
        setTimeout(() => {
          location.reload();
        }, 1200);
      }
    } catch {} finally {
      isCheckingChatRecovery = false;
    }
  }
  setInterval(checkChatAutoReconnect, 5000);

  /* ---------------- 8. 부모(멀티뷰)에서 오는 메시지 처리 ---------------- */
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== EXT_ORIGIN) return;
    const d = e.data;
    if (!d || d.cmv !== 1) return;
    if (d.type === 'CMV_INSERT_CHAT' && d.text) {
      window.postMessage({ __cmvMainCmd: true, cmd: 'INSERT_CHAT', text: d.text }, '*');
    } else if (d.type === 'CMV_SET_LP') {
      setChatClaimOn(!!d.on);
    } else if (d.type === 'CMV_RELOAD_CHAT') {
      location.reload();
    }
  });

  /* ---------------- 채팅 저장소 버튼: 채팅창 맨 아래 '미션 후원' 버튼 오른쪽 ----------------
   * 치지직 버튼의 클래스를 그대로 빌려 써서 모양을 맞추고, 누르면 멀티뷰에 저장소 창을 열어 달라고 알린다.
   */
  const STORAGE_BTN_ID = 'cmv-storage-btn';
  /** 채팅창 맨 아래 줄(입력창 밑 '후원하기' 줄)의 '미션 후원' 버튼.
   *  위쪽 '진행 중인 미션' 배너 같은 다른 '미션' 버튼과 헷갈리지 않게, 화면 아래쪽에 있는 것만 본다. */
  function findMissionButton() {
    const bottomLine = innerHeight - 140;
    let best = null;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (b.id === STORAGE_BTN_ID || b.closest(ROW)) continue;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.top < bottomLine) continue;
      const label = [b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent].filter(Boolean).join(' ');
      if (/미션/.test(label) && (!best || r.left > best.getBoundingClientRect().left)) best = b;
    }
    if (best) return best;
    // 이름으로 못 찾으면: '후원하기' 버튼과 같은 줄의 마지막 아이콘 버튼
    const donate = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.top >= bottomLine && /후원하기/.test(b.textContent || '');
    });
    if (!donate) return null;
    const line = donate.parentElement;
    const icons = [...(line ? line.querySelectorAll('button, [role="button"]') : [])].filter(
      (b) => b !== donate && b.id !== STORAGE_BTN_ID && b.getBoundingClientRect().width > 0,
    );
    return icons.length ? icons[icons.length - 1] : null;
  }
  /* ---------------- 일반 치지직 웹사이트용 로컬 채팅 저장소 UI ---------------- */
  let directStorageList = [];
  function loadDirectStorage() {
    chrome.storage.local.get('my-multiview:settings').then((o) => {
      const s = (o && o['my-multiview:settings']) || {};
      try {
        const v = JSON.parse(s['my-multiview:chatStorage'] || '[]');
        if (Array.isArray(v)) directStorageList = v;
      } catch {}
      renderDirectStorageList();
    }).catch(() => {});
  }
  loadDirectStorage();

  function saveDirectStorage() {
    chrome.storage.local.get('my-multiview:settings').then((o) => {
      const s = (o && o['my-multiview:settings']) || {};
      s['my-multiview:chatStorage'] = JSON.stringify(directStorageList);
      chrome.storage.local.set({ 'my-multiview:settings': s }).catch(() => {});
    }).catch(() => {});
  }

  function renderDirectStorageList() {
    const listEl = document.getElementById('cmv-dsp-list');
    if (!listEl) return;
    listEl.textContent = '';
    if (!directStorageList.length) {
      const empty = document.createElement('div');
      empty.className = 'cmv-dsp-empty';
      empty.textContent = '저장된 채팅 문구가 없어요. 아래에서 자주 쓰는 문구를 추가해 보세요!';
      listEl.appendChild(empty);
      return;
    }
    for (const text of directStorageList) {
      const item = document.createElement('div');
      item.className = 'cmv-dsp-item';
      item.title = '클릭하면 채팅창에 자동 입력됩니다';
      const span = document.createElement('span');
      span.textContent = text;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cmv-dsp-del';
      del.textContent = '✕';
      del.title = '삭제';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        directStorageList = directStorageList.filter((x) => x !== text);
        saveDirectStorage();
        renderDirectStorageList();
      });
      item.append(span, del);
      item.addEventListener('click', () => {
        window.postMessage({ __cmvMainCmd: true, cmd: 'INSERT_CHAT', text }, '*');
        toggleDirectStoragePop(false);
      });
      listEl.appendChild(item);
    }
  }

  function ensureDirectStoragePop(chatRoot) {
    let pop = document.getElementById('cmv-direct-storage-pop');
    if (pop && pop.isConnected) return pop;
    if (getComputedStyle(chatRoot).position === 'static') {
      chatRoot.style.position = 'relative';
    }
    pop = document.createElement('div');
    pop.id = 'cmv-direct-storage-pop';

    const head = document.createElement('div');
    head.className = 'cmv-dsp-head';
    const title = document.createElement('span');
    title.textContent = '💬 채팅 저장소';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cmv-dsp-del';
    closeBtn.textContent = '✕';
    closeBtn.title = '닫기';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDirectStoragePop(false);
    });
    head.append(title, closeBtn);

    const list = document.createElement('div');
    list.id = 'cmv-dsp-list';
    list.className = 'cmv-dsp-list';

    const form = document.createElement('form');
    form.className = 'cmv-dsp-form';
    const input = document.createElement('input');
    input.className = 'cmv-dsp-input';
    input.type = 'text';
    input.placeholder = '자주 쓰는 문구 입력';
    input.maxLength = 100;
    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'cmv-dsp-add';
    addBtn.textContent = '추가';
    form.append(input, addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      if (!directStorageList.includes(val)) {
        directStorageList.push(val);
        saveDirectStorage();
        renderDirectStorageList();
      }
      input.value = '';
    });

    pop.append(head, list, form);
    chatRoot.appendChild(pop);
    renderDirectStorageList();
    return pop;
  }

  function toggleDirectStoragePop(show) {
    const root = findChatRoot();
    if (!root) return;
    const pop = ensureDirectStoragePop(root);
    const isOpen = typeof show === 'boolean' ? show : !pop.classList.contains('open');
    pop.classList.toggle('open', isOpen);
    const btn = document.getElementById(STORAGE_BTN_ID);
    if (btn) btn.style.color = isOpen ? '#00ffa3' : '';
    if (isOpen) renderDirectStorageList();
  }

  function ensureStorageButton() {
    const mission = findMissionButton();
    if (!mission) return;
    let btn = document.getElementById(STORAGE_BTN_ID);
    if (btn && btn.previousElementSibling === mission) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = STORAGE_BTN_ID;
      btn.type = 'button';
      btn.title = '채팅 저장소';
      btn.setAttribute('aria-label', '채팅 저장소');
      // 말풍선 + 줄 아이콘 (치지직 아이콘처럼 선 굵기 맞춤, 글자색 따라감)
      btn.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M6.5 5.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-3.5 3v-3h-1a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M8.5 9.5h7M8.5 12.5h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        '<span class="blind">채팅 저장소</span>';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (inMultiview) {
          try { window.parent.postMessage({ cmv: 1, type: 'CMV_TOGGLE_STORAGE' }, EXT_ORIGIN); } catch {}
        } else {
          toggleDirectStoragePop();
        }
      });
    }
    btn.className = mission.className; // 치지직 버튼과 같은 모양
    mission.after(btn);
  }
  setInterval(ensureStorageButton, 1500);
  // 저장소 창이 열려 있으면 버튼을 치지직 초록으로 (꺼지면 원래 회색)
  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || !e.data || e.data.cmv !== 1 || e.data.type !== 'CMV_STORAGE_STATE') return;
    const btn = document.getElementById(STORAGE_BTN_ID);
    if (btn) btn.style.color = e.data.open ? '#00ffa3' : '';
  });

  /* ---------------- 시작 ---------------- */
  function init() {
    applyCss();
    refreshPin();
    startObserver();
  }

  chrome.storage.local
    .get(['my-multiview:settings', LP_STORE_KEY])
    .then((o) => {
      readSettings(o);
      const cid = channelIdFromUrl();
      if (o && typeof o[LP_STORE_KEY] === 'string' && cid) {
        setChatClaimOn(o[LP_STORE_KEY].toLowerCase() === cid);
      }
      init();
    })
    .catch(() => init());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LP_STORE_KEY]) {
      const nextLp = String(changes[LP_STORE_KEY].newValue || '').toLowerCase();
      const cid = channelIdFromUrl();
      if (cid) setChatClaimOn(nextLp === cid);
    }
    if (!changes['my-multiview:settings']) return;
    chrome.storage.local
      .get('my-multiview:settings')
      .then((o) => {
        readSettings(o);
        applyCss();
        refreshPin();
        scanAllBlindRows();
        tryClaimChatLogPower();
      })
      .catch(() => {});
  });
})();

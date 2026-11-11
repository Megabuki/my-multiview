/**
 * My MultiView - 채팅 페이지 MAIN 월드 스크립트
 *
 * 1. WebSocket 패킷 패시브 수집 (클린봇 CBOT 원문 및 관리자 블라인드 이전 원문 보존)
 * 2. 채팅 시간 스탬프, 관리자/스트리머 역할(userRoleCode), 블라인드 원문 추출
 *    (3중 폴백: WebSocket 캐시 -> React Props/Fiber -> DOM 수신 시각/텍스트)
 * 3. 채팅 입력창 텍스트 자동 입력 (React _valueTracker 호환)
 */
(() => {
  if (window.top === window) return;

  const ROW_SELECTORS = [
    '[class*="live_chatting_list_item__"]',
    '[class*="chatting_list_item"]',
    '[class*="chat_item"]',
    '[data-chat-message]',
  ].join(',');

  // 주의: [class*="chatting_message"]는 상위 컨테이너(live_chatting_message_container)까지 매칭하므로 제외!
  const TEXT_SELECTORS = [
    '[class*="live_chatting_message_text"]',
    '[class*="chatting_message_text"]',
    '[class*="message_text"]',
  ].join(',');

  const NICK_SELECTORS = [
    '[class*="live_chatting_username_nickname"]',
    '[class*="live_chatting_message_nickname"]',
    '[class*="username_nickname"]',
    '[class*="nickname"]',
  ].join(',');

  const INPUT_SELECTORS = [
    'textarea[class*="live_chatting_input"]',
    'textarea[class*="chatting_input"]',
    'textarea[placeholder*="채팅"]',
    'textarea[placeholder*="메시지"]',
    '[contenteditable="true"][class*="chat"]',
    'textarea',
  ].join(',');

  const BLIND_PLACEHOLDER_RE =
    /클린봇이\s*부적절한|클린봇이\s*숨긴|클린봇이\s*감지|클린봇에\s*의해|메시지가\s*블라인드\s*처리|블라인드\s*처리되었습니다|관리자에\s*의해\s*블라인드|스트리머에\s*의해\s*블라인드|숨겨진\s*메시지입니다|차단된\s*사용자의\s*메시지/;

  const isBlindPlaceholder = (s) => {
    const t = String(s || '').trim();
    return !t || BLIND_PLACEHOLDER_RE.test(t);
  };

  const two = (n) => String(n).padStart(2, '0');
  const fmtTime = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;

  /* ---------------- 1. WebSocket 패킷 패시브 캐시 (클린봇/관리자 블라인드 원문 보존) ---------------- */
  const wsByNick = new Map(); // nickname -> [{ text, time, status, role }]
  const WS_PER_NICK_MAX = 25;
  // 메시지 하나를 정확히 찾기 위한 캐시: '사용자ID|보낸시각(ms)' -> 원문 (블라인드되기 전에 받아둔 것)
  const wsByKey = new Map();
  const WS_KEY_MAX = 4000;
  const msgKey = (uid, time) => `${uid}|${Number(time)}`;
  function rememberKey(uid, time, text) {
    if (!uid || !time || !text) return;
    const k = msgKey(uid, time);
    if (wsByKey.has(k)) return;
    wsByKey.set(k, text);
    if (wsByKey.size > WS_KEY_MAX) wsByKey.delete(wsByKey.keys().next().value);
  }

  const BOT_NICK_RE =
    /(?:^|\s|[_\-[\]()])(나이트\s*봇|night\s*bot|치지직\s*봇|chzzk\s*bot|안내\s*봇|공지\s*봇|명령어\s*봇|노래\s*봇|음악\s*봇|타이머\s*봇|스트리머\s*봇|클린\s*봇|삐부\s*봇|익명\s*봇|마법소녀\s*봇|시스템\s*봇|매니저\s*봇|챗봇|chatbot|moobot|streamelements|streamlabs|fossabot|wizebot)(?:$|\s|[_\-[\]()])|(?:봇|bot)$/i;

  function parseRoleFromMsg(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const prof = msg.profile || msg.user || msg.sender || {};
    const nick = String(prof.nickname || msg.nickname || '').trim();
    const role = String(
      prof.userRoleCode || msg.userRoleCode || prof.role || msg.role || '',
    ).toLowerCase();
    if (/streamer|broadcaster|owner/.test(role)) return 'streamer';
    if (/bot|system|auto/.test(role)) return 'bot';
    if (/manager|moderator|admin|staff|operator/.test(role)) return 'manager';
    if (prof.badge && typeof prof.badge === 'object') {
      const bTitle = String(prof.badge.title || prof.badge.name || prof.badge.badgeId || '').toLowerCase();
      if (/스트리머|방장|streamer/.test(bTitle)) return 'streamer';
      if (/봇|bot/.test(bTitle)) return 'bot';
      if (/관리자|매니저|운영자|manager|moderator/.test(bTitle)) return 'manager';
    }
    return null;
  }

  function recordWsChatItem(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') return;
    let prof = rawItem.profile;
    if (typeof prof === 'string') {
      try {
        prof = JSON.parse(prof);
      } catch {
        prof = {};
      }
    }
    prof = prof || {};

    const nick = String(prof.nickname || rawItem.nickname || '').trim();
    const rawText = String(rawItem.msg ?? rawItem.content ?? rawItem.message ?? '').trim();
    const status = String(
      rawItem.msgStatusType || rawItem.messageStatusType || rawItem.blindType || '',
    ).toUpperCase();
    const time = Number(rawItem.msgTime || rawItem.ctime || rawItem.createTime || rawItem.time) || Date.now();
    const role = parseRoleFromMsg({ ...rawItem, profile: prof });

    if (!rawText || isBlindPlaceholder(rawText)) return;
    rememberKey(String(rawItem.uid || prof.userIdHash || rawItem.userIdHash || ''), time, rawText);
    if (!nick) return;

    if (!wsByNick.has(nick)) wsByNick.set(nick, []);
    const arr = wsByNick.get(nick);
    // 중복 방지
    if (arr.some((x) => x.text === rawText && Math.abs(x.time - time) < 2000)) return;
    arr.push({
      text: rawText,
      time,
      status,
      role,
    });
    while (arr.length > WS_PER_NICK_MAX) arr.shift();
  }

  function handleWsPacket(dataStr) {
    if (typeof dataStr !== 'string' || !dataStr.startsWith('{')) return;
    try {
      const pkt = JSON.parse(dataStr);
      if (!pkt || typeof pkt !== 'object') return;
      const bdy = pkt.bdy;
      if (Array.isArray(bdy)) {
        for (const item of bdy) recordWsChatItem(item);
      } else if (bdy && typeof bdy === 'object') {
        const list = bdy.messageList || bdy.chatList || bdy.list;
        if (Array.isArray(list)) {
          for (const item of list) recordWsChatItem(item);
        }
      }
    } catch {}
  }

  try {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === 'function' && !NativeWebSocket.__cmvHooked) {
      let activeWsCount = 0;
      const ProxiedWebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget);
          try {
            ws.addEventListener('open', () => {
              activeWsCount++;
              if (document.documentElement) {
                document.documentElement.dataset.cmvWsState = 'open';
                document.documentElement.dataset.cmvWsOpenAt = String(Date.now());
              }
            });
            ws.addEventListener('message', (ev) => {
              if (document.documentElement) {
                document.documentElement.dataset.cmvLastMsgAt = String(Date.now());
              }
              if (ev && typeof ev.data === 'string') handleWsPacket(ev.data);
            });
            const handleCloseOrError = () => {
              activeWsCount = Math.max(0, activeWsCount - 1);
              if (activeWsCount === 0 && document.documentElement) {
                document.documentElement.dataset.cmvWsState = 'closed';
                document.documentElement.dataset.cmvWsClosedAt = String(Date.now());
              }
            };
            ws.addEventListener('close', handleCloseOrError);
            ws.addEventListener('error', handleCloseOrError);
          } catch {}
          return ws;
        },
      });
      ProxiedWebSocket.__cmvHooked = true;
      window.WebSocket = ProxiedWebSocket;
    }
  } catch {}

  /* ---------------- 2. React에서 시각, 권한(관리자/스트리머), 블라인드 원문 추출 ---------------- */
  function extractFromMsgObj(msg, out) {
    if (!msg || typeof msg !== 'object') return;
    let prof = msg.profile || msg.user || msg.sender;
    if (typeof prof === 'string') {
      try {
        prof = JSON.parse(prof);
      } catch {
        prof = {};
      }
    }
    if (prof && typeof prof === 'object') {
      if (!out.nick && typeof prof.nickname === 'string' && prof.nickname.trim()) {
        out.nick = prof.nickname.trim();
      }
    }
    if (!out.uid) {
      const uid = (prof && prof.userIdHash) || msg.userIdHash || msg.uid || msg.userId;
      if (typeof uid === 'string' && uid) out.uid = uid;
    }
    if (!out.tMs) {
      const t = Number(msg.messageTime ?? msg.msgTime ?? msg.time ?? msg.createTime ?? msg.ctime);
      if (Number.isFinite(t) && t > 1e12) out.tMs = t;
    }
    if (!out.role) {
      out.role = parseRoleFromMsg({ ...msg, profile: prof || {} });
    }
    const rawTime = msg.time ?? msg.messageTime ?? msg.msgTime ?? msg.createTime ?? msg.ctime ?? msg.timestamp;
    if (rawTime && !out.dt) {
      const d = new Date(rawTime);
      if (!Number.isNaN(d.getTime())) out.dt = d;
    }

    const status = String(
      msg.messageStatusType || msg.msgStatusType || msg.blindType || msg.status || '',
    ).toUpperCase();
    if (!out.blindType) {
      if (/CBOT|CLEAN|ABUSE/.test(status) || msg.isCleanbot || msg.cleanbot) {
        out.blindType = 'cleanbot';
      } else if (/BLIND|MANAGER|ADMIN|STREAMER|HIDE/.test(status) || msg.isBlind || msg.blind) {
        out.blindType = 'manager';
      }
    }

    const candidates = [
      msg.originContent,
      msg.originalMessage,
      msg.rawContent,
      msg.content,
      msg.msg,
      msg.message,
      msg.text,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && !isBlindPlaceholder(c)) {
        out.origText = c.trim();
        break;
      }
    }
  }

  function inspectPropsObject(p, out) {
    if (!p || typeof p !== 'object') return;
    const msgCandidates = [p.chatMessage, p.message, p.item, p.data, p.chat, p];
    for (const m of msgCandidates) {
      if (m && typeof m === 'object') extractFromMsgObj(m, out);
    }
  }

  function extractInfoFromReact(el) {
    const out = { dt: null, role: null, origText: null, blindType: null, nick: null, uid: null, tMs: null };
    const targets = [el, ...el.querySelectorAll('[class*="message"], [class*="blind"], [class*="text"]')].slice(0, 6);

    for (const node of targets) {
      try {
        for (const k of Object.keys(node)) {
          if (k.startsWith('__reactProps$')) {
            let p = node[k];
            for (let i = 0; i < 8 && p; i += 1) {
              inspectPropsObject(p, out);
              p = (p.children && p.children.props) || p.props || null;
            }
          }
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
            let fiber = node[k];
            for (let i = 0; i < 12 && fiber; i += 1) {
              inspectPropsObject(fiber.memoizedProps || fiber.pendingProps, out);
              if (fiber.memoizedState && typeof fiber.memoizedState === 'object') {
                inspectPropsObject(fiber.memoizedState, out);
              }
              fiber = fiber.return;
            }
          }
        }
      } catch {}
    }

    // DOM 닉네임 보조 추출
    if (!out.nick) {
      const nickEl = el.querySelector(NICK_SELECTORS);
      if (nickEl && nickEl.textContent) out.nick = nickEl.textContent.trim();
    }

    // 1순위: 사용자ID + 보낸 시각이 정확히 같은 메시지 (블라인드 전에 받아둔 원문)
    if (out.uid && out.tMs) {
      const exact = wsByKey.get(msgKey(out.uid, out.tMs));
      if (exact) out.origText = exact;
    }

    // 2순위: 같은 닉네임 + 보낸 시각이 거의 같은 메시지 (시각을 모르면 짐작하지 않음)
    if (out.nick && wsByNick.has(out.nick)) {
      const list = wsByNick.get(out.nick);
      if (list && list.length) {
        let matched = null;
        const tMs = out.tMs || (out.dt ? out.dt.getTime() : 0);
        if (tMs) matched = list.find((x) => Math.abs(x.time - tMs) < 2000);
        if (matched) {
          if (!out.origText && matched.text) out.origText = matched.text;
          if (!out.role && matched.role) out.role = matched.role;
          if (!out.blindType && /CBOT|CLEAN/.test(matched.status)) out.blindType = 'cleanbot';
        }
      }
    }

    return out;
  }

  function stamp(row, forceRescan = false) {
    if (!(row instanceof HTMLElement)) return;
    const textEl = row.querySelector(TEXT_SELECTORS) || row;
    if (!forceRescan && row.dataset.cmvScanned === '1' && textEl.dataset.cmvTime) return;
    row.dataset.cmvScanned = '1';

    const { dt, role, origText, blindType } = extractInfoFromReact(row);
    if (textEl && !textEl.dataset.cmvTime) {
      textEl.dataset.cmvTime = fmtTime(dt || new Date());
    }
    if (role && !row.dataset.cmvRole) {
      row.dataset.cmvRole = role;
    }
    if (origText && !row.dataset.cmvOrigText) {
      row.dataset.cmvOrigText = origText;
    }
    if (blindType && !row.dataset.cmvBlindType) {
      row.dataset.cmvBlindType = blindType;
    }
  }

  let queued = false;
  const scan = () => {
    queued = false;
    try {
      document.querySelectorAll(ROW_SELECTORS).forEach((r) => stamp(r, false));
    } catch {}
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  };

  function initObserver() {
    const root = document.documentElement || document.body;
    if (!root) {
      setTimeout(initObserver, 50);
      return;
    }
    new MutationObserver((muts) => {
      let found = false;
      for (const m of muts) {
        if (m.type === 'childList') {
          if (m.target instanceof HTMLElement) {
            const parentRow = m.target.closest(ROW_SELECTORS);
            if (parentRow) {
              stamp(parentRow, true);
              found = true;
            }
          }
          for (const n of m.addedNodes) {
            if (n instanceof HTMLElement) {
              if (n.matches(ROW_SELECTORS)) {
                stamp(n, false);
                found = true;
              } else if (n.querySelector && n.querySelector(ROW_SELECTORS)) {
                found = true;
              }
            }
          }
        }
      }
      if (found) queue();
    }).observe(root, {
      childList: true,
      subtree: true,
    });
    queue();
  }
  initObserver();

  /* ---------------- 3. 채팅 저장소 문구 입력창 자동 삽입 ----------------
   * 치지직 입력창은 textarea 일 때도, 글 편집 칸(contenteditable)일 때도 있어서
   * '채팅' 안내 문구가 붙은 입력칸을 찾고, 브라우저의 글자 넣기 명령으로 넣는다
   * (그래야 치지직이 직접 친 글자로 인식해서 전송 버튼이 켜짐).
   */
  function isUsable(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false;
    if (el.disabled || el.readOnly) return false;
    return true;
  }
  /** 화면에 보이는 채팅 입력칸. 숨겨진 보조 textarea 같은 건 건너뜀 */
  function findChatInput() {
    const cands = [
      ...document.querySelectorAll('textarea, input[type="text"], [contenteditable]:not([contenteditable="false"])'),
    ].filter(isUsable);
    if (!cands.length) return null;
    const hintOf = (el) =>
      [
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-placeholder'),
        el.parentElement && el.parentElement.textContent && el.parentElement.textContent.length < 60 ? el.parentElement.textContent : '',
      ].filter(Boolean).join(' ');
    const named = cands.find((el) => /채팅|메시지|message|chat/i.test(hintOf(el)));
    if (named) return named;
    // 이름표가 없으면: 화면 맨 아래쪽에 있는 입력칸 (채팅 입력칸은 항상 아래에 있음)
    return cands.sort((x, y) => y.getBoundingClientRect().top - x.getBoundingClientRect().top)[0];
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

  async function insertIntoChatInput(text) {
    const str = String(text || '');
    if (!str) return false;
    const el = findChatInput();
    if (!el) return false;
    try {
      window.focus();
      el.focus();
      const isField = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
      const before = isField ? el.value : el.textContent;
      // 커서를 맨 끝으로
      if (isField) {
        el.setSelectionRange(el.value.length, el.value.length);
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const piece = before && before.trim() ? ' ' + str : str;
      // 1순위: 직접 친 것처럼 넣기 (치지직 편집기가 한 박자 늦게 반영할 수 있어서 잠깐 기다렸다 확인)
      if (document.execCommand && document.execCommand('insertText', false, piece)) {
        await nextFrame();
        const after = isField ? el.value : el.textContent;
        if (after !== before) return true;
      }
      // 2순위: 값 직접 바꾸고 입력 이벤트 보내기
      if (isField) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const next = (before || '') + piece;
        if (el._valueTracker) el._valueTracker.setValue(before);
        if (desc && desc.set) desc.set.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.setSelectionRange(next.length, next.length);
        return true;
      }
      el.textContent = (before || '') + piece;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: piece }));
      return true;
    } catch {}
    return false;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__cmvMainCmd !== true) return;
    if (e.data.cmd === 'INSERT_CHAT') {
      insertIntoChatInput(e.data.text).then((ok) => {
        // 결과를 멀티뷰에 알려줌 (실패하면 멀티뷰가 '붙여넣기 해줘' 안내)
        try {
          const anc = location.ancestorOrigins;
          if (anc && anc.length) window.parent.postMessage({ cmv: 1, type: 'CMV_INSERT_RESULT', ok }, anc[0]);
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent('__cmv_insert_result', { detail: { ok } }));
        } catch {}
      });
    }
  });

  /* ---------------- 4. 단일 방 통나무 집중 보호 (비활성 채팅창의 log-power 가로채기 차단 + React 클릭 보조) ---------------- */
  let cachedLpBody = JSON.stringify({ code: 200, message: null, content: { amount: 0, claims: [] } });
  let initialLpFetched = false;
  const LP_URL_RE = /\/channels\/[0-9a-f]{32}\/log-power\b/i;

  function isLpActiveChat() {
    return document.documentElement && document.documentElement.dataset.cmvLpActive === '1';
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = async function (...args) {
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (LP_URL_RE.test(reqUrl)) {
          if (!isLpActiveChat() && initialLpFetched) {
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

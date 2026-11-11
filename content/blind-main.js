/**
 * My MultiView - 클린봇·관리자 블라인드 채팅 원문 보이기 (페이지 쪽 실행 환경)
 *
 * 치지직 채팅 줄은 React가 그리는데, 줄 요소의 React 값(chatMessage)에 원문과 보낸 사람·시각이 들어 있다.
 * 블라인드되면 화면 글자가 '클린봇이 부적절한 표현을 감지했습니다.' 같은 문구로 바뀌고,
 * React 값의 원문도 비워질 수 있어서 블라인드되기 전에 "보낸 사람|보낸 시각"으로 원문을 저장해 둔다.
 * (웹소켓으로 들어오는 채팅도 같은 방식으로 저장 — 처음부터 가려진 채 들어오는 클린봇 채팅 대비)
 * 가림 문구가 보이면 그 자리 글자를 원문으로 바꾸고 노란색 + (클린봇)/(블라인드) 표시를 붙인다.
 *
 * 켜고 끄기: chat.js 가 <html data-cmv-restore-blind="1|0"> 로 알려줌 (없으면 켬)
 */
(() => {
  if (window.top === window) return; // 직접 보기(최상위)는 standalone-blind.js가 처리
  // /chat URL로 제한하지 않음: 타일 안 인라인 채팅에서도 동작해야 함
  // (3-2에서 들어간 /chat 제한이 타일 쪽 복원을 막은 것으로 보임)

  if (window.__myMvBlind) return;
  window.__myMvBlind = true;
  document.documentElement.dataset.cmvBlindV2 = '1'; // chat.js 예전 복원 코드는 쉬게 함

  const PLACEHOLDER = /^(메시지가\s*블라인드\s*처리되었습니다\.?|클린봇이\s*부적절한\s*표현을\s*감지했습니다\.?)$/;
  const isPlaceholder = (s) => PLACEHOLDER.test(String(s || '').trim());
  const enabled = () => document.documentElement.dataset.cmvRestoreBlind !== '0';

  /* ---------------- 원문 저장소: '보낸사람|보낸시각(ms)' -> { text, emojis } ---------------- */
  const store = new Map();
  const STORE_MAX = 3000;
  function remember(key, text, emojis) {
    if (!key || !text || isPlaceholder(text) || store.has(key)) return;
    store.set(key, { text, emojis: emojis || {} });
    if (store.size > STORE_MAX) store.delete(store.keys().next().value);
  }
  const parseJson = (v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  /** 본문은 문자열이거나 조각 배열/객체일 수 있다 */
  function plainText(c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(plainText).join('');
    if (typeof c === 'object') return plainText(c.text ?? c.value ?? c.content ?? c.message ?? c.msg ?? '');
    return String(c);
  }
  function epochOf(m) {
    for (const v of [m.time, m.messageTime, m.msgTime, m.createTime, m.ctime, m.regTime, m.timestamp]) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 1e12) return n; // 실제 시각(ms)만. 영상 경과 시간은 제외
    }
    return 0;
  }
  function keyOf(m) {
    if (!m || typeof m !== 'object') return '';
    const prof = parseJson(m.profile) || {};
    const uid = m.uid || m.userIdHash || m.userId || m.senderId || prof.userIdHash || '';
    const t = epochOf(m);
    return uid && t ? `${uid}|${t}` : '';
  }
  function originalOf(m) {
    if (!m || typeof m !== 'object') return null;
    const type = m.msgTypeCode || m.messageTypeCode || 1;
    if (type === 30 || type === 11 || type === 12) return null; // 시스템/구독 알림 등
    const text = plainText(m.content) || plainText(m.msg);
    if (!text || isPlaceholder(text)) return null;
    const extras = parseJson(m.extras) || {};
    return { text, emojis: extras && typeof extras.emojis === 'object' && extras.emojis ? extras.emojis : {} };
  }

  /* ---------------- 웹소켓으로 들어오는 채팅도 저장 ---------------- */
  try {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string' || ev.data.charCodeAt(0) !== 123) return; // '{'
            let pkt;
            try { pkt = JSON.parse(ev.data); } catch { return; }
            const body = pkt && pkt.bdy;
            const list = Array.isArray(body) ? body : body && (body.messageList || body.chatList || body.list);
            if (!Array.isArray(list)) return;
            for (const m of list) {
              const o = originalOf(m);
              if (o) remember(keyOf(m), o.text, o.emojis);
            }
          });
        } catch {}
        return ws;
      },
    });
  } catch {}

  /* ---------------- 채팅 줄 찾기 ---------------- */
  // 라이브 페이지 및 팝업 채팅의 실제 채팅 메시지 줄 요소 매칭
  const ROW = '[class*="live_chatting_list_item"], [class*="vod_chatting_item"], [class*="chatting_item"], [class*="chat_item"], [class*="_item_"], [data-chat-message]';
  const MESSAGE = '[class*="_chatting_message_"], [class*="chatting_message"]';
  const NICKNAME = '[class*="_nickname_"], [class*="nickname"]';

  function reactKey(el, prefix) {
    for (const k in el) if (k.startsWith(prefix)) return el[k];
    return null;
  }
  function chatMessageOf(row) {
    const props = reactKey(row, '__reactProps$');
    const direct = props && props.children && props.children.props && props.children.props.chatMessage;
    if (direct && typeof direct === 'object') return direct;
    // 줄 요소 아래쪽으로 내려가며 chatMessage 를 가진 컴포넌트 찾기
    let fiber = reactKey(row, '__reactFiber$');
    for (let i = 0; fiber && i < 40; i += 1, fiber = fiber.child) {
      const p = fiber.memoizedProps;
      if (!p) continue;
      if (p.chatMessage && typeof p.chatMessage === 'object') return p.chatMessage;
      if (p.children && p.children.props && p.children.props.chatMessage) return p.children.props.chatMessage;
    }
    return null;
  }
  /** 닉네임 밖에 있는 본문 글자 요소 */
  function textSpanOf(row) {
    const msg = row.querySelector(MESSAGE) || row;
    for (const el of msg.querySelectorAll('[class*="_text_"], [class*="message_text"]')) {
      if (!el.closest(NICKNAME)) return el;
    }
    return null;
  }

  /* ---------------- 원문으로 바꾸기 ---------------- */
  const style = document.createElement('style');
  style.textContent = `
    .cmv-unblind { color: #fbbf24 !important; opacity: 1 !important; font-style: normal !important; }
    .cmv-unblind-tag { margin-left: 4px; color: #d6a419 !important; font-size: 0.85em; }
    .cmv-unblind img { width: 24px; height: 24px; vertical-align: middle; }
  `;
  (document.head || document.documentElement).appendChild(style);

  const done = new WeakMap(); // 글자 요소 -> 바꾼 횟수 (React가 되돌려도 무한 반복 안 하게)
  let writing = false;

  function render(span, original, placeholder) {
    const frag = document.createDocumentFragment();
    const re = /\{:([^:}]+):\}/g; // 이모티콘 표시 {:이름:}
    let last = 0;
    let m;
    while ((m = re.exec(original.text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(original.text.slice(last, m.index)));
      const url = original.emojis[m[1]];
      if (typeof url === 'string' && url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        frag.appendChild(img);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = re.lastIndex;
    }
    if (last < original.text.length) frag.appendChild(document.createTextNode(original.text.slice(last)));
    const tag = document.createElement('span');
    tag.className = 'cmv-unblind-tag';
    tag.textContent = /클린봇/.test(placeholder) ? '(클린봇)' : '(블라인드)';
    frag.appendChild(tag);
    writing = true;
    span.textContent = '';
    span.appendChild(frag);
    span.classList.add('cmv-unblind');
    span.title = placeholder.trim();
    queueMicrotask(() => { writing = false; });
  }

  /* ---------------- 관리자 · 봇 · 스트리머 채팅 알려주기 ----------------
   * 채팅 줄의 React 값에 있는 보낸 사람 권한(userRoleCode)으로 정확히 구분해서
   * 멀티뷰의 '관리자·봇' 모아보기 창으로 보낸다. (멀티뷰 오른쪽 채팅창일 때만)
   */
  const anc = location.ancestorOrigins;
  const viewOrigin = anc && anc.length && String(anc[0]).startsWith('chrome-extension://') ? anc[0] : '';
  function currentChannelId() {
    const m = location.pathname.match(/\/live\/([0-9a-f]{32})/i);
    return m ? m[1].toLowerCase() : '';
  }
  const BOT_NICK = /(봇|bot)$|나이트\s*봇|nightbot|치지직\s*봇|챗봇|chatbot|streamelements|streamlabs|fossabot|moobot|wizebot/i;
  const reported = new WeakSet();
  function roleOf(msg) {
    const prof = parseJson(msg.profile) || {};
    const code = String(prof.userRoleCode || msg.userRoleCode || '').toLowerCase();
    const nick = String(prof.nickname || '').trim();
    if (code === 'streamer') return 'streamer';
    if (/bot|system/.test(code)) return 'bot';
    if (/manager/.test(code)) return 'manager';
    return '';
  }
  function reportRole(row, msg) {
    const cid = currentChannelId();
    if (!cid || reported.has(row) || !msg) return;
    reported.add(row);
    const role = roleOf(msg);
    if (!role) return;
    const prof = parseJson(msg.profile) || {};
    const o = originalOf(msg);
    // 채팅창에 보이는 닉네임 글자색 그대로 (스트리머·관리자·봇마다 치지직이 정한 색)
    let color = '';
    const nickEl = row.querySelector('[class*="_nickname_"] [class*="_text_"]') || row.querySelector(NICKNAME);
    if (nickEl) color = getComputedStyle(nickEl).color || '';
    const text = o ? o.text.replace(/\{:[^:}]+:\}/g, '').trim() || '(이모티콘)' : '';
    if (!text) return;

    const payload = {
      cmv: 1, type: 'CMV_BADGE_CHAT', channelId: cid,
      nick: String(prof.nickname || '').trim(), text: text.slice(0, 500),
      role, badge: role === 'bot' ? 'manager' : role, at: epochOf(msg) || Date.now(), color,
    };

    if (viewOrigin) {
      try {
        window.parent.postMessage(payload, viewOrigin);
      } catch {}
    }
    try {
      window.dispatchEvent(new CustomEvent('__cmv_role_chat', { detail: payload }));
    } catch {}
  }

  function handleRow(row) {
    if (!(row instanceof HTMLElement) || !row.querySelector(MESSAGE)) return;
    const msg = chatMessageOf(row);
    reportRole(row, msg);
    const key = keyOf(msg);
    const span = textSpanOf(row);
    if (!span) return;
    const shown = (span.textContent || '').trim();

    if (!isPlaceholder(shown)) {
      // 아직 안 가려진 채팅: 원문 저장해 두기
      if (!span.classList.contains('cmv-unblind')) {
        const o = originalOf(msg);
        if (o) remember(key, o.text, o.emojis);
      }
      return;
    }
    if (!enabled()) return;
    const original = originalOf(msg) || store.get(key);
    if (!original) return;
    const n = done.get(span) || 0;
    if (n >= 5) return;
    done.set(span, n + 1);
    render(span, original, shown);
  }

  /* ---------------- 감시 ---------------- */
  let queued = false;
  const pending = new Set();
  function flush() {
    queued = false;
    for (const row of pending) handleRow(row);
    pending.clear();
  }
  function queue(row) {
    if (row) pending.add(row);
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  }
  function start() {
    const root = document.body || document.documentElement;
    new MutationObserver((muts) => {
      if (writing) return;
      for (const mu of muts) {
        const t = mu.target instanceof Element ? mu.target : mu.target.parentElement;
        const row = t && t.closest(ROW);
        if (row) queue(row);
        for (const n of mu.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches(ROW)) queue(n);
          else n.querySelectorAll && n.querySelectorAll(ROW).forEach((r) => queue(r));
        }
      }
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  // 놓친 줄 대비 안전망: 이미 화면에 있는 줄도 2초마다 다시 확인 (3-2에서 빠진 부분 복원)
  setInterval(() => {
    try {
      document.querySelectorAll(ROW).forEach((r) => queue(r));
    } catch {}
  }, 2000);
})();

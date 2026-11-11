/**
 * My MultiView - 치지직 직접 보기(standalone) 전용: 자주 쓰는 채팅 저장소 UI
 *
 * 멀티뷰 칸(iframe)에서는 동작하지 않는다. 치지직 라이브 페이지를 직접 열었을 때만 동작하는 별도 코드로,
 * chat.js와 공유하는 상태나 메시지가 없어서 이 파일에서 에러가 나도 멀티뷰에는 영향을 주지 않는다.
 *
 * 채팅창 맨 아래 줄(입력창 밑 '후원하기' 줄)에 말풍선 버튼을 달고, 누르면 저장된 문구 팝업이 뜬다.
 * 문구를 누르면 standalone-chat-main.js가 채팅 입력창에 넣어준다.
 * 저장소는 멀티뷰와 같은 저장소(my-multiview:chatStorage)를 써서 양쪽이 연동된다.
 */
(() => {
  if (window.top !== window) return; // 멀티뷰 칸(iframe)에서는 동작 안 함
  try {
    if (new URLSearchParams(location.search).get('cmv_page') === '1') return;
  } catch {}
  if (!/^\/live\/[0-9a-f]{32}/i.test(location.pathname)) return; // 라이브 메인 페이지에서만
  if (/\/live\/[^/]+\/chat/i.test(location.pathname)) return;
  if (window.__cmvStandaloneChat) return;
  window.__cmvStandaloneChat = true;

  const STORAGE_BTN_ID = 'cmv-storage-btn';

  const CSS = `
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
    }
  `;
  function applyCss() {
    let el = document.getElementById('cmv-sa-chat-css');
    if (!el) {
      el = document.createElement('style');
      el.id = 'cmv-sa-chat-css';
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== CSS) el.textContent = CSS;
  }
  applyCss();

  function findChatRoot() {
    return (
      document.querySelector('aside[class*="live_chatting"]') ||
      document.querySelector('[class*="live_chatting_container"]')
    );
  }

  /** 채팅창 맨 아래 줄(입력창 밑 '후원하기' 줄)의 '미션 후원' 버튼.
   *  위쪽 '진행 중인 미션' 배너 같은 다른 '미션' 버튼과 헷갈리지 않게, 화면 아래쪽에 있는 것만 본다. */
  function findMissionButton() {
    const ROW = '[class*="live_chatting_list_item__"], [class*="chatting_list_item"], [class*="chat_item"], [data-chat-message]';
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

  /* ---------------- 채팅 저장소 (멀티뷰와 같은 저장소 — 양쪽 연동) ---------------- */
  let directStorageList = [];
  function loadDirectStorage() {
    try {
      chrome.storage.local.get('my-multiview:settings').then((o) => {
        const s = (o && o['my-multiview:settings']) || {};
        try {
          const v = JSON.parse(s['my-multiview:chatStorage'] || '[]');
          if (Array.isArray(v)) directStorageList = v;
        } catch {}
        renderDirectStorageList();
      }).catch(() => {});
    } catch {}
  }
  loadDirectStorage();

  function saveDirectStorage() {
    try {
      chrome.storage.local.get('my-multiview:settings').then((o) => {
        const s = (o && o['my-multiview:settings']) || {};
        s['my-multiview:chatStorage'] = JSON.stringify(directStorageList);
        chrome.storage.local.set({ 'my-multiview:settings': s }).catch(() => {});
      }).catch(() => {});
    } catch {}
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
    try {
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
        btn.innerHTML =
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
          '<path d="M6.5 5.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-3.5 3v-3h-1a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M8.5 9.5h7M8.5 12.5h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
          '<span class="blind">채팅 저장소</span>';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleDirectStoragePop();
        });
      }
      btn.className = mission.className; // 치지직 버튼과 같은 모양
      mission.after(btn);
    } catch {}
  }
  setInterval(ensureStorageButton, 1500);

  // 멀티뷰 쪽에서 저장소를 바꾸면 여기도 다시 읽음
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['my-multiview:settings']) loadDirectStorage();
    });
  } catch {}
})();

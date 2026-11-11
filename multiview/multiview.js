/**
 * My MultiView - 멀티뷰 메인 화면 스크립트
 *
 *  - 칸 배치: 16:9 최적 자동 배치 및 고정 열 수(1~4열) 지원, 드래그로 순서 변경
 *  - 크게 보기: 큰 칸 중앙 배치 + 왼쪽 세로 목록(폭 조절 가능), 1개 방송일 때 전체 영역 활용
 *  - 오디오 제어: 칸별 음소거 버튼, 전체 음소거(M), 마우스 올린 방송만 소리 켜기(호버 오디오, H)
 *  - 채팅 패널: 방송 선택, 미리 불러오기, 채팅 저장소(클릭 시 입력창 자동 입력 + 복사), 배지 채팅 모아보기(현재/전체 방송 전환)
 *  - 로그인 연동: 치지직 로그인 상태 확인, 원클릭 로그인 탭 열기, 로그인 완료 시 채팅창 자동 갱신
 *  - 지연 시간 표시, 지연 줄이기, 기준 초과 시 자동 동기화, 전체 방송 싱크 맞추기(S)
 *  - 통나무: 갯수 표시, 방송 새로고침 없이 즉시 자동 획득 켜기/끄기
 *  - 실시간 설정 반영: 팝업에서 설정 변경 시 멀티뷰를 다시 열지 않아도 즉시 반영
 */
(() => {
  const {
    parseChannelId,
    isChannelId,
    fetchChannelName,
    rememberChannelName,
    fetchLiveInfo,
    favorites,
    settings,
    read,
    write,
    chatStorage,
  } = window.MyMV;

  const CHZZK = 'https://chzzk.naver.com';
  const STATE_KEY = 'my-multiview:state';
  const LP_KEY = 'my-multiview:lp';
  const SIDE_KEY = 'my-multiview:side';
  const GAP = 2;
  const RATIO = 16 / 9;
  const LIVE_POLL_MS = 45 * 1000;
  const FF_MARGIN_SEC = 0.6;

  const $ = (sel) => document.querySelector(sel);
  const grid = $('#grid');
  const gridWrap = $('#gridWrap');
  const mainEl = $('#main');
  const emptyEl = $('#emptyState');
  const chatPanel = $('#chatPanel');
  const chatSelect = $('#chatSelect');
  const chatFrame = $('#chatFrame');
  const splitter = $('#splitter');
  const template = $('#tileTemplate');

  const opts = {
    chatPosition: settings.chatPosition,
    chatTime: settings.chatTime,
    autoFf: settings.autoFf,
    autoFfSec: settings.autoFfSec,
    autoLp: settings.autoLp,
    hoverAudio: settings.hoverAudio,
    gridCols: settings.gridCols,
    alwaysShowBar: settings.alwaysShowBar,
  };

  const state = {
    order: [],
    tiles: new Map(),
    focus: null,
    chatOpen: false,
    chatId: null,
    hoverId: null,
    allMuted: false,
    loggedIn: false,
    nickname: '',
  };

  const LP_ENABLED_KEY = 'my-multiview:lp-enabled';

  let lpChannel = null;
  let lpEnabled = settings.autoLp;
  try {
    const raw = JSON.parse(read(LP_KEY) || 'null');
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (isChannelId(id)) {
      lpChannel = String(id).toLowerCase();
      lpEnabled = true;
    }
    const savedEnabled = read(LP_ENABLED_KEY);
    if (savedEnabled === '1') lpEnabled = true;
    else if (savedEnabled === '0') lpEnabled = false;
  } catch {}

  // 멀티뷰가 열려 있다는 표시 (따로 연 치지직 탭이 '통나무 수집 방 우선'을 적용할지 판단하는 데 사용)
  const VIEW_ALIVE_KEY = 'my-multiview:viewAlive';
  const markViewAlive = () => {
    try { chrome.storage.local.set({ [VIEW_ALIVE_KEY]: Date.now() }).catch(() => {}); } catch {}
  };
  markViewAlive();
  setInterval(markViewAlive, 30 * 1000);
  window.addEventListener('pagehide', () => {
    try { chrome.storage.local.set({ [VIEW_ALIVE_KEY]: 0 }).catch(() => {}); } catch {}
  });

  const saveLp = () => {
    write(LP_KEY, JSON.stringify(lpChannel));
    write(LP_ENABLED_KEY, lpEnabled ? '1' : '0');
    try {
      chrome.storage.local
        .set({
          [LP_KEY]: lpChannel || '',
          [LP_ENABLED_KEY]: lpEnabled ? '1' : '0',
        })
        .catch(() => {});
    } catch {}
  };
  saveLp();
  const claimsFor = (id) => lpChannel != null && lpChannel === String(id).toLowerCase();

  const liveUrl = (id) => `${CHZZK}/live/${id}?cmv_page=1${claimsFor(id) ? '&cmv_lp=1' : '&cmv_lp=0'}`;
  const chatUrl = (id) => {
    const q = [];
    if (opts.chatTime) q.push('ts=1');
    q.push(claimsFor(id) ? 'cmv_lp=1' : 'cmv_lp=0');
    return `${CHZZK}/live/${id}/chat?${q.join('&')}`;
  };
  const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;

  /* ---------------- 알림 토스트 ---------------- */
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  /* ---------------- 칸 및 채팅 iframe 통신 ---------------- */
  function post(tile, data) {
    if (!tile || !tile.frame || !tile.frame.contentWindow) return;
    const src = tile.frame.getAttribute('src') || tile.frame.src || '';
    if (!src || !src.startsWith(CHZZK)) return;
    try {
      tile.frame.contentWindow.postMessage({ cmv: 1, ...data }, CHZZK);
    } catch {}
  }

  function tileOfWindow(win) {
    for (const t of state.tiles.values()) {
      if (t.frame.contentWindow === win) return t;
    }
    if (chatFrame && chatFrame.contentWindow === win && state.chatId) {
      return state.tiles.get(state.chatId) || null;
    }
    for (const [cid, f] of chatFrames) {
      if (f && f.contentWindow === win) return state.tiles.get(cid) || null;
    }
    return null;
  }

  function activeChatWindow() {
    if (!state.chatId) return null;
    if (preload && chatFrames.has(state.chatId)) {
      return chatFrames.get(state.chatId).contentWindow;
    }
    return chatFrame.contentWindow;
  }

  function postToActiveChat(data) {
    try {
      const win = activeChatWindow();
      if (!win) return;
      const targetFrame = preload ? chatFrames.get(state.chatId) : chatFrame;
      const src = targetFrame ? targetFrame.getAttribute('src') || targetFrame.src || '' : '';
      if (!src || !src.startsWith(CHZZK)) return;
      win.postMessage({ cmv: 1, ...data }, CHZZK);
    } catch {}
  }

  /* ---------------- 상태 저장 ---------------- */
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local
        .set({
          [STATE_KEY]: {
            channels: [...state.order],
            chatOpen: state.chatOpen,
            chatChannelId: state.chatId,
            chatPosition: opts.chatPosition,
            focusId: state.focus,
          },
        })
        .catch(() => {});
    }, 300);
    try {
      const url = new URL(location.href);
      url.searchParams.delete('c');
      url.searchParams.delete('add'); // 팝업에서 넘겨준 '추가할 방송'은 한 번만 쓰고 지움
      for (const id of state.order) url.searchParams.append('c', id);
      history.replaceState(null, '', url);
    } catch {}
  }

  async function loadSaved() {
    try {
      const s = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
      if (!s || !Array.isArray(s.channels)) return null;
      return {
        channels: s.channels.filter(isChannelId),
        chatOpen: s.chatOpen === true,
        chatId: isChannelId(s.chatChannelId) ? s.chatChannelId : null,
        focus: isChannelId(s.focusId) ? s.focusId : null,
      };
    } catch {
      return null;
    }
  }

  /* ---------------- 스트리머 이름 반응형 2줄 배치 측정 ---------------- */
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');

  const textWidthCache = new Map();
  function measureTextPx(text) {
    const s = String(text || '');
    if (!measureCtx) return s.length * 13;
    let w = textWidthCache.get(s);
    if (w === undefined) {
      if (textWidthCache.size > 300) textWidthCache.clear();
      measureCtx.font = "600 14px -apple-system, 'Segoe UI', 'Noto Sans KR', sans-serif";
      w = Math.ceil(measureCtx.measureText(s).width);
      textWidthCache.set(s, w);
    }
    return w;
  }

  /**
   * 칸 상단 바에 버튼·통나무·지연시간 때문에 스트리머 이름이 다 안 들어가고 잘릴 경우,
   * .compact-name 클래스를 붙여 딜레이·통나무 바로 아래 왼쪽에 이름 길이만큼만(fit-content) 새 줄로 띄운다.
   */
  // 칸마다 그때그때 크기를 재면 화면 계산이 반복되므로, 한 프레임에 모아서 '전부 재고 → 전부 반영'
  const fitPending = new Set();
  let fitQueued = false;
  function checkTileNameFit(tile) {
    if (!tile || !tile.el || !tile.barEl) return;
    fitPending.add(tile);
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(flushNameFit);
  }

  function flushNameFit() {
    fitQueued = false;
    const tiles = [...fitPending].filter((t) => state.tiles.get(t.id) === t);
    fitPending.clear();
    const results = tiles.map(measureNameFit);
    tiles.forEach((t, i) => {
      if (results[i] !== null) t.el.classList.toggle('compact-name', results[i]);
    });
  }

  /** 이름을 둘째 줄로 내려야 하면 true, 아니면 false, 아직 크기를 알 수 없으면 null */
  function measureNameFit(tile) {
    const tileW = tile.el.clientWidth || parseFloat(tile.el.style.width) || 0;
    if (tileW <= 0) return null;

    const nameText = tile.nameEl.textContent || '';
    const viewersText = tile.viewersEls && tile.viewersEls[0] ? tile.viewersEls[0].textContent : '';
    const nameW = measureTextPx(nameText) + 12 + (viewersText ? viewersText.length * 7 + 16 : 0);

    let rightW = 20; // 좌우 패딩 및 기본 여백
    const rightItems = [
      tile.latencyEl,
      tile.badge,
      tile.el.querySelector('.ad-badge'),
      tile.el.querySelector('.login-badge'),
      tile.barEl.querySelector('.tile-btns'),
    ];
    for (const item of rightItems) {
      if (item && item.offsetWidth > 0) {
        rightW += item.offsetWidth + 6;
      }
    }

    return tileW < nameW + rightW;
  }

  function checkAllTileNamesFit() {
    for (const t of state.tiles.values()) checkTileNameFit(t);
  }

  function setTileName(tile, name) {
    if (!tile || !name) return;
    tile.nameEl.textContent = name;
    if (tile.nameSubEl) {
      const sub = tile.nameSubEl.querySelector('.sub-name');
      if (sub) sub.textContent = name;
      else tile.nameSubEl.textContent = name;
    }
    checkTileNameFit(tile);
  }

  /** 스트리머 이름 오른쪽 현재 시청자 수 (방송 꺼짐/모름이면 숨김) */
  function paintViewers(tile) {
    if (!tile || !tile.viewersEls) return;
    const show = tile.live !== 'CLOSE' && Number.isFinite(tile.viewers) && tile.viewers >= 0;
    const text = show ? tile.viewers.toLocaleString() : '';
    for (const v of tile.viewersEls) {
      if (v.textContent !== text) v.textContent = text;
    }
    checkTileNameFit(tile);
  }

  /* ---------------- 칸 만들기 ---------------- */
  function createTile(id) {
    const el = template.content.firstElementChild.cloneNode(true);
    el.dataset.channelId = id;
    const q = (s) => el.querySelector(s);
    const tile = {
      id,
      el,
      frame: q('.tile-frame'),
      barEl: q('.tile-bar'),
      nameEl: q('.tile-name'),
      nameSubEl: q('.tile-name-sub'),
      viewersEls: [...el.querySelectorAll('.tile-viewers')],
      latencyEl: q('.tile-latency'),
      badge: q('.lp-badge'),
      offlineEl: q('.offline'),
      muteBtn: null, // 칸별 음소거 버튼은 없앰 (전체 음소거는 아래 독에서)
      focusBtn: q('.tbtn.focus'),
      favBtn: q('.tbtn.fav'),
      lpBtn: q('.tbtn.lp'),
      latencyMs: NaN,
      lastFf: 0,
      live: null,
      liveId: null,
      lpOk: null,
      lpAmount: null,
      muted: false,
      viewers: -1,
    };

    setTileName(tile, id.slice(0, 8));
    fetchChannelName(id).then((name) => {
      if (!name) return;
      setTileName(tile, name);
      favorites.updateName(id, name);
      fillChatSelect();
    });

    const on = (sel, fn) =>
      q(sel).addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    on('.tbtn.ff', () => fastForward(tile));
    on('.tbtn.reload', () => reloadTile(tile));
    on('.tbtn.chat', () => openChat(id));
    on('.tbtn.focus', () => toggleFocus(id));
    on('.tbtn.popout', () => chrome.tabs.create({ url: `${CHZZK}/live/${id}` }));
    on('.tbtn.fav', () => toggleFavorite(tile));
    on('.tbtn.lp', () => toggleLp(tile));
    on('.tbtn.close', () => removeChannel(id));
    on('.sync-btn', () => syncAll());

    // 마우스 호버 오디오 처리
    el.addEventListener('mouseenter', () => {
      if (!opts.hoverAudio || state.focus != null) return;
      state.hoverId = id;
      applyHoverAudio();
    });

    // 드래그로 순서 변경 (상단 바 및 2번째 줄 이름 태그 모두 지원)
    const onDragStart = (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      el.classList.add('dragging');
      document.querySelectorAll('.tile').forEach((t) => t.classList.add('dragging-frame'));
    };
    const onDragEnd = () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.tile').forEach((t) => t.classList.remove('dragging-frame', 'drop-target'));
    };
    const bar = q('.tile-bar');
    bar.addEventListener('dragstart', onDragStart);
    bar.addEventListener('dragend', onDragEnd);
    if (tile.nameSubEl) {
      tile.nameSubEl.addEventListener('dragstart', onDragStart);
      tile.nameSubEl.addEventListener('dragend', onDragEnd);
    }
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain');
      if (from && from !== id) moveChannel(from, id);
    });

    paintFavorite(tile);
    paintLp(tile);
    paintTileMute(tile);
    state.tiles.set(id, tile);
    tile.frame.src = liveUrl(id);
    // 채팅은 미리 띄우지 않음: 오른쪽 채팅창에서 한 번이라도 열어본 방송만 계속 띄워 둠 (리소스 절약)
    checkLive(tile);
    return tile;
  }

  const reloadTile = (tile) => {
    tile.frame.src = liveUrl(tile.id);
  };

  function paintTileMute(tile) {
    if (!tile.muteBtn) return;
    tile.muteBtn.textContent = tile.muted ? '🔇' : '🔊';
    tile.muteBtn.classList.toggle('muted', !!tile.muted);
    tile.muteBtn.title = tile.muted ? '소리 켜기' : '음소거';
  }

  function mountTiles() {
    state.order.forEach((id, i) => {
      const tile = state.tiles.get(id) || createTile(id);
      if (tile.el.parentNode !== grid) grid.appendChild(tile.el);
      tile.el.style.order = String(i);
    });
    for (const [id, tile] of [...state.tiles]) {
      if (!state.order.includes(id)) {
        tile.el.remove();
        state.tiles.delete(id);
      }
    }
    const isEmpty = state.order.length === 0;
    emptyEl.classList.toggle('hidden', !isEmpty);
    if (isEmpty) renderEmptyFavs();
    layout();
    fillChatSelect();
    updateTitle();
  }

  function addChannel(id) {
    if (!isChannelId(id)) return false;
    const cleanId = id.toLowerCase();
    const existing = state.tiles.get(cleanId);
    if (existing) {
      existing.el.scrollIntoView({ block: 'nearest' });
      existing.el.classList.add('drop-target');
      setTimeout(() => existing.el.classList.remove('drop-target'), 800);
      return false;
    }
    state.order.push(cleanId);
    createTile(cleanId);
    mountTiles();
    checkLpAutoHandoff('addChannel');
    save();
    return true;
  }

  function removeChannel(id) {
    const i = state.order.indexOf(id);
    if (i < 0) return;
    state.order.splice(i, 1);
    const tile = state.tiles.get(id);
    if (tile) {
      tile.el.remove();
      state.tiles.delete(id);
    }
    if (lpChannel === id) {
      lpChannel = null;
      saveLp();
      checkLpAutoHandoff('removeChannel');
    }
    dropChatFrame(id);
    if (state.focus === id) setFocus(null);
    if (state.chatId === id) {
      state.chatId = state.order[0] || null;
      if (state.chatOpen && state.chatId) openChat(state.chatId);
      else closeChat();
    }
    mountTiles();
    broadcastLpState();
    save();
  }

  function moveChannel(fromId, toId) {
    const from = state.order.indexOf(fromId);
    const to = state.order.indexOf(toId);
    if (from < 0 || to < 0) return;
    state.order.splice(from, 1);
    state.order.splice(to, 0, fromId);
    mountTiles();
    save();
  }

  /* ---------------- 배치 (자동 최적 배치 + 고정 열 수 지원) ---------------- */
  function bestTileWidth(n, w, h, fixedCols = 0) {
    if (fixedCols > 0) {
      const cols = Math.min(n, fixedCols);
      const rows = Math.ceil(n / cols);
      const cellW = (w - (cols - 1) * GAP) / cols;
      const cellH = (h - (rows - 1) * GAP) / rows;
      let tw = cellW;
      let th = tw / RATIO;
      if (th > cellH) {
        th = cellH;
        tw = th * RATIO;
      }
      return Math.max(80, tw);
    }
    let best = 0;
    let bestArea = -1;
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const cellW = (w - (cols - 1) * GAP) / cols;
      const cellH = (h - (rows - 1) * GAP) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      let tw = cellW;
      let th = tw / RATIO;
      if (th > cellH) {
        th = cellH;
        tw = th * RATIO;
      }
      const area = tw * th;
      if (area > bestArea + 1) {
        bestArea = area;
        best = tw;
      }
    }
    return best;
  }

  let sideWidth = Number(read(SIDE_KEY)) || null;

  function layout() {
    splitter.style.display = 'none';
    grid.classList.remove('single-focus');
    if (!state.order.length) return;
    const box = gridWrap.getBoundingClientRect();

    if (state.focus && state.tiles.has(state.focus)) {
      for (const t of state.tiles.values()) t.el.style.width = '';
      const isSingle = state.order.length <= 1;
      grid.classList.toggle('single-focus', isSingle);

      const side = isSingle
        ? 0
        : Math.round(
            Math.max(
              160,
              Math.min(box.width * 0.6, sideWidth ?? Math.min(380, Math.max(220, box.width * 0.2))),
            ),
          );
      const listW = isSingle ? 0 : side + 14;
      const splitW = isSingle ? 0 : 6;
      const availW = box.width - listW - splitW - GAP * 2;
      const availH = box.height - GAP * 2;
      const bigW = Math.max(100, Math.min(availW, availH * RATIO));
      const bigH = bigW / RATIO;
      const areaLeft = box.left + listW + splitW + GAP;

      grid.style.setProperty('--side', side + 'px');
      grid.style.setProperty('--big-w', bigW + 'px');
      grid.style.setProperty('--big-x', areaLeft + (availW - bigW) / 2 + 'px');
      grid.style.setProperty('--big-y', box.top + GAP + (availH - bigH) / 2 + 'px');

      if (!isSingle) {
        splitter.style.left = box.left + listW + 'px';
        splitter.style.top = box.top + 'px';
        splitter.style.height = box.height + 'px';
        splitter.style.display = 'block';
      }
      checkAllTileNamesFit();
      return;
    }

    const w = Math.floor(
      bestTileWidth(
        state.order.length,
        Math.max(50, box.width - GAP * 2),
        Math.max(50, box.height - GAP * 2),
        opts.gridCols,
      ),
    );
    for (const id of state.order) {
      const t = state.tiles.get(id);
      if (t) t.el.style.width = w + 'px';
    }
    checkAllTileNamesFit();
  }

  // 창 크기 조절·경계선 끌기처럼 연속으로 들어오는 요청은 한 프레임에 한 번만 다시 배치
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }
  window.addEventListener('resize', scheduleLayout);

  // 크게 보기 왼쪽 목록 폭 조절
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    document.querySelectorAll('.tile').forEach((t) => t.classList.add('dragging-frame'));
    const move = (ev) => {
      const box = gridWrap.getBoundingClientRect();
      sideWidth = Math.round(Math.max(160, Math.min(box.width * 0.6, ev.clientX - box.left - 14)));
      scheduleLayout();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      document.querySelectorAll('.tile').forEach((t) => t.classList.remove('dragging-frame'));
      write(SIDE_KEY, String(sideWidth));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  /* ---------------- 크게 보기 & 호버 오디오 ---------------- */
  function setFocus(id) {
    state.focus = id && state.tiles.has(id) ? id : null;
    for (const [tid, t] of state.tiles) {
      const big = tid === state.focus;
      t.el.classList.toggle('focused', big);
      t.focusBtn.textContent = big ? '◰' : '◱';
      t.focusBtn.title = big ? '전체 보기' : '크게 보기';
    }
    grid.classList.toggle('focus-mode', state.focus != null);
    layout();
    save();
    for (const t of state.tiles.values()) sendFocusState(t);
    if (state.focus && state.chatOpen) openChat(state.focus);
  }
  const toggleFocus = (id) => setFocus(state.focus === id ? null : id);

  function sendFocusState(tile) {
    if (state.focus != null) {
      tile.el.classList.remove('audio-hover');
      post(tile, { type: 'CMV_AUDIO', muted: tile.id !== state.focus });
      post(tile, { type: 'CMV_UI', minimal: tile.id !== state.focus });
    } else if (opts.hoverAudio && state.hoverId && state.tiles.has(state.hoverId)) {
      post(tile, { type: 'CMV_UI', minimal: false });
      tile.el.classList.toggle('audio-hover', tile.id === state.hoverId);
      post(tile, { type: 'CMV_AUDIO', muted: tile.id !== state.hoverId });
    } else {
      tile.el.classList.remove('audio-hover');
      post(tile, { type: 'CMV_AUDIO_RESTORE' });
      post(tile, { type: 'CMV_UI', minimal: false });
    }
  }

  function applyHoverAudio() {
    $('#dockHoverAudioBtn').classList.toggle('active', opts.hoverAudio);
    if (!opts.hoverAudio) {
      state.hoverId = null;
    } else if (!state.hoverId && state.order.length) {
      state.hoverId = state.order[0];
    }
    for (const t of state.tiles.values()) sendFocusState(t);
  }

  /* ---------------- 전체 음소거 on/off ----------------
   * 켜기: 지금 소리가 켜져 있던 방송들을 기억해 두고 모두 음소거
   * 끄기: 음소거 전에 소리가 켜져 있던 방송만 다시 소리 켜기 (원래 꺼져 있던 방송은 그대로 음소거)
   * 전체 음소거 중에 사용자가 어느 방송 하나의 소리를 직접 켜면 버튼은 자동으로 해제 상태로 돌아간다.
   */
  const MUTE_ALL_KEY = 'my-multiview:muteAll';
  let muteRestoreIds = [];
  try {
    const v = JSON.parse(read(MUTE_ALL_KEY) || 'null');
    if (v && v.on) {
      state.allMuted = true;
      muteRestoreIds = Array.isArray(v.restore) ? v.restore.filter(isChannelId) : [];
    }
  } catch {}

  function saveMuteAll() {
    write(MUTE_ALL_KEY, JSON.stringify({ on: state.allMuted, restore: state.allMuted ? muteRestoreIds : [] }));
  }

  function paintMuteAll() {
    const btn = $('#dockMuteAllBtn');
    if (!btn) return;
    btn.textContent = state.allMuted ? '🔇 음소거 ON' : '🔊 음소거 OFF';
    btn.title = state.allMuted
      ? '음소거 해제: 음소거 전에 소리가 켜져 있던 방송만 다시 켜기 (단축키: M)'
      : '전체 음소거 (단축키: M)';
    btn.classList.toggle('active', state.allMuted);
  }

  function toggleMuteAll() {
    if (!state.allMuted) {
      muteRestoreIds = [...state.tiles.values()].filter((t) => !t.muted).map((t) => t.id);
      state.allMuted = true;
      for (const t of state.tiles.values()) {
        t.muted = true;
        post(t, { type: 'CMV_TOGGLE_MUTE', muted: true });
      }
      toast('모든 방송 음소거');
    } else {
      state.allMuted = false;
      // 기억해 둔 방송이 하나도 없으면(모두 꺼져 있던 상태에서 음소거했다면) 전부 소리 켜기
      const restore = new Set(muteRestoreIds.filter((id) => state.tiles.has(id)));
      const all = restore.size === 0;
      for (const t of state.tiles.values()) {
        if (all || restore.has(t.id)) {
          t.muted = false;
          post(t, { type: 'CMV_TOGGLE_MUTE', muted: false });
        }
      }
      muteRestoreIds = [];
      toast(all ? '모든 방송 소리 켜기' : `음소거 전 소리가 켜져 있던 방송 ${restore.size}개 소리 복원`);
    }
    saveMuteAll();
    paintMuteAll();
  }

  /** 전체 음소거 중 사용자가 칸 안에서 직접 소리를 켜면 음소거 버튼 해제 */
  function onTileAudioState(tile, d) {
    tile.muted = !!d.muted;
    if (state.allMuted && d.user && !d.muted) {
      state.allMuted = false;
      muteRestoreIds = [];
      saveMuteAll();
      paintMuteAll();
    }
  }

  /* ---------------- 채팅 패널 ---------------- */
  let preload = settings.chatPreload;
  const chatFrames = new Map();

  const chatBody = $('#chatBody') || chatPanel;

  function ensureChatFrame(id) {
    if (!preload || chatFrames.has(id)) return;
    const f = document.createElement('iframe');
    f.className = 'chat-frame';
    f.title = '치지직 채팅';
    f.src = chatUrl(id);
    chatBody.appendChild(f);
    chatFrames.set(id, f);
  }

  function dropChatFrame(id) {
    const f = chatFrames.get(id);
    if (f) {
      f.remove();
      chatFrames.delete(id);
    }
  }

  function reloadChatFrame(id) {
    if (!id) return false;
    const cleanId = id.toLowerCase();
    let reloaded = false;
    if (preload && chatFrames.has(cleanId)) {
      const f = chatFrames.get(cleanId);
      if (f) {
        f.src = chatUrl(cleanId);
        reloaded = true;
      }
    }
    if (state.chatId === cleanId && chatFrame) {
      chatFrame.src = chatUrl(cleanId);
      reloaded = true;
    }
    return reloaded;
  }

  function reloadAllChatFrames() {
    if (preload) {
      for (const [cid, f] of chatFrames) {
        f.src = chatUrl(cid);
      }
    } else if (state.chatOpen && state.chatId) {
      chatFrame.src = chatUrl(state.chatId);
    }
  }

  function showChatFrame(id) {
    if (preload) {
      ensureChatFrame(id);
      chatFrame.style.display = 'none';
      chatFrame.src = 'about:blank';
      for (const [cid, f] of chatFrames) f.classList.toggle('active', cid === id);
    } else {
      chatFrame.style.display = '';
      if (chatFrame.src !== chatUrl(id)) chatFrame.src = chatUrl(id);
    }
  }

  function fillChatSelect() {
    const keep = chatSelect.value;
    chatSelect.textContent = '';
    for (const id of state.order) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (state.tiles.get(id) && state.tiles.get(id).nameEl.textContent) || id.slice(0, 8);
      chatSelect.appendChild(o);
    }
    if (state.chatId && state.order.includes(state.chatId)) chatSelect.value = state.chatId;
    else if (keep && state.order.includes(keep)) chatSelect.value = keep;
  }

  function openChat(id) {
    const targetId = id || state.chatId || state.order[0];
    if (!targetId || !state.tiles.has(targetId)) {
      closeChat();
      return;
    }
    state.chatId = targetId;
    state.chatOpen = true;
    chatSelect.value = targetId;
    showChatFrame(targetId);
    if (typeof syncMvMgrChatUI === 'function') syncMvMgrChatUI();
    chatPanel.classList.remove('hidden');
    mainEl.classList.toggle('chat-left', opts.chatPosition === 'left');
    mainEl.classList.toggle('chat-right', opts.chatPosition !== 'left');
    $('#dockChatBtn').classList.add('active');
    layout();
    save();
  }

  function closeChat() {
    state.chatOpen = false;
    chatPanel.classList.add('hidden');
    if (!preload) chatFrame.src = 'about:blank';
    $('#dockChatBtn').classList.remove('active');
    layout();
    save();
  }

  function toggleChatPanel() {
    if (state.chatOpen) closeChat();
    else if (state.order.length) openChat(state.focus || state.chatId || state.order[0]);
    else toast('먼저 방송을 추가해주세요');
  }

  function setPreload(on) {
    if (on === preload) return;
    preload = on;
    if (!on) {
      for (const id of [...chatFrames.keys()]) dropChatFrame(id);
    }
    if (state.chatOpen && state.chatId) showChatFrame(state.chatId);
  }

  chatSelect.addEventListener('change', () => openChat(chatSelect.value || null));
  $('#chatCloseBtn').addEventListener('click', closeChat);
  $('#chatPopoutBtn').addEventListener('click', () => {
    if (state.chatId) chrome.tabs.create({ url: `${CHZZK}/live/${state.chatId}/chat` });
  });

  /* ---------------- 치지직 로그인 연동 상태 및 버튼 ---------------- */
  const chatLoginBtn = $('#chatLoginBtn');
  const mvAuthStatusText = $('#mvAuthStatusText');

  function paintAuthStatus(auth) {
    const ok = !!(auth && auth.loggedIn);
    state.loggedIn = ok;
    state.nickname = (auth && auth.nickname) || '';
    if (chatLoginBtn) {
      chatLoginBtn.classList.toggle('hidden', ok);
      chatLoginBtn.textContent = '로그인';
      chatLoginBtn.title = '치지직 로그인이 필요합니다 · 클릭하면 로그인 창 열기';
    }
    if (mvAuthStatusText) {
      mvAuthStatusText.textContent = ok
        ? `🟢 ${state.nickname || '로그인 연동됨'}`
        : '🔴 치지직 비로그인 상태';
    }
  }

  function refreshAuthStatus() {
    chrome.runtime.sendMessage({ type: 'mv:check-auth' }, (resp) => {
      void chrome.runtime.lastError;
      if (resp && resp.auth) paintAuthStatus(resp.auth);
    });
  }

  function handleLoginAction() {
    if (state.loggedIn) {
      toast('치지직 쿠키 및 채팅 세션 동기화 중…');
      chrome.runtime.sendMessage({ type: 'mv:sync-cookies' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.auth) paintAuthStatus(resp.auth);
        reloadAllChatFrames();
        toast('채팅 로그인 세션 갱신 완료');
      });
    } else {
      chrome.runtime.sendMessage({ type: 'mv:open-login' }, () => void chrome.runtime.lastError);
      toast('새 탭에서 네이버 로그인 후 돌아오면 자동 연동됩니다');
    }
  }

  chatLoginBtn.addEventListener('click', handleLoginAction);
  $('#mvSyncCookieBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'mv:sync-cookies' }, (resp) => {
      void chrome.runtime.lastError;
      if (resp && resp.auth) paintAuthStatus(resp.auth);
      reloadAllChatFrames();
      toast('쿠키 재동기화 및 채팅 새로고침 완료');
    });
  });

  /* ---------------- 즐겨찾기 & 팔로우 목록 렌더링 (채팅 패널 ＋ & 빈 화면 공용) ---------------- */
  function renderFavListInto(box, onUpdate) {
    if (!box) return;
    box.textContent = '';

    // 1. 생방송 중인 팔로우 채널
    if (window.MyMV && typeof MyMV.fetchFollowings === 'function') {
      const followSec = document.createElement('div');
      followSec.className = 'add-follow-sec';
      box.appendChild(followSec);
      MyMV.fetchFollowings(false).then((res) => {
        if (!res || !res.ok || !Array.isArray(res.list)) return;
        const liveFollows = res.list.filter((ch) => ch.status === 'OPEN' && !state.tiles.has(ch.id));
        if (!liveFollows.length) return;
        followSec.textContent = '';
        const fTitle = document.createElement('div');
        fTitle.className = 'add-favs-title';
        const fLabel = document.createElement('span');
        fLabel.textContent = `🔴 생방송 중인 팔로우 (${liveFollows.length})`;
        fTitle.appendChild(fLabel);
        if (liveFollows.length > 1) {
          const fAll = document.createElement('button');
          fAll.type = 'button';
          fAll.className = 'add-all';
          fAll.textContent = '전체 추가';
          fAll.title = '생방송 팔로우 전체 추가';
          fAll.addEventListener('click', () => {
            for (const ch of liveFollows) addChannel(ch.id);
            if (onUpdate) onUpdate();
          });
          fTitle.appendChild(fAll);
        }
        followSec.appendChild(fTitle);
        for (const ch of liveFollows) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'add-fav add-follow-item';
          b.textContent = '🔴 ' + (ch.name || ch.id.slice(0, 8));
          b.title = ch.title ? `${ch.name}: ${ch.title}` : ch.name;
          b.addEventListener('click', () => {
            addChannel(ch.id);
            if (onUpdate) onUpdate();
          });
          followSec.appendChild(b);
        }
      }).catch(() => {});
    }

    const blocks = favorites
      .grouped()
      .map((b) => ({ group: b.group, items: b.items.filter((f) => !state.tiles.has(f.id)) }))
      .filter((b) => b.items.length);
    const anyGroup = blocks.some((b) => b.group);
    for (const blk of blocks) {
      const title = document.createElement('div');
      title.className = 'add-favs-title';
      const label = document.createElement('span');
      label.textContent = blk.group || (anyGroup ? '그룹 없음' : '즐겨찾기');
      title.appendChild(label);
      if (blk.items.length > 1) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'add-all';
        all.textContent = '전체 추가';
        all.title = '그룹 전체 추가';
        all.addEventListener('click', () => {
          for (const f of blk.items) addChannel(f.id);
          if (onUpdate) onUpdate();
        });
        title.appendChild(all);
      }
      box.appendChild(title);
      for (const f of blk.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'add-fav';
        b.textContent = '★ ' + favorites.label(f);
        b.title = f.id;
        b.addEventListener('click', () => {
          addChannel(f.id);
          if (onUpdate) onUpdate();
        });
        box.appendChild(b);
      }
    }
  }

  function renderAddFavs() {
    renderFavListInto($('#addFavs'), renderAddFavs);
  }
  function renderDockAddFavs() {
    renderFavListInto($('#dockAddFavs'), renderDockAddFavs);
  }
  function renderEmptyFavs() {
    renderFavListInto($('#emptyFavs'), renderEmptyFavs);
  }

  /* ---------------- 방송 추가 팝업 (채팅창 상단 & 우측 하단 도구막대 상단) & 빈 화면 추가 폼 ---------------- */
  const addPop = $('#addPop');
  const addInput = $('#addInput');
  const addErr = $('#addErr');
  const dockAddPop = $('#dockAddPop');
  const dockAddInput = $('#dockAddInput');
  const dockAddErr = $('#dockAddErr');

  function toggleAddPop(show) {
    const open = show ?? addPop.classList.contains('hidden');
    addPop.classList.toggle('hidden', !open);
    if (open) {
      addErr.textContent = '';
      renderAddFavs();
      addInput.focus();
      toggleDockAddPop(false);
      toggleChatSettings(false);
      toggleStoragePop(false);
      toggleBadgePanel(false);
    }
  }

  function toggleDockAddPop(show) {
    if (!dockAddPop) return;
    const open = show ?? dockAddPop.classList.contains('hidden');
    dockAddPop.classList.toggle('hidden', !open);
    $('#dockAddBtn').classList.toggle('active', open);
    const qd = $('#quickDock');
    if (qd) qd.classList.toggle('pop-open', open);
    if (open) {
      dockAddErr.textContent = '';
      renderDockAddFavs();
      dockAddInput.focus();
      toggleAddPop(false);
    }
  }

  $('#chatAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddPop();
  });

  function handleChannelFormSubmit(inputEl, errEl, onAdded) {
    const lines = inputEl.value.split(/[\s,]+/).filter(Boolean);
    const ids = lines.map(parseChannelId).filter(Boolean);
    if (!ids.length) {
      errEl.textContent = '채널 ID나 치지직 주소를 못 찾았어요.';
      inputEl.select();
      return;
    }
    let added = 0;
    for (const id of ids) if (addChannel(id)) added += 1;
    errEl.textContent = added ? '' : '이미 열려 있는 방송이에요.';
    if (added) {
      inputEl.value = '';
      if (onAdded) onAdded(added);
      toast(`방송 ${added}개 추가`);
    }
  }

  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleChannelFormSubmit(addInput, addErr, () => toggleAddPop(false));
  });

  $('#dockAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleChannelFormSubmit(dockAddInput, dockAddErr, () => toggleDockAddPop(false));
  });

  $('#emptyAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleChannelFormSubmit($('#emptyAddInput'), $('#emptyAddErr'));
  });

  document.addEventListener('click', (e) => {
    if (!addPop.classList.contains('hidden') && !e.target.closest('#addPop, #chatAddBtn')) {
      toggleAddPop(false);
    }
    if (dockAddPop && !dockAddPop.classList.contains('hidden') && !e.target.closest('#dockAddPop, #dockAddBtn')) {
      toggleDockAddPop(false);
    }
  });

  /* ---------------- 빠른 설정 팝업 ---------------- */
  const chatSettingsPop = $('#chatSettingsPop');
  const mvChatPosLeft = $('#mvChatPosLeft');
  const mvChatPosRight = $('#mvChatPosRight');
  const mvChatTimeBox = $('#mvChatTimeBox');
  const mvChatPreloadBox = $('#mvChatPreloadBox');
  const mvRestoreBlindBox = $('#mvRestoreBlindBox');
  const mvHoverAudioBox = $('#mvHoverAudioBox');

  function syncChatSettingsUI() {
    (opts.chatPosition === 'left' ? mvChatPosLeft : mvChatPosRight).checked = true;
    mvChatTimeBox.checked = opts.chatTime;
    mvChatPreloadBox.checked = preload;
    if (mvRestoreBlindBox) mvRestoreBlindBox.checked = settings.chatRestoreBlind;
    if (mvHoverAudioBox) mvHoverAudioBox.checked = opts.hoverAudio;
  }

  function toggleChatSettings(show) {
    const open = show ?? chatSettingsPop.classList.contains('hidden');
    if (open) {
      syncChatSettingsUI();
      refreshAuthStatus();
    }
    chatSettingsPop.classList.toggle('hidden', !open);
    if (open) {
      toggleAddPop(false);
      toggleStoragePop(false);
      toggleBadgePanel(false);
    }
  }

  $('#chatSettingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatSettings();
  });
  document.addEventListener('click', (e) => {
    if (!chatSettingsPop.classList.contains('hidden') && !e.target.closest('#chatSettingsPop, #chatSettingsBtn')) {
      toggleChatSettings(false);
    }
  });

  const onChatPos = () => {
    const v = mvChatPosLeft.checked ? 'left' : 'right';
    settings.chatPosition = v;
    opts.chatPosition = v;
    if (state.chatOpen) {
      mainEl.classList.toggle('chat-left', v === 'left');
      mainEl.classList.toggle('chat-right', v !== 'left');
      layout();
      save();
    }
  };
  mvChatPosLeft.addEventListener('change', onChatPos);
  mvChatPosRight.addEventListener('change', onChatPos);

  mvChatTimeBox.addEventListener('change', () => {
    settings.chatTime = mvChatTimeBox.checked;
    opts.chatTime = mvChatTimeBox.checked;
    // chat.js가 storage 변경을 감지해 새로고침 없이 즉시 타임스탬프 CSS를 토글함
  });

  mvChatPreloadBox.addEventListener('change', () => {
    settings.chatPreload = mvChatPreloadBox.checked;
    setPreload(mvChatPreloadBox.checked);
  });

  if (mvRestoreBlindBox) {
    mvRestoreBlindBox.addEventListener('change', () => {
      settings.chatRestoreBlind = mvRestoreBlindBox.checked;
    });
  }

  if (mvHoverAudioBox) {
    mvHoverAudioBox.addEventListener('change', () => {
      settings.hoverAudio = mvHoverAudioBox.checked;
      opts.hoverAudio = mvHoverAudioBox.checked;
      applyHoverAudio();
    });
  }

  /* ---------------- 채팅 저장소 (클릭 시 입력창 자동 삽입 + 복사) ---------------- */
  const chatStoragePop = $('#chatStoragePop');
  const storageInput = $('#storageInput');
  const storageList = $('#storageList');

  function renderStorage() {
    const list = chatStorage.list();
    storageList.innerHTML = '';
    if (!list.length) {
      storageList.innerHTML = '<div class="storage-empty">저장된 채팅이 없어요</div>';
      return;
    }
    for (const text of list) {
      const item = document.createElement('div');
      item.className = 'storage-item';
      item.title = '클릭하면 복사';
      const span = document.createElement('span');
      span.textContent = text;
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '삭제';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        chatStorage.remove(text);
        renderStorage();
      });
      item.append(span, del);
      item.addEventListener('click', async () => {
        // 누르면 복사만 (채팅창에 Ctrl+V로 붙여넣기)
        try {
          await navigator.clipboard.writeText(text);
          toast('복사됨 · 채팅창에 Ctrl+V');
          toggleStoragePop(false);
        } catch {
          toast('복사에 실패했어요');
        }
      });
      storageList.appendChild(item);
    }
  }

  // 실수로 지우지 않게: '삭제'를 눌러야 ✕ 버튼이 보임
  const storageEditBtn = $('#storageEditBtn');
  function setStorageEdit(on) {
    chatStoragePop.classList.toggle('editing', on);
    if (storageEditBtn) {
      storageEditBtn.classList.toggle('on', on);
      storageEditBtn.textContent = on ? '완료' : '삭제';
    }
  }
  if (storageEditBtn) {
    storageEditBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setStorageEdit(!chatStoragePop.classList.contains('editing'));
    });
  }

  let insertPending = null;
  let storageSource = null;
  let insertTimer = 0;
  async function onInsertResult(ok) {
    clearTimeout(insertTimer);
    const text = insertPending;
    insertPending = null;
    if (text == null) return;
    if (ok) {
      toast('채팅창에 입력됨');
      toggleStoragePop(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('입력칸을 못 찾아서 복사해 뒀어요 (Ctrl+V)');
    } catch {
      toast('채팅창 입력에 실패했어요');
    }
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== CHZZK || !e.data || e.data.cmv !== 1 || e.data.type !== 'CMV_INSERT_RESULT') return;
    onInsertResult(!!e.data.ok);
  });

  function toggleStoragePop(show) {
    const open = show ?? chatStoragePop.classList.contains('hidden');
    if (!open) setStorageEdit(false); // 닫으면 삭제 모드 끔
    if (open) renderStorage();
    chatStoragePop.classList.toggle('hidden', !open);
    if (open) {
      toggleAddPop(false);
      toggleChatSettings(false);
      toggleBadgePanel(false);
    }
  }

  $('#chatStorageBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStoragePop();
  });
  // 버튼에 연결된 창이 열려 있으면 버튼을 켜진 색(치지직 초록)으로
  const POP_BUTTONS = [['#addPop', '#chatAddBtn'], ['#chatSettingsPop', '#chatSettingsBtn'], ['#chatStoragePop', null]];
  for (const [popSel, btnSel] of POP_BUTTONS) {
    const pop = $(popSel);
    if (!pop) continue;
    const sync = () => {
      const open = !pop.classList.contains('hidden');
      if (btnSel && $(btnSel)) $(btnSel).classList.toggle('on', open);
      if (popSel === '#chatStoragePop') {
        // 저장소 버튼은 채팅창(iframe) 안에 있어서 켜짐 상태를 알려줌
        document.querySelectorAll('#chatFrame, .chat-frame').forEach((f) => {
          if (!String(f.getAttribute('src') || '').startsWith(CHZZK)) return; // 비어 있는 채팅칸은 건너뜀
          try { f.contentWindow && f.contentWindow.postMessage({ cmv: 1, type: 'CMV_STORAGE_STATE', open }, CHZZK); } catch {}
        });
      }
    };
    new MutationObserver(sync).observe(pop, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  // 채팅창 맨 아래(미션 후원 옆) 저장소 버튼에서 오는 신호
  window.addEventListener('message', (e) => {
    if (e.origin !== CHZZK || !e.data || e.data.cmv !== 1 || e.data.type !== 'CMV_TOGGLE_STORAGE') return;
    storageSource = e.source; // 저장소 버튼을 누른 그 채팅창에 글자를 넣음
    toggleStoragePop();
  });
  $('#storageAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (chatStorage.add(storageInput.value)) {
      storageInput.value = '';
      renderStorage();
    }
  });
  document.addEventListener('click', (e) => {
    if (!chatStoragePop.classList.contains('hidden') && !e.target.closest('#chatStoragePop, #chatStorageBtn')) {
      toggleStoragePop(false);
    }
  });

  /* ---------------- 즐겨찾기 토글 ---------------- */
  function paintFavorite(tile) {
    const on = favorites.has(tile.id);
    tile.favBtn.classList.toggle('active', on);
    tile.favBtn.textContent = on ? '★' : '☆';
  }

  function toggleFavorite(tile) {
    if (favorites.has(tile.id)) favorites.remove(tile.id);
    else {
      const name = tile.nameEl.textContent;
      favorites.add(tile.id, name && name !== tile.id.slice(0, 8) ? name : '');
    }
    paintFavorite(tile);
  }

  /* ---------------- 통나무 (새로고침 없는 무중단 토글) ---------------- */
  function postToChatFrame(frame, msg) {
    if (!frame || !frame.contentWindow) return;
    const src = frame.getAttribute('src') || '';
    if (!src.startsWith(CHZZK)) return;
    try {
      frame.contentWindow.postMessage({ cmv: 1, ...msg }, CHZZK);
    } catch {}
  }

  function broadcastLpState() {
    for (const t of state.tiles.values()) {
      paintLp(t);
      post(t, { type: 'CMV_SET_LP', on: claimsFor(t.id) });
    }
    if (preload) {
      for (const [cid, f] of chatFrames) {
        postToChatFrame(f, { type: 'CMV_SET_LP', on: claimsFor(cid) });
      }
    } else if (state.chatOpen && state.chatId) {
      postToChatFrame(chatFrame, { type: 'CMV_SET_LP', on: claimsFor(state.chatId) });
    }
  }

  /**
   * 통나무 자동 수집 인계/시작 관리:
   * 1. 사용자가 통나무 자동 수집을 켜둔 경우(lpEnabled === true)에만 동작.
   * 2. 현재 통나무 수집 중인 방송(curTile)이 여전히 생방송 중(OPEN)이라면,
   *    다른 방송이 몇 개가 추가로 켜지든(1->2, 2->3...) 절대 옮기지 않고 기존 방 유지.
   * 3. 현재 수집 중인 방송이 방송 종료(CLOSE)되었거나 없는 상태이고,
   *    생방송 중인 다른 방이 있다면 -> 가장 앞 순서(state.order 기준 첫 번째)의 생방송으로 이동!
   * 4. 모든 방송이 종료되어 생방송이 0개였다가, 누군가 방송을 켜서 생방송이 0개 -> 1개 이상이 되는 순간
   *    -> 그 방송(가장 앞 생방송)으로 통나무 자동 수집을 즉시 시작!
   */
  function checkLpAutoHandoff(reason = '') {
    if (!lpEnabled) return;

    // 현재 열려 있는 타일 중 실제로 생방송 중인 타일 목록 (state.order 순서 보존)
    const liveTiles = state.order
      .map((id) => state.tiles.get(id))
      .filter((t) => t && t.live === 'OPEN');

    const curTile = lpChannel ? state.tiles.get(lpChannel) : null;
    const curIsLive = !!(curTile && curTile.live === 'OPEN');

    // 이미 유효한 생방송에서 수집 중인 경우: 다른 방송이 새로 켜져도 절대 옮기지 않고 유지!
    if (curIsLive) {
      return;
    }

    // 현재 수집 중인 방이 없거나 종료(CLOSE)된 경우:
    if (liveTiles.length > 0) {
      const nextTile = liveTiles[0];
      if (lpChannel !== nextTile.id) {
        const prevId = lpChannel;
        const prevTile = prevId ? state.tiles.get(prevId) : null;
        const prevName = prevTile ? prevTile.nameEl.textContent : '';
        const nextName = nextTile.nameEl.textContent || nextTile.id.slice(0, 8);

        lpChannel = nextTile.id;
        saveLp();
        broadcastLpState();

        if (reason === 'offline' || (prevTile && prevTile.live === 'CLOSE')) {
          toast(`🪵 ${prevName ? prevName + ' 방송 종료 · ' : ''}${nextName} 방송으로 통나무 자동 수집 이동`);
        } else {
          toast(`🪵 ${nextName} 생방송 시작 · 통나무 자동 수집 시작`);
        }
      }
    } else {
      // 생방송 중인 방이 0개인 경우 (모든 방송 종료 대기)
      broadcastLpState();
    }
  }

  function paintLp(tile) {
    const on = claimsFor(tile.id);
    const live = tile.live !== 'CLOSE';
    tile.lpBtn.classList.toggle('on', on);
    tile.lpBtn.title = on ? '통나무 자동 획득 끄기 (이 방에서만 단독 작동 중)' : '통나무 자동 획득 켜기 (단 하나의 방에서만 작동)';
    const amount = typeof tile.lpAmount === 'number' ? ' ' + tile.lpAmount.toLocaleString() : '';
    const gained = on && typeof tile.lpGained === 'number' && tile.lpGained > 0 ? ` (+${tile.lpGained.toLocaleString()})` : '';
    const b = tile.badge;
    if (tile.lpOk === false) {
      b.className = 'lp-badge err';
      b.textContent = '🪵 확인 실패';
    } else if (tile.lpOk === true) {
      b.className = 'lp-badge' + (on && live ? ' ok' : '');
      b.textContent = on ? (live ? '🪵 작동 중' + amount + gained : '🪵 대기 중' + amount) : '🪵' + amount;
    } else {
      b.className = 'lp-badge';
      b.textContent = on ? (live ? '🪵 작동 중' : '🪵 대기 중') : '🪵 확인 중';
    }
    checkTileNameFit(tile);
  }

  function toggleLp(tile) {
    if (claimsFor(tile.id)) {
      lpChannel = null;
      lpEnabled = false;
      saveLp();
      broadcastLpState();
      toast('통나무 자동 획득 끔');
      return;
    }
    lpChannel = tile.id;
    lpEnabled = true;
    saveLp();
    broadcastLpState();
    toast('이 방송 통나무 자동 획득 켬 (5분 자동 수집 + 1시간 보상 단독 작동)');
  }

  function onLpStatus(tile, d) {
    const time = new Date(d.at || Date.now()).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    tile.lpOk = !!d.ok;
    let delta = 0;
    if (d.ok && typeof d.amount === 'number') {
      if (typeof tile.lpAmount === 'number' && d.amount > tile.lpAmount) {
        delta = d.amount - tile.lpAmount;
        tile.lpGained = (tile.lpGained || 0) + delta;
        tile.lastLpGainAt = time;
      }
      tile.lpAmount = d.amount;
    }
    if (d.claimed && delta >= 100) {
      toast(`🪵 ${tile.nameEl.textContent || '방송'} 통나무 +${delta} 자동 수령 완료!`);
    } else if (d.claimed && typeof d.amount !== 'number') {
      post(tile, { type: 'CMV_CHECK_LP' });
    }
    const gainInfo = tile.lpGained ? ` · 누적 +${tile.lpGained.toLocaleString()} (최근 ${tile.lastLpGainAt})` : '';
    const loginInfo =
      tile.loggedIn === true
        ? ` · 이 칸 로그인됨${tile.loginNick ? ` (${tile.loginNick})` : ''}`
        : tile.loggedIn === false
          ? ' · 이 칸 로그아웃 상태!'
          : '';
    tile.badge.title = d.ok
      ? `마지막 확인 ${time}` + (d.claimed || delta > 0 ? ' · 방금 획득!' : '') + gainInfo + loginInfo
      : `확인 실패 ${time} · 로그인 상태를 확인하세요` + loginInfo;
    paintLp(tile);
  }

  /* ---------------- 지연 시간 및 싱크 ---------------- */
  function fastForward(tile) {
    tile.lastFf = Date.now();
    post(tile, { type: 'CMV_FF', marginSec: FF_MARGIN_SEC });
  }

  function onLatency(tile, ms) {
    if (!Number.isFinite(ms)) return;
    tile.latencyMs = ms;
    // 매초 들어오는 값이라, 글자가 실제로 바뀔 때만 화면을 고치고 글자 수가 달라질 때만 이름 배치를 다시 잼
    const text = fmtSec(ms);
    const prevText = tile.latencyEl.textContent;
    if (prevText !== text) {
      tile.latencyEl.textContent = text;
      tile.latencyEl.title = `지연 시간 ${text}`;
      if (prevText.length !== text.length) checkTileNameFit(tile);
    }
    const over = ms / 1000 > opts.autoFfSec;
    if (tile.latencyOver !== over) {
      tile.latencyOver = over;
      tile.latencyEl.classList.toggle('warn', over);
    }
    if (opts.autoFf && over && Date.now() - tile.lastFf > 10000) fastForward(tile);
  }

  function syncAll() {
    const list = [...state.tiles.values()].filter((t) => t.live !== 'CLOSE' && t.latencyMs > 0);
    if (list.length < 2) {
      toast('지연 시간이 확인된 생방송이 2개 이상 있어야 합니다');
      return;
    }
    const target = Math.max(...list.map((t) => t.latencyMs)) + 150;
    for (const t of list) post(t, { type: 'CMV_SYNC', targetMs: target });
    toast(`지연 ${(target / 1000).toFixed(1)}초로 맞춤 (${list.length}개 방송)`);
  }

  /* ---------------- 방송 꺼짐 / 켜짐 (다중 API 폴백) ---------------- */
  async function checkLive(tile) {
    const info = await fetchLiveInfo(tile.id, 10000);
    if (!state.tiles.has(tile.id)) return;
    if (info.name && tile.nameEl.textContent === tile.id.slice(0, 8)) {
      setTileName(tile, info.name);
      fillChatSelect();
    }
    const s = info.status;
    if (s == null) return;
    const before = tile.live;
    tile.live = s;
    tile.offlineEl.classList.toggle('hidden', s !== 'CLOSE');
    if (before !== s) paintLp(tile);
    if (typeof info.viewers === 'number' && info.viewers >= 0) {
      tile.viewers = info.viewers;
      tile.viewersApiAt = Date.now();
    }
    paintViewers(tile);

    const prevLiveId = tile.liveId;
    if (info.liveId) tile.liveId = info.liveId;
    const sessionChanged = !!(prevLiveId && info.liveId && prevLiveId !== info.liveId);

    if ((before === 'CLOSE' && s === 'OPEN') || sessionChanged) {
      reloadTile(tile);
      reloadChatFrame(tile.id);
      toast(`${tile.nameEl.textContent} 방송 시작 · 화면 및 채팅 자동 재연결`);
    }
    checkLpAutoHandoff(s === 'CLOSE' ? 'offline' : 'online');
  }
  setInterval(() => {
    for (const t of state.tiles.values()) checkLive(t);
  }, LIVE_POLL_MS);

  /* ---------------- 칸 및 채팅에서 오는 신호 ---------------- */
  window.addEventListener('message', (e) => {
    if (e.origin !== CHZZK || !e.data || !e.data.cmv) return;
    const d = e.data;
    if (d.type === 'CMV_BADGE_CHAT' && d.channelId) {
      onBadgeChat(d);
      return;
    }
    if (d.type === 'CMV_LOGIN_OPENED') {
      toast('새 탭에서 네이버 로그인 후 돌아오면 자동 연동됩니다');
      return;
    }
    const tile = tileOfWindow(e.source) || (d.channelId ? state.tiles.get(String(d.channelId).toLowerCase()) : null);
    if (!tile) return;

    if (d.type === 'CMV_FRAME_READY') {
      sendFocusState(tile);
      // 전체 음소거 중에 새로 열리거나 새로고침된 칸도 음소거 유지
      if (state.allMuted) {
        post(tile, { type: 'CMV_TOGGLE_MUTE', muted: true });
        // 칸이 저장된 소리 설정을 늦게 읽어와 덮어쓰는 경우 대비 한 번 더
        setTimeout(() => {
          if (state.allMuted && state.tiles.get(tile.id) === tile) post(tile, { type: 'CMV_TOGGLE_MUTE', muted: true });
        }, 2500);
      }
      post(tile, { type: 'CMV_SET_LP', on: claimsFor(tile.id) });
    } else if (d.type === 'CMV_LIVE_STATUS') {
      const s = d.status === 'CLOSE' ? 'CLOSE' : d.status === 'OPEN' ? 'OPEN' : null;
      if (s && tile.live !== s) {
        const before = tile.live;
        tile.live = s;
        tile.offlineEl.classList.toggle('hidden', s !== 'CLOSE');
        paintLp(tile);
        paintViewers(tile);
        if (before === 'CLOSE' && s === 'OPEN') {
          reloadTile(tile);
          reloadChatFrame(tile.id);
          toast(`${tile.nameEl.textContent} 방송 시작 · 화면 및 채팅 자동 재연결`);
        }
        checkLpAutoHandoff(s === 'CLOSE' ? 'offline' : 'online');
      }
    } else if (d.type === 'CMV_REQ_CHAT_RECONNECT') {
      if (d.channelId) {
        reloadChatFrame(d.channelId);
      }
    } else if (d.type === 'CMV_LATENCY') {
      onLatency(tile, Number(d.ms));
    } else if (d.type === 'CMV_LP_STATUS') {
      onLpStatus(tile, d);
    } else if (d.type === 'CMV_AUDIO_STATE') {
      onTileAudioState(tile, d);
      paintTileMute(tile);
    } else if (d.type === 'CMV_VIEWERS') {
      const n = Number(d.viewers);
      // API 값이 최근(2분 이내)에 있으면 API 값을 우선, 없을 때만 칸 페이지에서 읽은 값 사용
      if (Number.isFinite(n) && n >= 0 && !(tile.viewersApiAt && Date.now() - tile.viewersApiAt < 120000)) {
        tile.viewers = n;
        paintViewers(tile);
        updateTitle();
      }
    } else if (d.type === 'CMV_META') {
      if (d.name && typeof d.name === 'string') {
        rememberChannelName(tile.id, d.name);
        if (tile.nameEl.textContent === tile.id.slice(0, 8)) {
          setTileName(tile, d.name);
          favorites.updateName(tile.id, d.name);
          fillChatSelect();
        }
      }
    } else if (d.type === 'CMV_LOGIN') {
      tile.loggedIn = !!d.loggedIn;
      tile.loginNick = String(d.nickname || '');
      paintLoginBadge(tile);
    } else if (d.type === 'CMV_AD_STATUS') {
      tile.adPlaying = !!d.ad;
      paintAdBadge(tile);
    }
  });

  function paintAdBadge(tile) {
    let badge = tile.el.querySelector('.ad-badge');
    if (tile.adPlaying) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ad-badge';
        badge.textContent = '광고 음소거 중';
        badge.title = '광고가 끝나면 자동으로 음소거 해제됩니다';
        tile.barEl.insertBefore(badge, tile.barEl.querySelector('.tile-btns'));
      }
    } else if (badge) {
      badge.remove();
    }
    checkTileNameFit(tile);
  }

  /** 칸 안 치지직 로그인이 풀려 있으면 상단 바에 빨간 '로그아웃' 표시 (로그인 상태면 표시 없음) */
  function paintLoginBadge(tile) {
    let badge = tile.el.querySelector('.login-badge');
    if (tile.loggedIn === false) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'login-badge';
        badge.textContent = '로그아웃';
        badge.title =
          '이 칸은 치지직 로그인이 안 되어 있어요 (통나무가 쌓이지 않아요). 채팅 설정의 "쿠키 연동"을 누른 뒤 이 칸을 새로고침(↻)해 보세요.';
        tile.barEl.insertBefore(badge, tile.barEl.querySelector('.tile-btns'));
      }
    } else if (badge) {
      badge.remove();
    }
    if (tile.loggedIn === true) {
      tile.el.dataset.loginNick = tile.loginNick || '';
    }
    checkTileNameFit(tile);
  }

  // 탭 제목은 항상 'My MultiView' (시청자 수 표시 기능은 없앰)
  function updateTitle() {
    if (document.title !== 'My MultiView') document.title = 'My MultiView';
  }

  /* ---------------- 관리자 · 봇 채팅 모아보기 팝업 ('채팅' 글씨 왼쪽 버튼) & 배지 채팅 모아보기 ---------------- */
  const BOT_NICK_RE =
    /(?:^|\s|[_\-[\]()])(나이트\s*봇|night\s*bot|치지직\s*봇|chzzk\s*bot|안내\s*봇|공지\s*봇|명령어\s*봇|노래\s*봇|음악\s*봇|타이머\s*봇|스트리머\s*봇|클린\s*봇|삐부\s*봇|익명\s*봇|마법소녀\s*봇|시스템\s*봇|매니저\s*봇|챗봇|chatbot|moobot|streamelements|streamlabs|fossabot|wizebot)(?:$|\s|[_\-[\]()])|(?:봇|bot)$/i;

  const mgrChatsByChannel = new Map(); // channelId -> [{ role, nick, text, at }]
  const MGR_CHAT_MAX = 1000; // 방송당 보관 개수 (오래된 것부터 지움)
  const MGR_CHANNEL_MAX = 30; // 기록을 보관할 방송 수 (지금 열려 있는 방송 우선, 그다음 최근 채팅 순)
  const MGR_STORE_KEY = 'my-multiview:mgrChats'; // 크롬을 껐다 켜도 남게 확장 저장소에 보관
  const MGR_ROLES_KEY = 'my-multiview:mgrRoles'; // 모을 채팅 종류 (체크박스)

  // 봇은 관리자 권한으로 채팅하므로 '관리자'에 포함 (봇 체크박스 없음)
  let mgrRoles = new Set(['manager', 'streamer']);
  try {
    const v = JSON.parse(read(MGR_ROLES_KEY) || 'null');
    if (Array.isArray(v)) mgrRoles = new Set(v.filter((r) => r !== 'bot'));
  } catch {}

  let mgrSaveTimer = 0;
  function saveMgrChats() {
    clearTimeout(mgrSaveTimer);
    mgrSaveTimer = setTimeout(() => {
      // 저장 공간이 가득 차면 다른 저장(방송 목록 등)까지 실패하므로, 오래 안 본 방송의 기록부터 정리
      const kept = [...mgrChatsByChannel].filter(([, arr]) => arr.length);
      if (kept.length > MGR_CHANNEL_MAX) {
        const lastAt = (arr) => arr[arr.length - 1].at || 0;
        kept.sort(
          (a, b) => Number(state.tiles.has(b[0])) - Number(state.tiles.has(a[0])) || lastAt(b[1]) - lastAt(a[1]),
        );
        for (const [cid] of kept.slice(MGR_CHANNEL_MAX)) mgrChatsByChannel.delete(cid);
      }
      const obj = {};
      for (const [cid, arr] of mgrChatsByChannel) if (arr.length) obj[cid] = arr;
      chrome.storage.local.set({ [MGR_STORE_KEY]: obj }).catch(() => {});
    }, 1500);
  }
  chrome.storage.local.get(MGR_STORE_KEY).then((o) => {
    const obj = (o && o[MGR_STORE_KEY]) || {};
    for (const [cid, arr] of Object.entries(obj)) {
      if (!Array.isArray(arr)) continue;
      const cur = mgrChatsByChannel.get(cid) || [];
      mgrChatsByChannel.set(cid, arr.concat(cur).slice(-MGR_CHAT_MAX)); // 저장된 것 뒤에 새로 온 것
    }
    syncMvMgrChatUI();
  }).catch(() => {});
  const mvMgrChatBtn = $('#mvMgrChatBtn');
  const mvMgrChatCnt = $('#mvMgrChatCnt');
  const mvMgrChatPopup = $('#mvMgrChatPopup');
  const mvMgrChatList = $('#mvMgrChatList');

  function classifyMgrRole(d, cid) {
    const nick = String(d.nick || '').trim();
    const rawRole = String(d.role || d.badge || '').toLowerCase();
    if (rawRole === 'bot') return 'manager';
    if (rawRole === 'streamer') return 'streamer';
    const tile = state.tiles.get(cid);
    if (tile && tile.nameEl && nick && nick === tile.nameEl.textContent.trim()) return 'streamer';
    if (rawRole === 'manager') return 'manager';
    return null;
  }

  function mgrRoleLabel(role) {
    if (role === 'streamer') return '👑 스트리머';
    return '🛡️ 관리자';
  }

  /** parent를 주면(목록 전체를 다시 그릴 때) 거기에만 붙이고, 스크롤은 호출한 쪽에서 한 번만 내림 */
  function appendMvMgrItemDOM(item, parent = null) {
    if (!mvMgrChatList) return;
    if (!parent) {
      const emptyEl = mvMgrChatList.querySelector('.mv-mgr-chat-empty');
      if (emptyEl) emptyEl.remove();
    }

    const div = document.createElement('div');
    div.className = `mv-mgr-item ${item.role}`;

    const time = document.createElement('span');
    time.className = 'mv-mgr-time';
    const dt = new Date(item.at);
    time.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

    const tag = document.createElement('span');
    tag.className = `mv-mgr-tag ${item.role}`;
    tag.textContent = mgrRoleLabel(item.role);

    const nick = document.createElement('span');
    nick.className = 'mv-mgr-nick';
    // 채팅창 닉네임 색 그대로 쓰되, 어두운 배경에서 안 보이는 어두운 색이면 기본 색(밝은 글씨) 사용
    if (item.color && isReadableNickColor(item.color)) nick.style.color = item.color;
    nick.textContent = item.nick;

    const body = document.createElement('span');
    body.textContent = item.text;

    div.append(time, tag, nick, body);
    if (parent) {
      parent.appendChild(div);
      return;
    }
    mvMgrChatList.appendChild(div);
    mvMgrChatList.scrollTop = mvMgrChatList.scrollHeight;
  }

  /** 어두운 모아보기 배경(#1f2023)에서 읽을 수 있을 만큼 밝은 색인지 (상대 밝기 기준) */
  function isReadableNickColor(c) {
    let r, g, b, a = 1;
    const str = String(c).trim();
    let m = str.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
    if (m) {
      [r, g, b] = [m[1], m[2], m[3]].map(Number);
      if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
    } else if ((m = str.match(/^#([0-9a-f]{3,8})$/i))) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((x) => x + x).join('');
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else {
      return false;
    }
    if (a < 0.6) return false;
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const bgL = 0.0144; // #1f2023
    return (L + 0.05) / (bgL + 0.05) >= 4;
  }

  /* 안 읽은 표시: 방송마다 '마지막으로 확인한 채팅 시각'을 기억해 두고, 그 뒤에 온 것만 숫자로 셈.
   * 창을 열어서 보면 확인한 것으로 치고 숫자를 숨김. */
  const MGR_SEEN_KEY = 'my-multiview:mgrSeen';
  let mgrSeen = {};
  try { mgrSeen = JSON.parse(read(MGR_SEEN_KEY) || '{}') || {}; } catch {}
  const mgrPopupOpen = () => !!mvMgrChatPopup && !mvMgrChatPopup.classList.contains('hidden');
  function shownMgrChats() {
    // 예전에 '봇'으로 저장된 채팅도 관리자로 취급
    return ((state.chatId && mgrChatsByChannel.get(state.chatId)) || []).filter((x) =>
      mgrRoles.has(x.role === 'bot' ? 'manager' : x.role),
    );
  }
  function paintMgrBadge() {
    if (!mvMgrChatCnt || !mvMgrChatBtn) return;
    const cid = state.chatId;
    const arr = shownMgrChats();
    if (cid && mgrPopupOpen() && arr.length) {
      const newest = Math.max(...arr.map((x) => x.at || 0));
      if (newest > (mgrSeen[cid] || 0)) {
        mgrSeen[cid] = newest;
        write(MGR_SEEN_KEY, JSON.stringify(mgrSeen));
      }
    }
    const seen = (cid && mgrSeen[cid]) || 0;
    const unread = arr.filter((x) => (x.at || 0) > seen).length;
    mvMgrChatCnt.textContent = unread > 99 ? '99+' : String(unread);
    mvMgrChatCnt.style.display = unread ? '' : 'none';
    mvMgrChatBtn.classList.toggle('unread', unread > 0);
  }

  function syncMvMgrChatUI() {
    if (!mvMgrChatCnt || !mvMgrChatList) return;
    const arr = shownMgrChats();
    paintMgrBadge();
    mvMgrChatList.textContent = '';
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'mv-mgr-chat-empty';
      empty.textContent = mgrRoles.size ? '아직 모인 채팅이 없습니다.' : '모을 채팅 종류를 하나 이상 체크해 주세요.';
      mvMgrChatList.appendChild(empty);
      return;
    }
    // 최대 1000줄을 한 줄씩 붙이며 매번 스크롤하면 느리므로, 한꺼번에 붙이고 스크롤은 한 번만
    const frag = document.createDocumentFragment();
    for (const item of arr) {
      appendMvMgrItemDOM(item, frag);
    }
    mvMgrChatList.appendChild(frag);
    mvMgrChatList.scrollTop = mvMgrChatList.scrollHeight;
  }

  function toggleMvMgrPopup(force) {
    if (!mvMgrChatPopup || !mvMgrChatBtn) return;
    const open = typeof force === 'boolean' ? force : mvMgrChatPopup.classList.contains('hidden');
    mvMgrChatPopup.classList.toggle('hidden', !open);
    mvMgrChatBtn.classList.toggle('on', open);
    if (open) syncMvMgrChatUI();
    else paintMgrBadge();
  }

  if (mvMgrChatBtn) {
    mvMgrChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMvMgrPopup();
    });
  }
  if ($('#mvMgrCloseBtn')) {
    $('#mvMgrCloseBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMvMgrPopup(false);
    });
  }
  // 글자 크기 (가− / 가+)
  const MGR_FS_KEY = 'my-multiview:mgrFontSize';
  let mgrFontSize = Math.min(20, Math.max(10, Number(read(MGR_FS_KEY)) || 13));
  function applyMgrFontSize() {
    if (mvMgrChatPopup) mvMgrChatPopup.style.setProperty('--mgr-fs', mgrFontSize + 'px');
    const label = $('#mvMgrFsVal');
    if (label) label.textContent = String(mgrFontSize);
  }
  applyMgrFontSize();
  for (const [sel, step] of [['#mvMgrFsDown', -1], ['#mvMgrFsUp', 1]]) {
    const b = $(sel);
    if (!b) continue;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      mgrFontSize = Math.min(20, Math.max(10, mgrFontSize + step));
      write(MGR_FS_KEY, String(mgrFontSize));
      applyMgrFontSize();
    });
  }

  // 관리자 / 봇 / 스트리머 체크박스: 체크한 종류만 모으고 보여줌
  document.querySelectorAll('.mv-mgr-role input').forEach((box) => {
    box.checked = mgrRoles.has(box.dataset.role);
    box.addEventListener('change', () => {
      if (box.checked) mgrRoles.add(box.dataset.role);
      else mgrRoles.delete(box.dataset.role);
      write(MGR_ROLES_KEY, JSON.stringify([...mgrRoles]));
      syncMvMgrChatUI();
    });
  });

  const badgeChats = new Map(); // channelId -> [{channelId, nick, text, badge, at}]
  const allBadgeChats = [];
  const badgePanel = $('#badgePanel');
  const badgeList = $('#badgeList');
  const badgeScopeBtn = $('#badgeScopeBtn');
  const BADGE_MAX = 150;
  let badgeAllScope = settings.badgeFilterAll;

  function syncBadgeScopeBtn() {
    if (!badgeScopeBtn) return;
    badgeScopeBtn.textContent = badgeAllScope ? '전체 방송' : '현재 방송';
  }
  syncBadgeScopeBtn();

  function onBadgeChat(d) {
    const cid = String(d.channelId || '').toLowerCase();
    const nick = String(d.nick || '');
    const text = String(d.text || '');
    const at = Number(d.at) || Date.now();

    // 1. 관리자 · 봇 · 스트리머 채팅 전용 팝업 수집
    const mgrRole = classifyMgrRole(d, cid);
    if (mgrRole && mgrRoles.has(mgrRole)) {
      if (!mgrChatsByChannel.has(cid)) mgrChatsByChannel.set(cid, []);
      const mgrArr = mgrChatsByChannel.get(cid);
      const isDup = mgrArr.some((x) => x.nick === nick && x.text === text && Math.abs(x.at - at) < 2000);
      if (!isDup) {
        const color = /^(rgba?\([\d\s.,%]+\)|#[0-9a-f]{3,8})$/i.test(String(d.color || '')) ? String(d.color) : '';
        const mgrItem = { role: mgrRole, nick, text, at, color };
        mgrArr.push(mgrItem);
        while (mgrArr.length > MGR_CHAT_MAX) mgrArr.shift();
        saveMgrChats();
        if (state.chatId === cid) {
          if (mvMgrChatPopup && !mvMgrChatPopup.classList.contains('hidden')) {
            appendMvMgrItemDOM(mgrItem);
          }
          paintMgrBadge();
        }
      }
    }

    // 2. 배지 채팅 모아보기 수집
    if (!badgeChats.has(cid)) badgeChats.set(cid, []);
    const item = {
      channelId: cid,
      nick,
      text,
      badge: mgrRole === 'bot' ? 'manager' : String(d.badge || 'badge'),
      at,
    };
    const arr = badgeChats.get(cid);
    arr.push(item);
    while (arr.length > BADGE_MAX) arr.shift();

    allBadgeChats.push(item);
    while (allBadgeChats.length > BADGE_MAX) allBadgeChats.shift();

    if (!badgePanel.classList.contains('hidden')) {
      if (badgeAllScope || state.chatId === cid) {
        appendBadgeItem(item);
      }
    }
  }

  function badgeLabel(badge) {
    return badge === 'streamer' ? '스트리머' : badge === 'manager' ? '매니저' : '배지';
  }

  function appendBadgeItem(item, parent = null) {
    if (!parent) {
      const emptyMsg = badgeList.querySelector('.storage-empty');
      if (emptyMsg) emptyMsg.remove();
    }

    const div = document.createElement('div');
    div.className = 'badge-item';
    const head = document.createElement('div');
    head.className = 'badge-head';

    if (badgeAllScope && item.channelId) {
      const chTag = document.createElement('span');
      chTag.className = 'badge-ch';
      const tile = state.tiles.get(item.channelId);
      chTag.textContent = (tile && tile.nameEl.textContent) || item.channelId.slice(0, 6);
      head.appendChild(chTag);
    }

    const tag = document.createElement('span');
    tag.className = 'badge-tag ' + item.badge;
    tag.textContent = badgeLabel(item.badge);
    const nick = document.createElement('b');
    nick.textContent = item.nick;
    const time = document.createElement('span');
    time.className = 'badge-time';
    const dt = new Date(item.at);
    time.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    head.append(tag, nick, time);

    const body = document.createElement('div');
    body.className = 'badge-body';
    body.textContent = item.text;
    div.append(head, body);
    if (parent) {
      parent.appendChild(div);
      return;
    }
    badgeList.appendChild(div);
    while (badgeList.children.length > BADGE_MAX) badgeList.firstChild.remove();
    badgeList.scrollTop = badgeList.scrollHeight;
  }

  function renderBadgePanel() {
    badgeList.innerHTML = '';
    const arr = badgeAllScope ? allBadgeChats : badgeChats.get(state.chatId) || [];
    if (!arr.length) {
      badgeList.innerHTML = '<div class="storage-empty">아직 수집된 배지 채팅이 없어요</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of arr.slice(-BADGE_MAX)) appendBadgeItem(item, frag);
    badgeList.appendChild(frag);
    badgeList.scrollTop = badgeList.scrollHeight;
  }

  function toggleBadgePanel(show) {
    const open = show ?? badgePanel.classList.contains('hidden');
    if (open) {
      syncBadgeScopeBtn();
      renderBadgePanel();
      toggleAddPop(false);
      toggleChatSettings(false);
      toggleStoragePop(false);
    }
    badgePanel.classList.toggle('hidden', !open);
  }

  $('#badgeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBadgePanel();
  });
  if (badgeScopeBtn) {
    badgeScopeBtn.addEventListener('click', () => {
      badgeAllScope = !badgeAllScope;
      settings.badgeFilterAll = badgeAllScope;
      syncBadgeScopeBtn();
      renderBadgePanel();
    });
  }
  $('#badgeClearBtn').addEventListener('click', () => {
    if (badgeAllScope) {
      allBadgeChats.length = 0;
      badgeChats.clear();
    } else if (state.chatId) {
      badgeChats.delete(state.chatId);
    }
    renderBadgePanel();
  });
  document.addEventListener('click', (e) => {
    if (!badgePanel.classList.contains('hidden') && !e.target.closest('#badgePanel, #badgeBtn')) {
      toggleBadgePanel(false);
    }
  });

  /* ---------------- 플로팅 빠른 도구막대 (#quickDock) & 단축키 ---------------- */
  const DOCK_KEY = 'my-multiview:dock-collapsed';
  const quickDock = $('#quickDock');
  const dockToggleBtn = $('#dockToggleBtn');

  function applyDockCollapsed(collapsed) {
    if (!quickDock || !dockToggleBtn) return;
    quickDock.classList.toggle('collapsed', collapsed);
    dockToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    dockToggleBtn.title = collapsed ? '빠른 도구 펼치기' : '빠른 도구 접기';
  }

  applyDockCollapsed(read(DOCK_KEY) === '1');

  if (dockToggleBtn) {
    dockToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !quickDock.classList.contains('collapsed');
      if (next) toggleDockAddPop(false);
      applyDockCollapsed(next);
      write(DOCK_KEY, next ? '1' : '0');
    });
  }

  $('#dockChatBtn').addEventListener('click', toggleChatPanel);
  $('#dockAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDockAddPop();
  });
  $('#dockHoverAudioBtn').addEventListener('click', () => {
    opts.hoverAudio = !opts.hoverAudio;
    settings.hoverAudio = opts.hoverAudio;
    applyHoverAudio();
    toast(opts.hoverAudio ? '마우스 올린 방송만 소리 켜기: ON' : '마우스 올린 방송만 소리 켜기: OFF');
  });
  $('#dockMuteAllBtn').addEventListener('click', toggleMuteAll);
  paintMuteAll();
  $('#dockSyncBtn').addEventListener('click', syncAll);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleAddPop(false);
      toggleDockAddPop(false);
      toggleChatSettings(false);
      toggleStoragePop(false);
      toggleBadgePanel(false);
      if (state.focus) setFocus(null);
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const k = e.key.toLowerCase();
    if (k === 'm') {
      e.preventDefault();
      toggleMuteAll();
    } else if (k === 's') {
      e.preventDefault();
      syncAll();
    } else if (k === 'c') {
      e.preventDefault();
      toggleChatPanel();
    } else if (k === 'h') {
      e.preventDefault();
      $('#dockHoverAudioBtn').click();
    } else if (/^[1-9]$/.test(k)) {
      const idx = parseInt(k, 10) - 1;
      if (state.order[idx]) {
        e.preventDefault();
        toggleFocus(state.order[idx]);
      }
    }
  });

  /* ---------------- 팝업 / 백그라운드에서 바뀐 설정 실시간 동기화 ---------------- */
  function syncAllSettingsFromStorage() {
    const prevPos = opts.chatPosition;
    const prevPreload = preload;
    const prevHover = opts.hoverAudio;
    const prevCols = opts.gridCols;

    opts.chatPosition = settings.chatPosition;
    opts.chatTime = settings.chatTime;
    opts.autoFf = settings.autoFf;
    opts.autoFfSec = settings.autoFfSec;
    opts.autoLp = settings.autoLp;
    opts.hoverAudio = settings.hoverAudio;
    opts.gridCols = settings.gridCols;
    opts.alwaysShowBar = settings.alwaysShowBar;

    document.body.classList.toggle('always-show-bar', opts.alwaysShowBar);

    if (prevPreload !== settings.chatPreload) {
      setPreload(settings.chatPreload);
    }
    if (prevPos !== opts.chatPosition && state.chatOpen) {
      mainEl.classList.toggle('chat-left', opts.chatPosition === 'left');
      mainEl.classList.toggle('chat-right', opts.chatPosition !== 'left');
      layout();
    }
    if (prevCols !== opts.gridCols) {
      layout();
    }
    if (prevHover !== opts.hoverAudio) {
      applyHoverAudio();
    }
    for (const t of state.tiles.values()) paintFavorite(t);
    if (state.order.length === 0) renderEmptyFavs();
    updateTitle();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'mv:add' && Array.isArray(msg.ids)) {
      for (const raw of msg.ids) {
        const id = parseChannelId(raw);
        if (id) addChannel(id);
      }
    } else if (msg.type === 'mv:auth-changed') {
      if (msg.auth) paintAuthStatus(msg.auth);
      if (msg.auth && msg.auth.loggedIn) {
        reloadAllChatFrames();
        toast('치지직 로그인 연동 완료 · 채팅창이 갱신되었습니다');
      }
    }
  });

  window.addEventListener('storage', syncAllSettingsFromStorage);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['my-multiview:settings']) {
      syncAllSettingsFromStorage();
    }
  });

  /* ---------------- 시작 ---------------- */
  /** 처음 켰을 때 오른쪽 채팅창 고르기
   *  칸 순서(왼쪽 위부터 1, 2, 3 …) 중에서 방송 중인 첫 번째 방송의 채팅.
   *  전부 방송 대기 중이면 마지막에 보던 채팅. 그것도 없으면 첫 번째 칸.
   *  방송 상태를 확인하는 동안은 마지막에 보던 채팅을 먼저 띄워 둔다. */
  async function openStartChat(lastId) {
    if (!state.order.length) return;
    const fallback = lastId && state.order.includes(lastId) ? lastId : state.order[0];
    openChat(fallback);
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (!state.chatOpen || state.chatId !== fallback) return; // 그 사이 직접 바꿨으면 손대지 않음
      const tiles = state.order.map((id) => state.tiles.get(id)).filter(Boolean);
      const firstLive = tiles.find((t) => t.live === 'OPEN');
      const allKnown = tiles.every((t) => t.live === 'OPEN' || t.live === 'CLOSE');
      // 앞 번호 방송이 아직 확인 중이면 조금 더 기다림 (더 앞 번호가 방송 중일 수 있어서)
      const earlierUnknown = firstLive && tiles.slice(0, tiles.indexOf(firstLive)).some((t) => t.live !== 'CLOSE');
      if (firstLive && !earlierUnknown) {
        if (state.chatId !== firstLive.id) openChat(firstLive.id);
        return;
      }
      if (allKnown) return; // 전부 대기 중 → 마지막에 보던 채팅 그대로
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function start() {
    document.body.classList.toggle('always-show-bar', opts.alwaysShowBar);
    $('#dockHoverAudioBtn').classList.toggle('active', opts.hoverAudio);

    const saved = await loadSaved();
    const fromUrl = new URLSearchParams(location.search).getAll('c').map(parseChannelId).filter(Boolean);
    // 팝업 '방송 목록 추가'로 열린 경우: 마지막에 보던 방송 뒤에 이어 붙임
    const toAdd = new URLSearchParams(location.search).getAll('add').map(parseChannelId).filter(Boolean);
    const ids = (fromUrl.length ? fromUrl : saved ? saved.channels : []).concat(toAdd);
    for (const id of ids) if (!state.order.includes(id)) state.order.push(id);
    state.chatId = saved && saved.chatId;
    if (settings.autoLp && state.order.length && (!lpChannel || !state.order.includes(lpChannel))) {
      lpChannel = state.order[0];
      saveLp();
    }

    // 치지직 iframe 허용 및 쿠키 규칙이 먼저 적용되도록 대기
    const readyResp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'mv:ready' }).catch(() => null),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (readyResp && readyResp.auth) {
      paintAuthStatus(readyResp.auth);
    } else {
      refreshAuthStatus();
    }

    mountTiles();
    openStartChat(saved && saved.chatId);
    if (saved && saved.focus && state.tiles.has(saved.focus)) {
      setFocus(saved.focus);
    } else if (opts.hoverAudio) {
      applyHoverAudio();
    }
    save();
  }

  start();
})();

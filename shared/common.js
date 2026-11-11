/**
 * My MultiView - 팝업과 멀티뷰 화면이 같이 쓰는 공통 도구
 *  - 채널 ID 읽기 (ID 그대로 / 치지직 라이브·채널 주소 / 텍스트 내 32자리 ID)
 *  - 채널 이름 및 생방송 상태 가져오기 (다중 API 엔드포인트 + 백그라운드 프록시 폴백)
 *  - 즐겨찾기, 그룹, 설정 저장 및 백업/복원
 */
(() => {
  const MyMV = (globalThis.MyMV = globalThis.MyMV || {});

  /* ---------------- 채널 ID ---------------- */
  const HEX32 = /^[0-9a-f]{32}$/i;
  const HEX32_FIND = /\b([0-9a-f]{32})\b/i;
  MyMV.isChannelId = (s) => HEX32.test(String(s || '').trim());

  /** 한 줄 입력에서 채널 ID를 찾는다. 못 찾으면 null */
  MyMV.parseChannelId = (text) => {
    const s = String(text ?? '').trim();
    if (!s) return null;
    if (HEX32.test(s)) return s.toLowerCase();
    try {
      const url = new URL(s);
      if (/(^|\.)chzzk\.naver\.com$/i.test(url.hostname)) {
        const parts = url.pathname.split('/').filter(Boolean);
        const found = parts.find((p) => HEX32.test(p));
        if (found) return found.toLowerCase();
        for (const [, val] of url.searchParams) {
          if (HEX32.test(val)) return val.toLowerCase();
        }
      }
    } catch {}
    // URL 파싱 실패 또는 텍스트가 섞인 경우 chzzk 주소나 독립된 32자리 hex 추출
    if (/chzzk\.naver\.com/i.test(s) || /^[0-9a-f\s/._:-]+$/i.test(s)) {
      const m = s.match(HEX32_FIND);
      if (m) return m[1].toLowerCase();
    }
    return null;
  };

  /* ---------------- 다중 폴백 API 호출 도우미 ---------------- */
  async function fetchWithFallback(url) {
    // 1차: 직접 fetch
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        if (res.ok) {
          const json = await res.json();
          if (json && (json.code === undefined || json.code === 200) && json.content != null) {
            return json;
          }
        }
      } finally {
        clearTimeout(t);
      }
    } catch {}

    // 2차: 백그라운드 서비스 워커 프록시 폴백 (인증 쿠키 헤더 포함)
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        const resp = await chrome.runtime.sendMessage({ type: 'mv:fetch-api', url });
        if (resp && resp.ok && resp.data) return resp.data;
      }
    } catch {}
    return null;
  }
  MyMV.fetchWithFallback = fetchWithFallback;

  /* ---------------- 채널 이름 및 생방송 정보 (다중 루트) ---------------- */
  const nameCache = new Map();
  const liveCache = new Map(); // id -> { status, viewers, title, name, at }

  MyMV.fetchChannelName = async (id) => {
    if (!MyMV.isChannelId(id)) return null;
    const key = id.toLowerCase();
    if (nameCache.has(key)) return nameCache.get(key);

    const job = (async () => {
      const urls = [
        `https://api.chzzk.naver.com/service/v1/channels/${key}`,
        `https://api.chzzk.naver.com/service/v2/channels/${key}/live-detail`,
        `https://api.chzzk.naver.com/service/v3/channels/${key}/live-detail`,
        `https://api.chzzk.naver.com/polling/v2/channels/${key}/live-status`,
      ];
      for (const u of urls) {
        const body = await fetchWithFallback(u);
        const c = body && body.content;
        if (!c) continue;
        const rawName =
          c.channelName ||
          (c.channel && c.channel.channelName) ||
          c.streamerName ||
          '';
        if (typeof rawName === 'string' && rawName.trim()) {
          return rawName.trim();
        }
      }
      // 즐겨찾기에 저장된 이름이 있으면 최종 폴백으로 반환
      try {
        const fav = MyMV.favorites && MyMV.favorites.list().find((f) => f.id === key);
        if (fav && fav.name) return fav.name;
      } catch {}
      return null;
    })();

    nameCache.set(key, job);
    const name = await job;
    if (!name) nameCache.delete(key);
    else nameCache.set(key, Promise.resolve(name));
    return name;
  };

  /** 외부(DOM 등)에서 확인된 채널 이름을 캐시에 보강 */
  MyMV.rememberChannelName = (id, name) => {
    if (!MyMV.isChannelId(id) || typeof name !== 'string' || !name.trim()) return;
    const key = id.toLowerCase();
    if (!nameCache.has(key)) {
      nameCache.set(key, Promise.resolve(name.trim()));
    }
  };

  /**
   * 채널의 생방송 상태, 시청자 수, 방 제목, 채널 이름을 다중 API로 조회
   * @returns {Promise<{status: 'OPEN'|'CLOSE'|null, viewers: number, title: string, name: string}>}
   */
  MyMV.fetchLiveInfo = async (id, useCacheMs = 15000) => {
    if (!MyMV.isChannelId(id)) return { status: null, viewers: 0, title: '', name: '' };
    const key = id.toLowerCase();
    const cached = liveCache.get(key);
    if (cached && Date.now() - cached.at < useCacheMs) return cached;

    const urls = [
      `https://api.chzzk.naver.com/polling/v2/channels/${key}/live-status`,
      `https://api.chzzk.naver.com/polling/v3/channels/${key}/live-status`,
      `https://api.chzzk.naver.com/service/v2/channels/${key}/live-detail`,
      `https://api.chzzk.naver.com/service/v3/channels/${key}/live-detail`,
      `https://api.chzzk.naver.com/service/v1/channels/${key}`,
    ];

    let status = null;
    let viewers = 0;
    let title = '';
    let name = '';
    let liveId = null;

    for (const u of urls) {
      const body = await fetchWithFallback(u);
      const c = body && body.content;
      if (!c) continue;
      if (c.status === 'OPEN' || c.status === 'CLOSE') status = c.status;
      else if (c.liveStatus === 'OPEN' || c.liveStatus === 'CLOSE') status = c.liveStatus;
      else if (typeof c.openLive === 'boolean') status = c.openLive ? 'OPEN' : 'CLOSE';

      if (c.liveId != null) liveId = c.liveId;

      if (typeof c.concurrentUserCount === 'number') viewers = c.concurrentUserCount;
      if (typeof c.liveTitle === 'string' && c.liveTitle.trim()) title = c.liveTitle.trim();
      const chName = c.channelName || (c.channel && c.channel.channelName);
      if (typeof chName === 'string' && chName.trim()) {
        name = chName.trim();
        MyMV.rememberChannelName(key, name);
      }
      if (status) break;
    }

    const result = { status, viewers, title, name, liveId, at: Date.now() };
    if (status) liveCache.set(key, result);
    return result;
  };

  /* ---------------- 치지직 팔로우 채널 전체 & 생방송 목록 자동 조회 ---------------- */
  let followingCache = { list: [], at: 0 };

  function parseFollowingEntry(item, forceLive = false) {
    if (!item || typeof item !== 'object') return null;
    const ch = item.channel || item;
    const rawId = ch.channelId || item.channelId || '';
    if (!MyMV.isChannelId(rawId)) return null;
    const id = String(rawId).toLowerCase();
    const name = String(ch.channelName || item.channelName || '').trim();
    const imageUrl = String(ch.channelImageUrl || item.channelImageUrl || '').trim();
    const verified = !!(ch.verifiedMark || item.verifiedMark);
    const streamer = item.streamer || ch.streamer || {};
    const liveInfo = item.liveInfo || ch.liveInfo || item.live || {};
    const isLive =
      forceLive ||
      streamer.openLive === true ||
      ch.openLive === true ||
      item.openLive === true ||
      liveInfo.status === 'OPEN' ||
      (typeof liveInfo.concurrentUserCount === 'number' && liveInfo.concurrentUserCount > 0 && !!liveInfo.liveTitle);
    const status = isLive ? 'OPEN' : 'CLOSE';
    const viewers = typeof liveInfo.concurrentUserCount === 'number' ? liveInfo.concurrentUserCount : 0;
    const title = typeof liveInfo.liveTitle === 'string' ? liveInfo.liveTitle.trim() : '';
    const category = String(liveInfo.liveCategoryValue || liveInfo.liveCategory || '').trim();

    if (name) MyMV.rememberChannelName(id, name);
    if (status === 'OPEN') {
      liveCache.set(id, { status: 'OPEN', viewers, title, name, liveId: liveInfo.liveId || null, at: Date.now() });
    }
    return { id, name, imageUrl, verified, status, viewers, title, category };
  }

  function extractFollowingList(body) {
    const c = body && body.content;
    if (!c) return { list: [], totalPage: 1 };
    if (Array.isArray(c)) return { list: c, totalPage: 1 };
    const list = c.followingList || c.data || c.list || c.channels || [];
    const totalPage = Number(c.totalPage) || 1;
    return { list: Array.isArray(list) ? list : [], totalPage };
  }

  /**
   * 로그인된 치지직 계정의 팔로우 채널 목록(생방송 + 오프라인 전체)을 조회
   * @param {boolean} forceRefresh 캐시 무시 여부
   * @returns {Promise<{ok: boolean, list: Array<{id:string, name:string, imageUrl:string, verified:boolean, status:'OPEN'|'CLOSE', viewers:number, title:string, category:string}>}>}
   */
  MyMV.fetchFollowings = async (forceRefresh = false) => {
    if (!forceRefresh && followingCache.list.length && Date.now() - followingCache.at < 20000) {
      return { ok: true, list: followingCache.list };
    }

    const byId = new Map();
    let anySuccess = false;

    // 1. 생방송 중인 팔로우 채널 조회 (시청자 수·방제·카테고리 최신 정보)
    const liveUrls = [
      'https://api.chzzk.naver.com/service/v1/channels/followings/live',
      'https://api.chzzk.naver.com/service/v1/channels/following-lives',
    ];
    for (const u of liveUrls) {
      const body = await fetchWithFallback(u);
      if (body && body.content != null) {
        anySuccess = true;
        const { list } = extractFollowingList(body);
        for (const raw of list) {
          const parsed = parseFollowingEntry(raw, true);
          if (parsed) byId.set(parsed.id, parsed);
        }
        break;
      }
    }

    // 2. 전체 팔로우 채널 조회 (페이지당 최대 500개, 다중 페이지 지원)
    const firstBody = await fetchWithFallback('https://api.chzzk.naver.com/service/v1/channels/followings?size=500&page=0');
    if (firstBody && firstBody.content != null) {
      anySuccess = true;
      const { list: page0List, totalPage } = extractFollowingList(firstBody);
      for (const raw of page0List) {
        const parsed = parseFollowingEntry(raw, false);
        if (!parsed) continue;
        const prev = byId.get(parsed.id);
        if (!prev) {
          byId.set(parsed.id, parsed);
        } else {
          if (!prev.name && parsed.name) prev.name = parsed.name;
          if (!prev.imageUrl && parsed.imageUrl) prev.imageUrl = parsed.imageUrl;
          if (parsed.status === 'OPEN' && prev.status !== 'OPEN') {
            prev.status = 'OPEN';
            prev.viewers = parsed.viewers || prev.viewers;
            prev.title = parsed.title || prev.title;
            prev.category = parsed.category || prev.category;
          }
        }
      }

      const maxPages = Math.min(totalPage, 6);
      if (maxPages > 1) {
        const pageJobs = [];
        for (let p = 1; p < maxPages; p += 1) {
          pageJobs.push(fetchWithFallback(`https://api.chzzk.naver.com/service/v1/channels/followings?size=500&page=${p}`));
        }
        const pages = await Promise.all(pageJobs);
        for (const pBody of pages) {
          if (!pBody || pBody.content == null) continue;
          const { list } = extractFollowingList(pBody);
          for (const raw of list) {
            const parsed = parseFollowingEntry(raw, false);
            if (!parsed || byId.has(parsed.id)) continue;
            byId.set(parsed.id, parsed);
          }
        }
      }
    }

    const merged = [...byId.values()].sort((a, b) => {
      if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
      if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
      if (a.status === 'OPEN' && b.status === 'OPEN') {
        if (b.viewers !== a.viewers) return b.viewers - a.viewers;
      }
      return (a.name || a.id).localeCompare(b.name || b.id, 'ko');
    });

    // 즐겨찾기에 이름이 비어 있던 채널이 있으면 자동 보강
    try {
      if (MyMV.favorites) {
        const favNames = new Map(MyMV.favorites.list().map((f) => [f.id, f.name]));
        for (const item of merged) {
          if (item.name && favNames.has(item.id) && favNames.get(item.id) !== item.name) {
            MyMV.favorites.updateName(item.id, item.name);
          }
        }
      }
    } catch {}

    if (anySuccess) {
      followingCache = { list: merged, at: Date.now() };
    }
    return { ok: anySuccess, list: merged };
  };

  /* ---------------- localStorage ---------------- */
  const read = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, value); } catch {}
    // 미러링 대상(설정·즐겨찾기 등)이 아닌 키(창 크기, 읽음 표시 등)는 미러링을 건너뜀
    try {
      if (MyMV.KEYS) {
        if (!write._keys) write._keys = new Set(Object.values(MyMV.KEYS));
        if (!write._keys.has(key)) return;
      }
    } catch {}
    // content script(tile/chat) 및 열려 있는 멀티뷰 탭이 즉시 읽을 수 있게 빠르게 미러링
    try {
      clearTimeout(write._t);
      write._t = setTimeout(() => {
        try { MyMV.mirrorSettings && MyMV.mirrorSettings(); } catch {}
      }, 60);
    } catch {}
  };
  MyMV.read = read;
  MyMV.write = write;

  /** 예전 버전 키에 값이 있으면 새 키로 한 번 옮긴다 */
  function migrate(newKey, oldKey, convert = (v) => v) {
    if (read(newKey) !== null) return;
    const old = read(oldKey);
    if (old !== null) write(newKey, convert(old));
  }

  /* ---------------- 설정 ---------------- */
  const K = (MyMV.KEYS = {
    input: 'my-multiview:input',
    chatPosition: 'my-multiview:chatPosition',
    chatTime: 'my-multiview:chatTime',
    chatPreload: 'my-multiview:chatPreload',
    autoFf: 'my-multiview:autoFf',
    autoFfSec: 'my-multiview:autoFfSec',
    autoLp: 'my-multiview:autoLp',
    favorites: 'my-multiview:favorites',
    favGroups: 'my-multiview:favGroups',
    channelGroups: 'my-multiview:channelGroups',
    // 치즈 플러스 기능
    chatFontSize: 'my-multiview:chatFontSize',
    chatHideCheese: 'my-multiview:chatHideCheese',
    chatHideSub: 'my-multiview:chatHideSub',
    chatHideBlind: 'my-multiview:chatHideBlind',
    chatHideRank: 'my-multiview:chatHideRank',
    chatHideMission: 'my-multiview:chatHideMission',
    chatHidePredict: 'my-multiview:chatHidePredict',
    chatHideDonation: 'my-multiview:chatHideDonation',
    chatHideBadge: 'my-multiview:chatHideBadge',
    chatColorMode: 'my-multiview:chatColorMode',
    chatNickColor: 'my-multiview:chatNickColor',
    chatBodyColor: 'my-multiview:chatBodyColor',
    chatPinUsers: 'my-multiview:chatPinUsers',
    chatStorage: 'my-multiview:chatStorage',
    chatRestoreBlind: 'my-multiview:chatRestoreBlind',
    tileAudioCompress: 'my-multiview:tileAudioCompress',
    tileBrightness: 'my-multiview:tileBrightness',
    tileContrast: 'my-multiview:tileContrast',
    tileSaturate: 'my-multiview:tileSaturate',
    tileAdMute: 'my-multiview:tileAdMute',
    tileGamma: 'my-multiview:tileGamma',
    notifyLive: 'my-multiview:notifyLive',
    // 추가 멀티뷰 편의 설정
    hoverAudio: 'my-multiview:hoverAudio',
    defaultQuality: 'my-multiview:defaultQuality',
    videoFit: 'my-multiview:videoFit',
    gridCols: 'my-multiview:gridCols',
    alwaysShowBar: 'my-multiview:alwaysShowBar',
    badgeFilterAll: 'my-multiview:badgeFilterAll',
  });

  migrate(K.input, 'cmv-input');
  migrate(K.chatPosition, 'cmv-chat-position');
  migrate(K.chatTime, 'czmv:showChatTimestamp', (v) => (v === 'true' ? '1' : '0'));
  migrate(K.autoFf, 'cmv-auto-ff');
  migrate(K.autoFfSec, 'cmv-auto-ff-threshold');
  migrate(K.autoLp, 'cmv-auto-reward-claim');

  MyMV.FF_SEC = { min: 5, max: 30, def: 12 };
  const clampSec = (v) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n)) return MyMV.FF_SEC.def;
    return Math.min(MyMV.FF_SEC.max, Math.max(MyMV.FF_SEC.min, n));
  };
  MyMV.clampFfSec = clampSec;

  const clampFont = (v) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n)) return 14;
    return Math.min(24, Math.max(10, n));
  };
  const clampPct = (v, def) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(200, Math.max(0, n));
  };
  const clampCols = (v) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n) || n < 0 || n > 5) return 0;
    return n;
  };
  const VALID_QUALITIES = ['auto', '1080', '720', '480', '360'];
  const normQuality = (v) => (VALID_QUALITIES.includes(String(v)) ? String(v) : 'auto');

  const getJson = (k, def) => {
    try {
      const v = JSON.parse(read(k) || '');
      return v === null || v === undefined ? def : v;
    } catch { return def; }
  };

  MyMV.settings = {
    get chatPosition() { return read(K.chatPosition) === 'left' ? 'left' : 'right'; },
    set chatPosition(v) { write(K.chatPosition, v === 'left' ? 'left' : 'right'); },
    get chatTime() { return read(K.chatTime) === '1'; },
    set chatTime(v) { write(K.chatTime, v ? '1' : '0'); },
    get chatPreload() { return read(K.chatPreload) !== '0'; }, // 기본 켬
    set chatPreload(v) { write(K.chatPreload, v ? '1' : '0'); },
    get autoFf() { return read(K.autoFf) === '1'; },
    set autoFf(v) { write(K.autoFf, v ? '1' : '0'); },
    get autoFfSec() { return clampSec(read(K.autoFfSec)); },
    set autoFfSec(v) { write(K.autoFfSec, String(clampSec(v))); },
    get autoLp() { return read(K.autoLp) !== '0'; }, // 기본 켬 (1시간 시청 통나무 포함 자동 수령)
    set autoLp(v) { write(K.autoLp, v ? '1' : '0'); },
    // 치즈 플러스: 채팅
    get chatFontSize() { return clampFont(read(K.chatFontSize)); },
    set chatFontSize(v) { write(K.chatFontSize, String(clampFont(v))); },
    get chatHideCheese() { return read(K.chatHideCheese) === '1'; },
    set chatHideCheese(v) { write(K.chatHideCheese, v ? '1' : '0'); },
    get chatHideSub() { return read(K.chatHideSub) === '1'; },
    set chatHideSub(v) { write(K.chatHideSub, v ? '1' : '0'); },
    get chatHideBlind() { return read(K.chatHideBlind) === '1'; },
    set chatHideBlind(v) { write(K.chatHideBlind, v ? '1' : '0'); },
    get chatHideRank() { return read(K.chatHideRank) === '1'; },
    set chatHideRank(v) { write(K.chatHideRank, v ? '1' : '0'); },
    get chatHideMission() { return read(K.chatHideMission) === '1'; },
    set chatHideMission(v) { write(K.chatHideMission, v ? '1' : '0'); },
    get chatHidePredict() { return read(K.chatHidePredict) === '1'; },
    set chatHidePredict(v) { write(K.chatHidePredict, v ? '1' : '0'); },
    get chatHideDonation() { return read(K.chatHideDonation) === '1'; },
    set chatHideDonation(v) { write(K.chatHideDonation, v ? '1' : '0'); },
    get chatHideBadge() { return read(K.chatHideBadge) === '1'; },
    set chatHideBadge(v) { write(K.chatHideBadge, v ? '1' : '0'); },
    get chatColorMode() { return read(K.chatColorMode) === 'custom' ? 'custom' : 'default'; },
    set chatColorMode(v) { write(K.chatColorMode, v === 'custom' ? 'custom' : 'default'); },
    get chatNickColor() { return read(K.chatNickColor) || '#2dd4bf'; },
    set chatNickColor(v) { write(K.chatNickColor, String(v || '#2dd4bf')); },
    get chatBodyColor() { return read(K.chatBodyColor) || '#dbe2f1'; },
    set chatBodyColor(v) { write(K.chatBodyColor, String(v || '#dbe2f1')); },
    get chatRestoreBlind() { return read(K.chatRestoreBlind) !== '0'; }, // 기본 켬 (클린봇·관리자 블라인드 원문 표시)
    set chatRestoreBlind(v) { write(K.chatRestoreBlind, v ? '1' : '0'); },
    // 치즈 플러스: 타일
    get tileAudioCompress() { return read(K.tileAudioCompress) === '1'; },
    set tileAudioCompress(v) { write(K.tileAudioCompress, v ? '1' : '0'); },
    get tileBrightness() { return clampPct(read(K.tileBrightness), 100); },
    set tileBrightness(v) { write(K.tileBrightness, String(clampPct(v, 100))); },
    get tileContrast() { return clampPct(read(K.tileContrast), 100); },
    set tileContrast(v) { write(K.tileContrast, String(clampPct(v, 100))); },
    get tileSaturate() { return clampPct(read(K.tileSaturate), 100); },
    set tileSaturate(v) { write(K.tileSaturate, String(clampPct(v, 100))); },
    get tileAdMute() { return read(K.tileAdMute) !== '0'; }, // 기본 켬 (광고 중 음소거 및 종료 후 복원)
    set tileAdMute(v) { write(K.tileAdMute, v ? '1' : '0'); },
    get tileGamma() { return Math.min(200, Math.max(50, clampPct(read(K.tileGamma), 100))); },
    set tileGamma(v) { write(K.tileGamma, String(Math.min(200, Math.max(50, clampPct(v, 100))))); },
    // 치즈 플러스: 알림/기타
    get notifyLive() { return read(K.notifyLive) !== '0'; }, // 기본 켬
    set notifyLive(v) { write(K.notifyLive, v ? '1' : '0'); },
    // 추가 멀티뷰 편의 설정
    get hoverAudio() { return read(K.hoverAudio) === '1'; },
    set hoverAudio(v) { write(K.hoverAudio, v ? '1' : '0'); },
    get defaultQuality() { return normQuality(read(K.defaultQuality)); },
    set defaultQuality(v) { write(K.defaultQuality, normQuality(v)); },
    get videoFit() { return read(K.videoFit) === 'cover' ? 'cover' : 'contain'; },
    set videoFit(v) { write(K.videoFit, v === 'cover' ? 'cover' : 'contain'); },
    get gridCols() { return clampCols(read(K.gridCols)); },
    set gridCols(v) { write(K.gridCols, String(clampCols(v))); },
    get alwaysShowBar() { return read(K.alwaysShowBar) === '1'; },
    set alwaysShowBar(v) { write(K.alwaysShowBar, v ? '1' : '0'); },
    get badgeFilterAll() { return read(K.badgeFilterAll) === '1'; },
    set badgeFilterAll(v) { write(K.badgeFilterAll, v ? '1' : '0'); },
  };

  /* ---------------- 고정 유저 / 채팅 저장소 ---------------- */
  MyMV.pinUsers = {
    list() {
      const v = getJson(K.chatPinUsers, []);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    },
    save(list) { write(K.chatPinUsers, JSON.stringify(list)); },
    add(name) {
      const n = String(name || '').trim();
      if (!n) return false;
      const list = this.list();
      if (list.includes(n)) return false;
      list.push(n);
      this.save(list);
      return true;
    },
    remove(name) { this.save(this.list().filter((x) => x !== name)); },
  };

  MyMV.chatStorage = {
    list() {
      const v = getJson(K.chatStorage, []);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    },
    save(list) { write(K.chatStorage, JSON.stringify(list)); },
    add(text) {
      const t = String(text || '').trim();
      if (!t) return false;
      const list = this.list();
      if (list.includes(t)) return false;
      list.push(t);
      this.save(list);
      return true;
    },
    remove(text) { this.save(this.list().filter((x) => x !== text)); },
  };

  /* ---------------- 설정 미러링 (content script용) ---------------- */
  MyMV.mirrorSettings = () => {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      const data = {};
      for (const k of Object.values(MyMV.KEYS)) {
        const v = read(k);
        if (v !== null) data[k] = v;
      }
      data[MyMV.KEYS.chatPinUsers] = read(MyMV.KEYS.chatPinUsers);
      data[MyMV.KEYS.chatStorage] = read(MyMV.KEYS.chatStorage);
      data[MyMV.KEYS.favorites] = read(MyMV.KEYS.favorites);
      data[MyMV.KEYS.favGroups] = read(MyMV.KEYS.favGroups);
      data[MyMV.KEYS.channelGroups] = read(MyMV.KEYS.channelGroups);
      chrome.storage.local.set({ 'my-multiview:settings': data }).catch(() => {});
    } catch {}
  };
  try { MyMV.mirrorSettings(); } catch {}

  /* ---------------- 즐겨찾기 ---------------- */
  function normalizeFavorites(list) {
    const byId = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item) continue;
      const id = String(item.id ?? item.channelId ?? '').trim().toLowerCase();
      if (!MyMV.isChannelId(id)) continue;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
      const addedAt = Number(item.addedAt) || Date.now();
      const group = typeof item.group === 'string' ? item.group.trim() : '';
      const prev = byId.get(id);
      if (!prev) byId.set(id, { id, name, addedAt, group });
      else {
        if (!prev.name && name) prev.name = name;
        if (addedAt < prev.addedAt) prev.addedAt = addedAt;
      }
    }
    return [...byId.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  if (read(K.favorites) === null) {
    let old = [];
    try { old = JSON.parse(read('czmv:favorites') || '[]'); } catch {}
    write(K.favorites, JSON.stringify(normalizeFavorites(old)));
  }

  // 즐겨찾기 목록은 아주 자주 읽히므로(has/label 등) 저장된 문자열이 그대로면 다시 해석하지 않음
  let favRaw = null;
  let favParsed = [];
  MyMV.favorites = {
    list() {
      try {
        const raw = read(K.favorites) || '[]';
        if (raw !== favRaw) {
          favParsed = normalizeFavorites(JSON.parse(raw));
          favRaw = raw;
        }
        // 호출한 쪽에서 항목을 고쳐 쓰기도 하므로 항상 복사본을 돌려줌
        return favParsed.map((f) => ({ ...f }));
      } catch { return []; }
    },
    save(list) { write(K.favorites, JSON.stringify(normalizeFavorites(list))); },
    has(id) { return this.list().some((f) => f.id === String(id).toLowerCase()); },
    add(id, name, group = '') {
      const cleanId = String(id || '').toLowerCase();
      if (!MyMV.isChannelId(cleanId)) return;
      const list = this.list();
      const existing = list.find((f) => f.id === cleanId);
      if (existing) {
        if (!existing.name && name) {
          existing.name = name;
          this.save(list);
        }
        return;
      }
      list.push({ id: cleanId, name: name || '', addedAt: Date.now(), group: group || (MyMV.channelGroups && MyMV.channelGroups.get(cleanId)) || '' });
      this.save(list);
      if (group && MyMV.channelGroups) MyMV.channelGroups.set(cleanId, group, name);
    },
    updateName(id, name) {
      if (!name || !name.trim()) return;
      const cleanId = String(id || '').toLowerCase();
      const list = this.list();
      const f = list.find((x) => x.id === cleanId);
      if (f && f.name !== name.trim()) {
        f.name = name.trim();
        this.save(list);
      }
    },
    remove(id) { this.save(this.list().filter((f) => f.id !== String(id).toLowerCase())); },
    setGroup(id, group) {
      const cleanId = String(id || '').toLowerCase();
      const validGroup = groups.list().includes(group) ? group : '';
      const list = this.list();
      const f = list.find((x) => x.id === cleanId);
      if (f) {
        f.group = validGroup;
        this.save(list);
      }
      if (MyMV.channelGroups) {
        MyMV.channelGroups.set(cleanId, validGroup, f ? f.name : '');
      }
    },
    grouped() {
      const list = this.list();
      const names = groups.list();
      const out = [{ group: '', items: list.filter((f) => !f.group || !names.includes(f.group)) }];
      for (const g of names) out.push({ group: g, items: list.filter((f) => f.group === g) });
      return out;
    },
    label(f) { return f.name || (f.id.length > 8 ? f.id.slice(0, 8) + '…' : f.id); },
  };

  /* ---------------- 즐겨찾기 그룹 ---------------- */
  const groups = (MyMV.favGroups = {
    list() {
      try {
        const v = JSON.parse(read(K.favGroups) || '[]');
        return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))] : [];
      } catch { return []; }
    },
    save(list) { write(K.favGroups, JSON.stringify(list)); },
    add(name) {
      const n = String(name || '').trim();
      const list = this.list();
      if (!n || list.includes(n)) return false;
      list.push(n);
      this.save(list);
      return true;
    },
    rename(from, to) {
      const n = String(to || '').trim();
      const list = this.list();
      const i = list.indexOf(from);
      if (i < 0 || !n || (n !== from && list.includes(n))) return false;
      list[i] = n;
      this.save(list);
      const favs = MyMV.favorites.list();
      favs.forEach((f) => { if (f.group === from) f.group = n; });
      MyMV.favorites.save(favs);
      if (MyMV.channelGroups) {
        const map = MyMV.channelGroups.map();
        let changed = false;
        for (const [cid, g] of Object.entries(map)) {
          if (g === from) {
            map[cid] = n;
            changed = true;
          }
        }
        if (changed) MyMV.channelGroups.save(map);
      }
      return true;
    },
    remove(name) {
      this.save(this.list().filter((g) => g !== name));
      const favs = MyMV.favorites.list();
      favs.forEach((f) => { if (f.group === name) f.group = ''; });
      MyMV.favorites.save(favs);
      if (MyMV.channelGroups) {
        const map = MyMV.channelGroups.map();
        let changed = false;
        for (const [cid, g] of Object.entries(map)) {
          if (g === name) {
            delete map[cid];
            changed = true;
          }
        }
        if (changed) MyMV.channelGroups.save(map);
      }
    },
    move(name, delta) {
      const list = this.list();
      const i = list.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      this.save(list);
    },
  });

  /* ---------------- 팔로우/채널 그룹 매핑 (즐겨찾기 그룹과 통합) ---------------- */
  MyMV.channelGroups = {
    map() {
      try {
        const raw = JSON.parse(read(K.channelGroups) || '{}');
        const out = {};
        const valid = new Set(groups.list());
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            const id = String(k || '').toLowerCase();
            const g = typeof v === 'string' ? v.trim() : '';
            if (MyMV.isChannelId(id) && g && valid.has(g)) out[id] = g;
          }
        }
        // 즐겨찾기에 지정된 그룹도 통합 반영
        for (const f of MyMV.favorites.list()) {
          if (f.group && valid.has(f.group) && !out[f.id]) {
            out[f.id] = f.group;
          }
        }
        return out;
      } catch {
        return {};
      }
    },
    save(obj) {
      write(K.channelGroups, JSON.stringify(obj || {}));
    },
    get(id) {
      const cleanId = String(id || '').toLowerCase();
      const m = this.map();
      return m[cleanId] || '';
    },
    set(id, group, name = '') {
      const cleanId = String(id || '').toLowerCase();
      if (!MyMV.isChannelId(cleanId)) return;
      const g = typeof group === 'string' ? group.trim() : '';
      if (g && !groups.list().includes(g)) {
        groups.add(g);
      }
      const validGroup = groups.list().includes(g) ? g : '';
      const m = this.map();
      if (validGroup) m[cleanId] = validGroup;
      else delete m[cleanId];
      this.save(m);

      // 즐겨찾기에도 이미 있는 채널이면 그룹 동기화
      const favs = MyMV.favorites.list();
      const f = favs.find((x) => x.id === cleanId);
      if (f && f.group !== validGroup) {
        f.group = validGroup;
        if (name && !f.name) f.name = name;
        MyMV.favorites.save(favs);
      }
    },
  };

  // 치지직 웹사이트(content script)에서 변경한 그룹 설정을 확장 프로그램 localStorage에 역동기화
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes['my-multiview:UpdatedGroups']) return;
        const payload = changes['my-multiview:UpdatedGroups'].newValue;
        if (!payload || typeof payload !== 'object') return;
        if (Array.isArray(payload.favGroups)) {
          try { localStorage.setItem(K.favGroups, JSON.stringify(payload.favGroups)); } catch {}
        }
        if (payload.channelGroups && typeof payload.channelGroups === 'object') {
          try { localStorage.setItem(K.channelGroups, JSON.stringify(payload.channelGroups)); } catch {}
        }
        try { MyMV.mirrorSettings(); } catch {}
      });
    }
  } catch {}

  /* ---------------- 데이터 백업 / 복원 / 초기화 ---------------- */
  MyMV.exportData = () => {
    const dump = { version: '1.0.0', exportedAt: new Date().toISOString(), data: {} };
    for (const k of Object.values(K)) {
      const v = read(k);
      if (v !== null) dump.data[k] = v;
    }
    return JSON.stringify(dump, null, 2);
  };

  MyMV.importData = (rawJson) => {
    const parsed = JSON.parse(String(rawJson || ''));
    const src = (parsed && typeof parsed.data === 'object' && parsed.data) || parsed;
    if (!src || typeof src !== 'object') throw new Error('유효하지 않은 백업 형식입니다.');
    const allowed = new Set(Object.values(K));
    let count = 0;
    for (const [k, v] of Object.entries(src)) {
      if (allowed.has(k) && typeof v === 'string') {
        write(k, v);
        count += 1;
      }
    }
    MyMV.mirrorSettings();
    return count;
  };

  MyMV.resetSettingsOnly = () => {
    const keepKeys = new Set([K.input, K.favorites, K.favGroups, K.channelGroups, K.chatStorage, K.chatPinUsers]);
    for (const k of Object.values(K)) {
      if (!keepKeys.has(k)) {
        try { localStorage.removeItem(k); } catch {}
      }
    }
    MyMV.mirrorSettings();
  };
})();

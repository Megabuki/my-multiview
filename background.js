/**
 * My MultiView - 백그라운드 서비스 워커
 *
 * 1. 치지직 iframe 임베드 허용 (X-Frame-Options, CSP 등 제거)
 * 2. 치지직/네이버 로그인 쿠키 연동 (SameSite=None 승격 + 서드파티 쿠키 허용 + DNR Cookie 헤더 보강)
 *    - 크롬의 서드파티 쿠키 차단이나 SameSite=Lax 정책 때문에 멀티뷰 iframe에서 로그인이 풀리는 문제를 3중으로 방지
 * 3. 즐겨찾기 채널 방송 시작/종료 알림 및 API 폴백 프록시
 */
const VIEW_URL = chrome.runtime.getURL('multiview/multiview.html');
const COOKIE_RULE_BASE = 800000;

const isViewTab = (tab) =>
  !!tab &&
  typeof tab.url === 'string' &&
  (tab.url.startsWith(VIEW_URL) ||
    (tab.pendingUrl && tab.pendingUrl.startsWith(VIEW_URL)));

/* ---------------- 1. 치지직 쿠키/로그인 3중 연동 ---------------- */

/** 크롬 contentSettings에서 네이버/치지직 서드파티 쿠키 허용 */
async function allowChzzkCookies() {
  try {
    if (!chrome.contentSettings || !chrome.contentSettings.cookies) return;
    const patterns = [
      { primaryPattern: '<all_urls>', secondaryPattern: 'https://*.naver.com/*' },
      { primaryPattern: '<all_urls>', secondaryPattern: 'https://naver.com/*' },
      { primaryPattern: 'https://chzzk.naver.com/*', secondaryPattern: 'https://*.naver.com/*' },
      { primaryPattern: 'https://*.naver.com/*', secondaryPattern: '<all_urls>' },
    ];
    for (const p of patterns) {
      await chrome.contentSettings.cookies.set({ ...p, setting: 'allow' }).catch(() => {});
    }
  } catch (e) {
    console.warn('[My MultiView] 쿠키 허용 설정 실패', e);
  }
}

let isSyncingCookies = false;
let cachedCookieHeader = '';

/**
 * 네이버/치지직 인증 쿠키를 멀티뷰 서드파티 iframe에서도 전송되도록 동기화
 * - 방어 1: 쿠키의 SameSite 속성을 no_restriction(SameSite=None; Secure)으로 승격
 * - 방어 2: 멀티뷰 탭의 치지직/네이버 API 요청에 Cookie 헤더를 직접 주입하는 DNR 규칙 갱신
 */
async function syncNaverCookies() {
  if (isSyncingCookies || !chrome.cookies) return cachedCookieHeader;
  isSyncingCookies = true;
  try {
    const allCookies = await chrome.cookies.getAll({ domain: 'naver.com' });
    const cookieMap = new Map();

    for (const c of allCookies) {
      if (!c || !c.name) continue;
      // 도메인 범위가 .naver.com 또는 chzzk/game/comm-api 관련 쿠키만 수집
      const dom = (c.domain || '').toLowerCase();
      if (
        dom === 'naver.com' ||
        dom === '.naver.com' ||
        dom.endsWith('.chzzk.naver.com') ||
        dom === 'chzzk.naver.com' ||
        dom.endsWith('.game.naver.com') ||
        dom === 'game.naver.com'
      ) {
        // 더 구체적인 도메인(chzzk.naver.com) 쿠키가 있으면 우선
        if (!cookieMap.has(c.name) || dom.includes('chzzk')) {
          cookieMap.set(c.name, c.value);
        }
      }

      // 핵심 로그인/세션 쿠키가 SameSite=None이 아니면 승격하여 서드파티 iframe에서 자동 포함되게 함
      const isAuthCookie =
        /^(NID_AUT|NID_SES|NID_JKL|NNB|nid_inf|page_uid|ba\.uuid|chzzk)/i.test(c.name) ||
        dom === '.naver.com' ||
        dom.includes('chzzk');

      if (isAuthCookie && (c.sameSite !== 'no_restriction' || !c.secure)) {
        const cleanDomain = c.domain.replace(/^\./, '');
        const url = `https://${cleanDomain}${c.path || '/'}`;
        const details = {
          url,
          name: c.name,
          value: c.value,
          path: c.path || '/',
          secure: true,
          httpOnly: c.httpOnly,
          sameSite: 'no_restriction',
          storeId: c.storeId,
        };
        if (!c.hostOnly && c.domain) details.domain = c.domain;
        if (c.expirationDate) details.expirationDate = c.expirationDate;
        await chrome.cookies.set(details).catch(() => {});
      }
    }

    cachedCookieHeader = [...cookieMap.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return cachedCookieHeader;
  } catch (e) {
    console.warn('[My MultiView] 쿠키 동기화 실패', e);
    return cachedCookieHeader;
  } finally {
    isSyncingCookies = false;
  }
}

/* ---------------- 2. 멀티뷰 탭 iframe 및 헤더 규칙 관리 ---------------- */

const CHZZK_DOMAINS = [
  'chzzk.naver.com',
  'api.chzzk.naver.com',
  'comm-api.game.naver.com',
  'game.naver.com',
  'apis.naver.com',
  'chat.naver.com',
  'nid.naver.com',
];

function buildRulesForTab(tabId, cookieHeader) {
  const rules = [
    {
      id: tabId,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
          { header: 'x-content-security-policy', operation: 'remove' },
          { header: 'frame-options', operation: 'remove' },
          { header: 'cross-origin-resource-policy', operation: 'remove' },
          { header: 'cross-origin-embedder-policy', operation: 'remove' },
        ],
      },
      condition: {
        requestDomains: CHZZK_DOMAINS,
        resourceTypes: ['sub_frame'],
        tabIds: [tabId],
      },
    },
  ];

  // 쿠키 헤더가 존재하면 치지직/네이버 API 및 iframe 요청에 강제 주입 (서드파티 쿠키 차단 완벽 우회)
  if (cookieHeader) {
    rules.push({
      id: COOKIE_RULE_BASE + tabId,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'cookie', operation: 'set', value: cookieHeader },
          { header: 'referer', operation: 'set', value: 'https://chzzk.naver.com/' },
        ],
      },
      condition: {
        requestDomains: [
          'chzzk.naver.com',
          'api.chzzk.naver.com',
          'comm-api.game.naver.com',
          'game.naver.com',
          'apis.naver.com',
        ],
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'other'],
        tabIds: [tabId],
      },
    });
  }

  return rules;
}

async function allowFramesInTab(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  const cookieHeader = cachedCookieHeader || (await syncNaverCookies());
  const addRules = buildRulesForTab(tabId, cookieHeader);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId, COOKIE_RULE_BASE + tabId],
    addRules,
  });
  lastRuleSig = ''; // 다음 resync 때 전체 규칙을 다시 맞춤
}

async function dropRule(tabId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId, COOKIE_RULE_BASE + tabId],
    });
  } catch {}
}

/** 열려 있는 멀티뷰 탭들의 DNR 규칙과 쿠키를 전체 동기화 */
let cookiesAllowed = false;
let lastRuleSig = '';
async function resync() {
  try {
    // 서드파티 쿠키 허용 설정은 서비스 워커가 깨어 있는 동안 한 번이면 충분
    if (!cookiesAllowed) {
      await allowChzzkCookies();
      cookiesAllowed = true;
    }
    const cookieHeader = await syncNaverCookies();
    const tabs = await chrome.tabs.query({});
    const openIds = new Set(tabs.filter(isViewTab).map((t) => t.id));
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existingRules.map((r) => r.id);

    const addRules = [];
    for (const id of openIds) {
      addRules.push(...buildRulesForTab(id, cookieHeader));
    }

    // 규칙 내용이 그대로면 다시 쓰지 않음 (쿠키가 바뀔 때마다 불필요하게 규칙을 갈아끼우지 않게)
    const sig = JSON.stringify(addRules);
    const existingIds = new Set(removeRuleIds);
    const sameIds = existingIds.size === addRules.length && addRules.every((r) => existingIds.has(r.id));
    if (sameIds && sig === lastRuleSig) return;
    lastRuleSig = sig;

    if (removeRuleIds.length || addRules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules,
      });
    }
  } catch (e) {
    console.warn('[My MultiView] resync 실패', e);
  }
}

/* ---------------- 3. 로그인 상태 확인 및 API 폴백 프록시 ---------------- */

async function checkAuthStatus() {
  let hasAuthCookies = false;
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'naver.com' });
    const names = new Set(cookies.map((c) => c.name));
    hasAuthCookies = names.has('NID_AUT') && names.has('NID_SES');
  } catch {}

  const urls = [
    'https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus',
    'https://api.chzzk.naver.com/service/v1/users/self',
  ];

  for (const u of urls) {
    try {
      const res = await fetch(u, {
        credentials: 'include',
        headers: cachedCookieHeader ? { Cookie: cachedCookieHeader } : undefined,
        signal: AbortSignal.timeout(6000), // 응답이 안 와도 멀티뷰 시작이 멈추지 않게
      });
      if (!res.ok) continue;
      const body = await res.json();
      const c = (body && body.content) || {};
      if (c.loggedIn === true || c.userIdHash || c.nickname) {
        return {
          loggedIn: true,
          nickname: c.nickname || c.userName || '로그인됨',
          userIdHash: c.userIdHash || '',
          hasAuthCookies: true,
        };
      }
    } catch {}
  }

  return {
    loggedIn: hasAuthCookies,
    nickname: hasAuthCookies ? '네이버 로그인 연동됨' : '',
    userIdHash: '',
    hasAuthCookies,
  };
}

/** 쿠키 변경 감지: 사용자가 로그인/로그아웃하면 즉시 규칙 갱신 후 멀티뷰에 알림 */
let cookieChangeTimer = 0;
let lastLoggedInCookieState = null;
let authCookieTouched = false;

// 마지막 로그인 상태는 서비스 워커가 잠들었다 깨어나도 남게 세션 저장소에 보관
// (안 그러면 깨어날 때마다 '로그인 상태가 바뀐 것'으로 착각해 채팅창을 전부 새로고침함)
const AUTH_STATE_KEY = 'my-multiview:lastLoggedIn';
async function getLastAuthState() {
  if (lastLoggedInCookieState !== null) return lastLoggedInCookieState;
  try {
    const o = await chrome.storage.session.get(AUTH_STATE_KEY);
    if (o && typeof o[AUTH_STATE_KEY] === 'boolean') lastLoggedInCookieState = o[AUTH_STATE_KEY];
  } catch {}
  return lastLoggedInCookieState;
}
function rememberAuthState(auth) {
  if (!auth || typeof auth.loggedIn !== 'boolean') return;
  lastLoggedInCookieState = auth.loggedIn;
  try {
    chrome.storage.session.set({ [AUTH_STATE_KEY]: auth.loggedIn }).catch(() => {});
  } catch {}
}

if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    if (isSyncingCookies) return;
    const c = changeInfo && changeInfo.cookie;
    if (!c || !c.domain || !c.domain.includes('naver.com')) return;

    const isImportant = /^(NID_AUT|NID_SES|NID_JKL|NNB)$/i.test(c.name);
    if (!isImportant && c.sameSite === 'no_restriction') return;
    if (isImportant) authCookieTouched = true;

    clearTimeout(cookieChangeTimer);
    cookieChangeTimer = setTimeout(async () => {
      try {
        const touched = authCookieTouched;
        authCookieTouched = false;
        await resync();
        // 로그인과 무관한 쿠키만 바뀐 경우엔 로그인 상태 확인(네트워크 요청)을 건너뜀
        if (!touched) return;
        const prev = await getLastAuthState();
        const auth = await checkAuthStatus();
        rememberAuthState(auth);
        if (prev !== auth.loggedIn) {
          const tabs = await chrome.tabs.query({});
          for (const t of tabs.filter(isViewTab)) {
            chrome.tabs.sendMessage(t.id, { type: 'mv:auth-changed', auth }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[My MultiView] 쿠키 변경 처리 실패', e);
      }
    }, 500);
  });
}

/* ---------------- 4. 메시지 핸들러 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'mv:ready') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      reply({ ok: false });
      return;
    }
    allowFramesInTab(tabId)
      .then(() => checkAuthStatus())
      .then((auth) => {
        rememberAuthState(auth);
        reply({ ok: true, auth });
      })
      .catch((err) => {
        console.error('[My MultiView] iframe 허용 규칙 실패', err);
        reply({ ok: false });
      });
    return true;
  }

  if (msg.type === 'mv:check-auth') {
    syncNaverCookies()
      .then(() => checkAuthStatus())
      .then((auth) => {
        rememberAuthState(auth);
        reply({ ok: true, auth });
      })
      .catch(() => reply({ ok: false, auth: { loggedIn: false } }));
    return true;
  }

  if (msg.type === 'mv:sync-cookies') {
    resync()
      .then(() => checkAuthStatus())
      .then((auth) => {
        rememberAuthState(auth);
        // 열려 있는 모든 멀티뷰 탭에도 알림
        chrome.tabs.query({}).then((tabs) => {
          for (const t of tabs.filter(isViewTab)) {
            chrome.tabs.sendMessage(t.id, { type: 'mv:auth-changed', auth }).catch(() => {});
          }
        }).catch(() => {});
        reply({ ok: true, auth });
      })
      .catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'mv:open-login') {
    const loginUrl =
      'https://nid.naver.com/nidlogin.login?mode=form&url=' +
      encodeURIComponent('https://chzzk.naver.com/');
    chrome.tabs.create({ url: loginUrl }).then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }

  // 다중 방어용 백그라운드 API 프록시 (CORS / 쿠키 문제 발생 시 폴백)
  if (msg.type === 'mv:fetch-api' && typeof msg.url === 'string') {
    (async () => {
      try {
        // 네이버/치지직 주소만 허용 (로그인 쿠키가 실린 요청이 다른 곳으로 나가지 않게)
        let target = null;
        try { target = new URL(msg.url); } catch {}
        if (!target || target.protocol !== 'https:' || !/(^|\.)naver\.com$/i.test(target.hostname)) {
          reply({ ok: false, error: 'blocked-url' });
          return;
        }
        if (!cachedCookieHeader) {
          await syncNaverCookies().catch(() => {});
        }
        const headers = {
          Accept: 'application/json',
          ...(cachedCookieHeader ? { Cookie: cachedCookieHeader } : {}),
          ...(msg.headers || {}),
        };
        const res = await fetch(msg.url, {
          method: msg.method || 'GET',
          credentials: 'include',
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          reply({ ok: false, status: res.status });
          return;
        }
        const data = await res.json();
        reply({ ok: true, data });
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // 치지직 사이트 등 외부에서 멀티뷰 열기 또는 기존 멀티뷰에 방송 추가
  if (msg.type === 'mv:open-multiview' && Array.isArray(msg.ids)) {
    const ids = msg.ids.filter((id) => typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id)).map((id) => id.toLowerCase());
    if (!ids.length) {
      reply({ ok: false });
      return;
    }
    chrome.tabs
      .query({ url: VIEW_URL + '*' })
      .then((tabs) => {
        const open = tabs.find((t) => t.id != null && isViewTab(t));
        if (open && msg.append !== false) {
          chrome.tabs.sendMessage(open.id, { type: 'mv:add', ids }, () => void chrome.runtime.lastError);
          chrome.tabs.update(open.id, { active: true });
          if (open.windowId != null) chrome.windows.update(open.windowId, { focused: true });
        } else {
          const q = ids.map((id) => `c=${encodeURIComponent(id)}`).join('&');
          chrome.tabs.create({ url: `${VIEW_URL}?${q}` });
        }
        reply({ ok: true });
      })
      .catch(() => reply({ ok: false }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 제목·소리 상태 등 사소한 변화마다 규칙을 다시 쓰지 않고, 페이지를 여는/옮기는 순간에만 적용
  if (!changeInfo || (changeInfo.status !== 'loading' && !changeInfo.url)) return;
  if (isViewTab(tab)) {
    allowFramesInTab(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropRule(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  resync();
});

resync();

/* ---------------- 5. 방송 시작/종료 알림 (다중 API 폴백) ---------------- */
const NOTIFY_ALARM = 'cmv-notify-check';
const NOTIFY_STATE_KEY = 'my-multiview:notifyState';

async function fetchLiveStatus(id) {
  const urls = [
    `https://api.chzzk.naver.com/polling/v2/channels/${id}/live-status`,
    `https://api.chzzk.naver.com/polling/v3/channels/${id}/live-status`,
    `https://api.chzzk.naver.com/service/v2/channels/${id}/live-detail`,
    `https://api.chzzk.naver.com/service/v3/channels/${id}/live-detail`,
    `https://api.chzzk.naver.com/service/v1/channels/${id}`,
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const body = await res.json();
      const c = body && body.content;
      if (!c) continue;
      if (c.status === 'OPEN' || c.status === 'CLOSE') return c.status;
      if (c.liveStatus === 'OPEN' || c.liveStatus === 'CLOSE') return c.liveStatus;
      if (typeof c.openLive === 'boolean') return c.openLive ? 'OPEN' : 'CLOSE';
    } catch {}
  }
  return null;
}

const NOTIFY_AT_KEY = 'my-multiview:notifyAt';
const NOTIFY_MIN_GAP_MS = 100 * 1000;
let notifyRunning = false;

async function checkNotify() {
  // 서비스 워커는 쿠키 변경 등으로 수시로 깨어나므로, 깨어날 때마다 전체 즐겨찾기를 조회하지 않게 간격 제한
  if (notifyRunning) return;
  notifyRunning = true;
  try {
    const store = await chrome.storage.local.get(['my-multiview:settings', NOTIFY_STATE_KEY, NOTIFY_AT_KEY]);
    const lastAt = Number(store && store[NOTIFY_AT_KEY]) || 0;
    if (Date.now() - lastAt < NOTIFY_MIN_GAP_MS) return;

    const s = (store && store['my-multiview:settings']) || {};
    if (s['my-multiview:notifyLive'] === '0') return;

    let favs = [];
    try {
      favs = JSON.parse(s['my-multiview:favorites'] || '[]');
    } catch {}
    if (!Array.isArray(favs) || !favs.length) return;

    await chrome.storage.local.set({ [NOTIFY_AT_KEY]: Date.now() }).catch(() => {});

    const prev = (store && store[NOTIFY_STATE_KEY]) || {};
    const next = {};
    const targets = favs.slice(0, 30).filter((f) => f && f.id);
    // 4개씩 묶어 동시에 조회 (한 개씩 차례로 하면 서비스 워커가 도중에 종료될 만큼 오래 걸림)
    for (let i = 0; i < targets.length; i += 4) {
      const group = targets.slice(i, i + 4);
      const statuses = await Promise.all(group.map((f) => fetchLiveStatus(f.id).catch(() => null)));
      group.forEach((f, j) => notifyOne(f, statuses[j], prev, next));
      if (i + 4 < targets.length) await new Promise((r) => setTimeout(r, 250));
    }
    const merged = { ...prev, ...next };
    await chrome.storage.local.set({ [NOTIFY_STATE_KEY]: merged }).catch(() => {});
  } catch {
  } finally {
    notifyRunning = false;
  }
}

function notifyOne(f, status, prev, next) {
  try {
    {
      const id = f.id;
      if (status) next[id] = status;
      const was = prev[id];
      const name = (f && f.name) || id.slice(0, 8);
      if (was === 'CLOSE' && status === 'OPEN') {
        chrome.notifications
          .create(`cmv-live-${id}-${Date.now()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: `${name} 방송 시작`,
            message: '클릭하면 멀티뷰에 추가됩니다',
          })
          .catch(() => {});
      } else if (was === 'OPEN' && status === 'CLOSE') {
        chrome.notifications
          .create(`cmv-live-${id}-${Date.now()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: `${name} 방송 종료`,
            message: '',
          })
          .catch(() => {});
      }
    }
  } catch {}
}

// 알림 클릭 → 이미 열린 멀티뷰가 있으면 기존 방송을 유지한 채 추가, 없으면 새로 열기
chrome.notifications.onClicked.addListener((nid) => {
  const m = /^cmv-live-([0-9a-f]{32})-/.exec(nid);
  chrome.notifications.clear(nid).catch(() => {});
  if (!m) return;
  const channelId = m[1];
  const url = `${VIEW_URL}?c=${channelId}`;
  chrome.tabs
    .query({ url: VIEW_URL + '*' })
    .then((tabs) => {
      const open = tabs.find((t) => t.id != null && isViewTab(t));
      if (open) {
        chrome.tabs.sendMessage(open.id, { type: 'mv:add', ids: [channelId] }, () => void chrome.runtime.lastError);
        chrome.tabs.update(open.id, { active: true });
        chrome.windows.update(open.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
    })
    .catch(() => {});
});

// 알람은 없을 때만 만든다 (깨어날 때마다 다시 만들면 타이머가 계속 초기화되어 제때 울리지 않음)
chrome.alarms
  .get(NOTIFY_ALARM)
  .then((a) => {
    if (!a) chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: 2 });
  })
  .catch(() => chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: 2 }));
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === NOTIFY_ALARM) checkNotify();
});
checkNotify();

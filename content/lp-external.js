/**
 * My MultiView - 따로 연 치지직 탭(멀티뷰 밖)에서 통나무 수집 방 우선
 *
 * 멀티뷰가 열려 있고 통나무 자동 수집이 켜져 있으면, 이 탭에 그 상태를 <html> data 값으로 적어 둔다.
 * 실제로 주기적 시청 신호(WATCH_CONTINUED)를 보내지 않는 일은 watch-guard-main.js(MAIN 월드)가 한다.
 *  - 이 탭이 통나무 수집 방송과 같은 방송이면 막지 않음
 *  - 멀티뷰를 닫거나 통나무 수집을 끄면 원래대로
 */
(() => {
  if (window.top !== window) return; // 멀티뷰 칸(iframe)은 tile.js가 처리
  try {
    if (new URLSearchParams(location.search).get('cmv_page') === '1') return;
  } catch {}

  const LP_KEY = 'my-multiview:lp';
  const ALIVE_KEY = 'my-multiview:viewAlive';
  const ALIVE_MS = 90 * 1000; // 멀티뷰가 30초마다 남기는 '열려 있음' 표시가 이 시간 안이면 열린 것으로 봄

  let lp = '';
  let aliveAt = 0;

  const channelOfPage = () => ((location.pathname.match(/\/live\/([0-9a-f]{32})/i) || [])[1] || '').toLowerCase();

  function apply() {
    const de = document.documentElement;
    if (!de) return;
    const on = /^[0-9a-f]{32}$/.test(lp) && Date.now() - aliveAt < ALIVE_MS;
    de.dataset.cmvLpAny = on ? '1' : '0';
    de.dataset.cmvLpActive = on && channelOfPage() === lp ? '1' : '0';
  }

  function load() {
    chrome.storage.local
      .get([LP_KEY, ALIVE_KEY])
      .then((o) => {
        lp = String((o && o[LP_KEY]) || '').toLowerCase();
        aliveAt = Number((o && o[ALIVE_KEY]) || 0);
        apply();
      })
      .catch(() => {});
  }

  load();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LP_KEY]) lp = String(changes[LP_KEY].newValue || '').toLowerCase();
    if (changes[ALIVE_KEY]) aliveAt = Number(changes[ALIVE_KEY].newValue || 0);
    if (changes[LP_KEY] || changes[ALIVE_KEY]) apply();
  });
  // 치지직은 페이지 이동 없이 방송을 바꾸므로(SPA) 주기적으로 다시 판단
  setInterval(apply, 5000);
})();

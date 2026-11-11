/**
 * My MultiView - 치지직 직접 보기(standalone) 전용: 설정 → <html> dataset 전달
 *
 * MAIN 월드 스크립트(standalone-blind.js)는 chrome.storage를 직접 읽을 수 없어서,
 * 이 작은 ISOLATED 스크립트가 설정값을 읽어 <html> dataset으로 알려준다.
 * 멀티뷰 칸(iframe)에서는 동작하지 않으며, 멀티뷰 코드와 공유하는 상태가 없다.
 */
(() => {
  if (window.top !== window) return; // 멀티뷰 칸(iframe)에서는 동작 안 함
  try {
    if (new URLSearchParams(location.search).get('cmv_page') === '1') return;
  } catch {}
  if (!/^\/live\/[0-9a-f]{32}/i.test(location.pathname)) return;
  if (window.__cmvStandaloneFlags) return;
  window.__cmvStandaloneFlags = true;

  function apply() {
    try {
      chrome.storage.local.get('my-multiview:settings').then((o) => {
        const s = (o && o['my-multiview:settings']) || {};
        // 블라인드 원문 복원: 기본 켬 ('0'일 때만 끔)
        document.documentElement.dataset.cmvRestoreBlind = s['my-multiview:chatRestoreBlind'] === '0' ? '0' : '1';
      }).catch(() => {});
    } catch {}
  }
  apply();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['my-multiview:settings']) apply();
    });
  } catch {}
})();

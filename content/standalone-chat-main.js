/**
 * My MultiView - 치지직 직접 보기(standalone) 전용: 채팅 입력창 문구 자동 삽입 (페이지 쪽 실행 환경)
 *
 * 멀티뷰 칸(iframe)에서는 동작하지 않는다. 치지직 라이브 페이지를 직접 열었을 때만 동작하는 별도 코드로,
 * chat-main.js와 공유하는 상태나 메시지가 없어서 이 파일에서 에러가 나도 멀티뷰에는 영향을 주지 않는다.
 *
 * standalone-chat.js(ISOLATED)가 저장소 문구 클릭을 window.postMessage({ __cmvMainCmd: true, cmd: 'INSERT_CHAT', text })
 * 로 보내면, 이 스크립트가 치지직 입력창에 직접 친 것처럼 문구를 넣는다.
 * (React _valueTracker 호환 — 그냥 value만 바꾸면 치지직이 인식을 못 해서 전송 버튼이 안 켜짐)
 */
(() => {
  if (window.top !== window) return; // 멀티뷰 칸(iframe)에서는 동작 안 함
  try {
    if (new URLSearchParams(location.search).get('cmv_page') === '1') return;
  } catch {}
  if (!/^\/live\/[0-9a-f]{32}/i.test(location.pathname)) return;
  if (/\/live\/[^/]+\/chat/i.test(location.pathname)) return;

  if (window.__cmvStandaloneChatMain) return;
  window.__cmvStandaloneChatMain = true;

  const INPUT_SELECTORS = [
    'textarea[class*="live_chatting_input"]',
    'textarea[class*="chatting_input"]',
    'textarea[placeholder*="채팅"]',
    'textarea[placeholder*="메시지"]',
    '[contenteditable="true"][class*="chat"]',
    'textarea',
  ].join(',');

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
      insertIntoChatInput(e.data.text).catch(() => {});
    }
  });
})();

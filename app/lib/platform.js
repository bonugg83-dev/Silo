// Silo 플랫폼 창구
//
// 앱(패널 sidepanel.html, 테스트 화면 practice/practice.html)이 플랫폼에 부탁하는 일은 모두 이 창구로만 한다.
// 각 플랫폼이 앱 페이지를 열기 전에 window.siloPlatform 을 아래 모양대로 만들어 둔다.
//   데스크톱(Electron): desktop/preload-shim.js
//   태블릿(안드로이드): (예정)
// 모양은 일부러 크롬 확장 API의 일부와 같게 두었다(옛 확장 코드와 테스트를 그대로 쓰려고). 여기 적힌 것 말고는 쓰지 않는다.
//
// storage.local / storage.session
//   get(keys|null) → {key: value}     set({key: value})     remove(key|[keys])
//   local: 이 기기에 계속 남음. session: 앱을 닫으면 사라짐 (풀린 API 키는 여기에만)
// storage.onChanged.addListener((changes, area) => …)   changes: {key: {newValue, oldValue}}, area: 'local'|'session'
//
// tabs: 마이픽 사이트 화면과 사이트가 연 창(편집 화면 등), 테스트 화면
//   query({}) → [{id, url, title, active, windowId}]     get(id) → tab     getCurrent() → 이 페이지의 tab (테스트 화면)
//   create({url, active}) → tab (테스트 화면 열기)        update(id, {active: true}) → 그 창을 앞으로
//   onUpdated.addListener((id, change, tab) => …)  change.status === 'complete' 이면 쪽이 다 열림
//   onActivated.addListener(({tabId}) => …)
// windows.update(windowId, {focused: true})
// scripting.executeScript({target: {tabId}, world: 'MAIN', func, args}) → [{result}]
//   func 는 바깥 변수를 쓰지 않는 독립 함수(lib/page.js)라서 소스 문자열로 넘겨 실행해도 된다
// runtime.getURL(path) → 앱 안 파일 주소
// runtime.sendMessage(msg) → 응답     runtime.onMessage.addListener((msg, sender, sendResponse) => true|undefined)
//   패널 ↔ 테스트 화면 사이 (테스트 화면은 사이트가 아니라 앱 페이지라 함수 실행을 메시지로 부탁함)

const REQUIRED = [
  'storage.local.get', 'storage.local.set', 'storage.local.remove',
  'storage.session.get', 'storage.session.set', 'storage.session.remove',
  'storage.onChanged.addListener',
  'tabs.query', 'tabs.get', 'tabs.getCurrent', 'tabs.create', 'tabs.update',
  'tabs.onUpdated.addListener', 'tabs.onUpdated.removeListener', 'tabs.onActivated.addListener',
  'windows.update', 'scripting.executeScript',
  'runtime.getURL', 'runtime.sendMessage', 'runtime.onMessage.addListener',
];

/** 브라우저(크롬)에서 테스트로 열 때만: 크롬 확장 API가 곧 창구 (tests/harness.mjs) */
function chromeForTests() {
  const c = globalThis.chrome;
  if (!c?.storage?.local || !c?.tabs) return null;
  return { storage: c.storage, tabs: c.tabs, windows: c.windows, scripting: c.scripting, runtime: c.runtime };
}

const platform = globalThis.siloPlatform || chromeForTests();
if (!platform) throw new Error('Silo 앱 안에서만 열 수 있어요 (플랫폼 창구 없음).');
const missing = REQUIRED.filter((p) => typeof p.split('.').reduce((o, k) => o?.[k], platform) !== 'function');
if (missing.length) console.error('Silo 플랫폼 창구에 없는 기능:', missing.join(', '));

export default platform;

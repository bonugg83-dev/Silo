// 앱 페이지(sidepanel.html, practice.html)에 Silo 플랫폼 창구(window.siloPlatform, app/lib/platform.js)를 만들어 준다.
// 실제 일은 앱 본체(main.js)가 한다.
// 이 파일은 앱 자신의 페이지에만 들어가고, 마이픽 사이트 페이지에는 절대 들어가지 않는다.
const { ipcRenderer } = require('electron');

const L = { updated: [], activated: [], message: [], storage: [] };
const event = (k) => ({
  addListener: (f) => { L[k].push(f); },
  removeListener: (f) => { const i = L[k].indexOf(f); if (i >= 0) L[k].splice(i, 1); },
  hasListener: (f) => L[k].includes(f),
});
const cb = (p, done) => (typeof done === 'function' ? p.then(done) : p);

ipcRenderer.on('tabs:updated', (_e, id, change, tab) => L.updated.slice().forEach((f) => f(id, change, tab)));
ipcRenderer.on('tabs:activated', (_e, info) => L.activated.slice().forEach((f) => f(info)));
ipcRenderer.on('storage:changed', (_e, changes, area) => L.storage.slice().forEach((f) => f(changes, area)));
ipcRenderer.on('runtime:message', (_e, reqId, msg) => {
  let done = false;
  let async = false;
  const sendResponse = (r) => { if (!done) { done = true; ipcRenderer.send('runtime:response', reqId, r); } };
  for (const f of L.message.slice()) { if (f(msg, { id: 'silo' }, sendResponse) === true) async = true; }
  if (!async && !done) { done = true; ipcRenderer.send('runtime:response', reqId, undefined); }
});

function area(name) {
  const onChanged = {
    addListener: (f) => L.storage.push(f.__area = (c, a) => { if (a === name) f(c); }),
    removeListener: (f) => { const i = L.storage.indexOf(f.__area); if (i >= 0) L.storage.splice(i, 1); },
  };
  return {
    get: (k, done) => cb(ipcRenderer.invoke('storage:get', name, k === undefined ? null : k), done),
    set: (items, done) => cb(ipcRenderer.invoke('storage:set', name, items), done),
    remove: (k, done) => cb(ipcRenderer.invoke('storage:remove', name, k), done),
    clear: (done) => cb(ipcRenderer.invoke('storage:clear', name), done),
    onChanged,
  };
}

window.siloPlatform = {
  runtime: {
    getURL: (p) => 'silo://ext/' + String(p).replace(/^\//, ''),
    sendMessage: (msg, done) => cb(ipcRenderer.invoke('runtime:send', msg), done),
    onMessage: event('message'),
  },
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: event('storage'),
  },
  tabs: {
    query: (q, done) => cb(ipcRenderer.invoke('tabs:query', q || {}), done),
    get: (id, done) => cb(ipcRenderer.invoke('tabs:get', id), done),
    getCurrent: (done) => cb(ipcRenderer.invoke('tabs:getCurrent'), done),
    create: (p, done) => cb(ipcRenderer.invoke('tabs:create', p), done),
    update: (id, p, done) => cb(ipcRenderer.invoke('tabs:update', id, p), done),
    onUpdated: event('updated'),
    onActivated: event('activated'),
  },
  windows: {
    update: (id, p, done) => cb(ipcRenderer.invoke('windows:update', id, p), done),
  },
  scripting: {
    // func 는 바깥 변수를 쓰지 않는 독립 함수(lib/page.js 규칙)라서 소스 문자열로 넘겨도 된다
    executeScript: ({ target, func, args }, done) =>
      cb(ipcRenderer.invoke('scripting:exec', target.tabId, func.toString(), args || []), done),
  },
};
window.siloDesktop = { version: 1 };

// Claude API 호출은 앱 본체(main)가 대신 보낸다. 크롬 확장은 host_permissions 덕분에 CORS 없이 바로 보내는데,
// 앱 화면(silo://)에서 바로 보내면 컴퓨터·네트워크에 따라 "Failed to fetch" 로 막힐 수 있다.
// 연결이 실패하면 진짜 이유(net::ERR_...)를 오류 글에 붙인다.
// Claude API와 온라인 계정(Firebase) 주소만 앱 본체가 대신 보낸다
const API_HOSTS = /^https:\/\/(api\.anthropic\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firestore\.googleapis\.com)\//;
const pageFetch = window.fetch.bind(window);
let apiSeq = 0;
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!API_HOSTS.test(url)) return pageFetch(input, init);
  const id = ++apiSeq;
  const { signal } = init;
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const onAbort = () => ipcRenderer.send('api:abort', id);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const r = await ipcRenderer.invoke('api:fetch', id, url, { method: init.method || 'GET', headers, body: init.body == null ? undefined : String(init.body) });
    if (r.aborted || signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (r.error) throw new TypeError(`${/anthropic/.test(url) ? 'Claude 서버' : '계정 서버'}에 연결하지 못했어요 (${r.error}). 인터넷 연결이나 보안 프로그램을 확인해 주세요.`);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
};

ipcRenderer.send('shim:hello');

// 패널이 로그인 화면(auth-open), 시작 모션(splashing)을 열면 앱이 패널을 창 전체로 넓힌다. 검수 창(review-open)은 패널 안에서 열림.
// 시작 모션은 패널이 처음 그려질 때 바로 시작하므로, 오늘 아직 안 봤으면 미리 창 전체로 넓혀 둔다
// (확장 lib/splash.js 와 같은 기준: localStorage "silo-splash-day", 움직임 줄이기 설정).
if (location.pathname === '/sidepanel.html') {
  let expectSplash = false;
  // 시작 모션이 끝나는 자리 = 위쪽 막대 로고 (패널 머리의 로고는 앱에서 숨겨짐)
  window.__siloDockRect = () => { try { return ipcRenderer.sendSync('bar:brand-get'); } catch { return null; } };
  // 데스크톱 앱은 켤 때마다 시작 모션을 보여 준다 (확장은 하루 한 번): 앱을 켠 뒤 패널이 처음 뜰 때 "오늘 봄" 기록을 지움
  try { if (ipcRenderer.sendSync('splash:first')) localStorage.removeItem('silo-splash-day'); } catch {}
  try {
    expectSplash = localStorage.getItem('silo-splash-day') !== new Date().toLocaleDateString('sv')
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {}
  // 켜는 중 덮개: 시작 모션이 끝날 때까지(모션이 없으면 첫 배치까지) 패널 글은 감추고 바탕은 검정.
  // 모션 캔버스만 보인다. 모션은 바탕색을 시작할 때 읽으므로 모션도 검정 바탕에서 나온다.
  const cover = document.createElement('style');
  cover.textContent = 'html,body{background:#000!important}body>:not(canvas.splash){visibility:hidden!important}';
  // 이 코드가 돌 때는 아직 <html>이 없을 수 있어서, 생기는 순간 붙인다
  let covered = true;
  const putCover = () => { if (covered && document.documentElement && !cover.isConnected) document.documentElement.appendChild(cover); return !!document.documentElement; };
  if (!putCover()) {
    const mo = new MutationObserver(() => { if (putCover()) mo.disconnect(); });
    mo.observe(document, { childList: true });
  }
  const uncover = () => { covered = false; cover.remove(); };
  // 시작 모션은 앱이 화면을 보여 준 뒤에 시작 (숨은 동안 창 크기를 읽으면 로고 크기·도착 자리가 틀어짐)
  window.__siloSplashReady = Promise.race([
    ipcRenderer.invoke('boot:revealed').catch(() => true),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  let last = '';
  const send = (mode) => {
    const k = JSON.stringify(mode);
    if (k === last) return;
    last = k;
    ipcRenderer.send('layout:mode', mode);
    // 오른쪽 패널로 붙어 있을 때는 로고가 위쪽 막대에 있으므로 패널 머리의 로고는 숨김 (창 전체일 때는 보임)
    side = !mode.auth && !mode.splash;
    document.documentElement?.classList.toggle('silo-side', side);
  };
  let side = false;
  if (expectSplash) send({ review: false, auth: false, splash: true });
  let sawSplash = false;
  const report = () => {
    const c = document.body.classList;
    if (c.contains('splashing')) sawSplash = true;
    const splash = c.contains('splashing') || (expectSplash && !sawSplash);
    if (!splash) uncover(); // 모션이 끝났거나 없음 → 패널 글을 보여 줌 (모션 캔버스가 흐려지며 드러남)
    send({ review: c.contains('review-open'), auth: c.contains('auth-open'), splash });
  };
  // 모션이 끝내 시작되지 않으면(글꼴 실패 등) 화면이 보인 뒤 잠시 뒤 원래 배치로
  window.__siloSplashReady.then(() => setTimeout(() => { expectSplash = false; if (document.body) report(); else uncover(); }, 3000));
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = 'html.silo-side .hd .brand{visibility:hidden}';
    document.head.appendChild(style);
    document.documentElement.classList.toggle('silo-side', side);
    new MutationObserver(report).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    report();
  });
}

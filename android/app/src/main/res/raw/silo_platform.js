// 태블릿(안드로이드)의 Silo 플랫폼 창구. 앱 페이지(패널, 테스트 화면)가 시작되기 전에 들어간다 (MainActivity: 문서 시작 스크립트).
// 모양은 app/lib/platform.js 에 적힌 것과 같다. 실제 일은 안드로이드 쪽(SiloNative 다리)이 한다:
//   SiloNative.call(id, method, argsJson)  →  window.__siloNative.resolve(id, ok, value) 로 답이 옴
//   안드로이드 → 패널 알림: window.__siloNative.emit(name, ...)
(function () {
  if (window.siloPlatform || typeof SiloNative === 'undefined') return;
  let seq = 0;
  const waiting = new Map();
  const L = { updated: [], activated: [], message: [], storage: [] };

  window.__siloNative = {
    resolve(id, ok, value) {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (ok) w.res(value); else w.rej(new Error(String(value)));
    },
    emit(name, a, b, c) {
      if (name === 'message') return onMessage(a, b, c);
      for (const f of (L[name] || []).slice()) {
        try { f(a, b, c); } catch (e) { console.error(e); }
      }
    },
  };
  const call = (method, ...args) => new Promise((res, rej) => {
    const id = String(++seq);
    waiting.set(id, { res, rej });
    SiloNative.call(id, method, JSON.stringify(args));
  });
  // 다른 앱 페이지가 보낸 메시지(패널 ↔ 테스트 화면). 답은 한 번만, 아무도 답하지 않으면 빈 답
  function onMessage(msg, sender, reqId) {
    let done = false;
    let async = false;
    const sendResponse = (r) => { if (!done) { done = true; SiloNative.respond(reqId, JSON.stringify(r === undefined ? null : r)); } };
    for (const f of L.message.slice()) {
      try { if (f(msg, sender || { id: 'silo' }, sendResponse) === true) async = true; } catch (e) { console.error(e); }
    }
    if (!async && !done) { done = true; SiloNative.respond(reqId, 'null'); }
  }
  const cb = (p, done) => (typeof done === 'function' ? p.then(done) : p);
  const event = (k) => ({
    addListener: (f) => { L[k].push(f); },
    removeListener: (f) => { const i = L[k].indexOf(f); if (i >= 0) L[k].splice(i, 1); },
    hasListener: (f) => L[k].includes(f),
  });
  const area = (name) => ({
    get: (k, done) => cb(call('storage.get', name, k === undefined ? null : k), done),
    set: (items, done) => cb(call('storage.set', name, items || {}), done),
    remove: (k, done) => cb(call('storage.remove', name, k), done),
    clear: (done) => cb(call('storage.clear', name), done),
    onChanged: { addListener: (f) => L.storage.push(f.__area = (c, a) => { if (a === name) f(c); }) },
  });

  window.siloPlatform = {
    storage: { local: area('local'), session: area('session'), onChanged: event('storage') },
    tabs: {
      query: (q, done) => cb(call('tabs.query', q || {}), done),
      get: (id, done) => cb(call('tabs.get', id), done),
      getCurrent: (done) => cb(call('tabs.getCurrent'), done), // 테스트 화면이면 그 탭, 패널이면 없음
      create: (p, done) => cb(call('tabs.create', p || {}), done),
      update: (id, p, done) => cb(call('tabs.update', id, p || {}), done),
      onUpdated: event('updated'),
      onActivated: event('activated'),
    },
    windows: { update: (id, p, done) => cb(Promise.resolve({ id }), done) },
    scripting: {
      // func 는 바깥 변수를 쓰지 않는 독립 함수(app/lib/page.js)라서 소스 문자열로 넘겨도 된다
      executeScript: ({ target, func, args }, done) =>
        cb(call('scripting.exec', target.tabId, func.toString(), args || []).then((result) => [{ result, frameId: 0 }]), done),
    },
    runtime: {
      getURL: (p) => `${location.origin}/assets/${String(p).replace(/^\//, '')}`,
      sendMessage: (msg, done) => cb(call('runtime.send', msg), done), // 다른 앱 페이지(패널 ↔ 테스트 화면)로
      onMessage: event('message'),
    },
  };
  window.siloTablet = { version: 1 };

  // ---- 시작 모션과 화면 배치 (패널에서만) ----
  if (!/\/sidepanel\.html$/.test(location.pathname)) return;
  // 앱을 켤 때마다 시작 모션 (확장 시절의 "하루 한 번" 기록을 지움)
  try { if (SiloNative.firstLoad()) localStorage.removeItem('silo-splash-day'); } catch {}
  // 시작 모션이 끝나는 자리 = 오른쪽 패널로 줄어든 뒤의 패널 머리 로고 자리
  window.__siloDockRect = () => {
    const b = document.getElementById('brand');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    let s = { dx: 0, dy: 0 };
    try { s = JSON.parse(SiloNative.dockShift()); } catch {}
    return { left: r.left + s.dx, top: r.top + s.dy, width: r.width, height: r.height };
  };
  // 로그인 화면(auth-open)과 시작 모션(splashing) 동안은 패널이 화면 전체
  let expectSplash = false;
  try {
    expectSplash = localStorage.getItem('silo-splash-day') !== new Date().toLocaleDateString('sv')
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {}
  let last = '';
  let sawSplash = false;
  const send = (mode) => {
    const k = JSON.stringify(mode);
    if (k === last) return;
    last = k;
    try { SiloNative.layoutMode(k); } catch {}
  };
  if (expectSplash) send({ review: false, auth: false, splash: true });
  const report = () => {
    const c = document.body.classList;
    if (c.contains('splashing')) sawSplash = true;
    send({ review: c.contains('review-open'), auth: c.contains('auth-open'), splash: c.contains('splashing') || (expectSplash && !sawSplash) });
  };
  setTimeout(() => { expectSplash = false; if (document.body) report(); }, 4000); // 모션이 끝내 시작되지 않으면
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(report).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    report();
  });
})();

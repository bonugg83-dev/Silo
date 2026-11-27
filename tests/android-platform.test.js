// 태블릿 플랫폼 창구(android/.../res/raw/silo_platform.js)를 가짜 안드로이드 다리(SiloNative)로 시험
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../android/app/src/main/res/raw/silo_platform.js', import.meta.url), 'utf8');

function load() {
  const calls = [];
  const layouts = [];
  const store = { local: {}, session: {} };
  const win = {
    location: { origin: 'https://appassets.androidplatform.net' },
    localStorage: { getItem: () => null, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    setTimeout: () => 0,
    document: { getElementById: () => ({ getBoundingClientRect: () => ({ left: 10, top: 5, width: 40, height: 20 }) }) },
  };
  win.window = win;
  // 안드로이드 쪽 흉내: 저장은 바로 답하고, 바뀌면 storage 알림
  win.SiloNative = {
    call(id, method, argsJson) {
      const a = JSON.parse(argsJson);
      calls.push({ method, a });
      const ok = (v) => queueMicrotask(() => win.__siloNative.resolve(id, true, v));
      if (method === 'storage.get') {
        const s = store[a[0]];
        ok(a[1] === null ? { ...s } : Object.fromEntries([].concat(a[1]).filter((k) => k in s).map((k) => [k, s[k]])));
      } else if (method === 'storage.set') {
        const changes = {};
        for (const [k, v] of Object.entries(a[1])) { changes[k] = { oldValue: store[a[0]][k], newValue: v }; store[a[0]][k] = v; }
        ok(null);
        queueMicrotask(() => win.__siloNative.emit('storage', changes, a[0]));
      } else if (method === 'scripting.exec') {
        ok({ ran: a[1].slice(0, 8), args: a[2] });
      } else if (method === 'tabs.create') {
        queueMicrotask(() => win.__siloNative.resolve(id, false, '다음 버전'));
      } else ok([]);
    },
    firstLoad: () => true,
    dockShift: () => JSON.stringify({ dx: 800, dy: 48 }),
    layoutMode: (j) => layouts.push(JSON.parse(j)),
  };
  vm.runInNewContext(src, win);
  return { win, calls, layouts, p: win.siloPlatform };
}

test('저장: set → get, 바뀌면 storage 알림 (local/session 구분)', async () => {
  const { p } = load();
  const seen = [];
  p.storage.onChanged.addListener((c, area) => seen.push([Object.keys(c), area]));
  let localOnly = 0;
  p.storage.local.onChanged.addListener(() => localOnly++);
  await p.storage.local.set({ a: 1 });
  await p.storage.session.set({ b: 2 });
  assert.equal(JSON.stringify(await p.storage.local.get('a')), '{"a":1}');
  assert.equal(JSON.stringify(await p.storage.session.get(null)), '{"b":2}');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, [[['a'], 'local'], [['b'], 'session']]);
  assert.equal(localOnly, 1);
});

test('편집 화면에서 함수 실행: 함수를 소스 글자로 넘기고 [{result}] 모양으로 받음', async () => {
  const { p, calls } = load();
  function pageRead(x) { return x; }
  const r = await p.scripting.executeScript({ target: { tabId: 3 }, world: 'MAIN', func: pageRead, args: [7] });
  assert.equal(r[0].result.ran, 'function');
  assert.deepEqual(r[0].result.args, [7]);
  assert.equal(calls.at(-1).a[0], 3);
});

test('실패는 오류로, 콜백 방식도 됨, 앱 파일 주소', async () => {
  const { p } = load();
  await assert.rejects(p.tabs.create({ url: 'x' }), /다음 버전/);
  const got = await new Promise((res) => p.tabs.query({}, res));
  assert.deepEqual(got, []);
  assert.equal(p.runtime.getURL('practice/practice.html'), 'https://appassets.androidplatform.net/assets/practice/practice.html');
});

test('시작 모션: 처음부터 패널 전체, 모션이 끝나는 자리는 오른쪽 패널 기준으로 옮김', () => {
  const { win, layouts } = load();
  assert.equal(JSON.stringify(layouts[0]), JSON.stringify({ review: false, auth: false, splash: true }));
  assert.equal(JSON.stringify(win.__siloDockRect()), JSON.stringify({ left: 810, top: 53, width: 40, height: 20 }));
});

test('app/lib/platform.js 가 요구하는 기능을 모두 갖춤', async () => {
  const { p } = load();
  const req = fs.readFileSync(new URL('../app/lib/platform.js', import.meta.url), 'utf8').match(/const REQUIRED = \[([\s\S]*?)\];/)[1]
    .match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const missing = req.filter((k) => typeof k.split('.').reduce((o, x) => o?.[x], p) !== 'function');
  assert.deepEqual(missing, []);
});

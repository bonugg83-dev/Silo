// 계정(회원가입·로그인)이 있는 확장으로 하는 데스크톱 흐름 테스트
//   시작 모션(창 전체) → 회원가입 화면(창 전체, 위쪽 막대·사이트 숨김) → 가입하면 배치 A
//   → 사람마다 마이픽 로그인 따로 → 로그아웃하면 다시 로그인 화면 → 다른 사람 가입/로그인 → 각자 키로 교정
// 확장에 lib/profiles.js 가 없으면(계정 기능 전) 건너뜀.
// 실행: SILO_EXT=<확장 폴더> xvfb-run -a node test/e2e-accounts.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extDir = path.resolve(process.env.SILO_EXT || path.join(root, '..', 'extension'));
if (!fs.existsSync(path.join(extDir, 'lib', 'profiles.js'))) {
  console.log('건너뜀: 이 확장에는 계정 기능(lib/profiles.js)이 없어요');
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SILO_SHOT;
const KEY_A = 'sk-ant-api03-AAAAKEY_abcdefghijklmnopqrstuvwxyz1111';
const KEY_B = 'sk-ant-api03-BBBBKEY_abcdefghijklmnopqrstuvwxyz2222';

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_EXT: extDir, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'silo-acc-')) },
});
async function find(re, timeout = 10000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('화면 없음: ' + re);
}
const silo = (fn) => app.evaluate(({}, src) => eval(src)(globalThis.__silo), fn.toString());
const mock = () => app.evaluate(() => globalThis.__mock);
const bounds = () => silo((s) => s.bounds());
const errors = [];
const panel = await find(/^silo:\/\/ext\/sidepanel\.html/);
panel.on('pageerror', (e) => errors.push(e.message));
panel.on('dialog', (d) => d.accept());

// 시작 모션 → 회원가입 화면, 둘 다 창 전체
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 5000 });
await panel.waitForFunction(() => !document.querySelector('canvas.splash') && !document.body.classList.contains('splashing'), null, { timeout: 10000 });
await panel.waitForFunction(() => document.body.classList.contains('auth-open'), null, { timeout: 5000 });
await sleep(300);
let b = await bounds();
assert.equal(b.panel.width, b.win[0], '로그인 전에는 패널이 창 전체');
assert.equal(b.panel.y, 0, '위쪽 막대 숨김');
assert.equal(b.site.width, 0, '사이트 숨김');
if (shots) await panel.screenshot({ path: path.join(shots, 'desk-signup.png') });
console.log('✓ 시작 모션 → 회원가입 화면 (창 전체)');

async function signup(name, key) {
  if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
  await panel.fill('#newName', name);
  await panel.fill('#newPw1', 'pw-' + name);
  await panel.fill('#newPw1b', 'pw-' + name);
  if (await panel.isVisible('#newKey')) await panel.fill('#newKey', key);
  await panel.click('#btnSignup');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'), null, { timeout: 15000 });
  await sleep(500);
}
async function logout() {
  await panel.click('#btnOpenSettings');
  await panel.click('#btnLogout');
  await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
  await sleep(300);
}
async function login(name) {
  if (await panel.isVisible('#toLogin')) await panel.click('#toLogin');
  await panel.fill('#loginId', name);
  await panel.fill('#loginPw', 'pw-' + name);
  await panel.click('#btnLogin');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'), null, { timeout: 15000 });
  await sleep(500);
}
const pid = () => panel.evaluate(async () => (await chrome.storage.local.get('activeProfileId')).activeProfileId);
async function sitePage() {
  const id = await silo((s) => s.siteId());
  for (let t = 0; t < 5000; t += 100) {
    for (const w of app.windows()) {
      if (!/mypickebook\.org\/$/.test(w.url())) continue;
      // 지금 사이트 화면인지 확인
      const same = await app.evaluate(({ webContents }, [u, i]) => webContents.fromId(i)?.getURL() === u, [w.url(), id]);
      if (same) { await w.waitForLoadState(); return w; }
    }
    await sleep(100);
  }
  throw new Error('사이트 화면 없음');
}

// A 가입 → 배치 A, A의 로그인 칸
await signup('kim', KEY_A);
const pidA = await pid();
b = await bounds();
assert.equal(b.panel.width, 420);
assert.ok(b.site.width > 600 && b.panel.y === 48);
assert.equal(await silo((s) => s.partition()), `persist:mypick-${pidA}`);
let site = await sitePage();
await site.evaluate(() => { document.cookie = 'login=kim; path=/; max-age=3600'; });
console.log('✓ 가입하면 배치 A, 마이픽 로그인은 kim 전용');

// A로 교정 → A 키로 호출
await panel.click('#btnCloseSettings').catch(() => {});
await site.click('#editPopup');
const editor = await find(/make_book\.html/);
await editor.waitForFunction(() => window.CKEDITOR && CKEDITOR.instances.content);
if ((await panel.getAttribute('#btnAuto', 'aria-checked')) === 'true') await panel.click('#btnAuto');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#result[data-state="done"]', { timeout: 30000 });
await panel.waitForFunction(() => !document.querySelector('#btnAnalyze').classList.contains('on'), null, { timeout: 30000 });
assert.equal((await mock()).apiCalls.at(-1).key, KEY_A);
if (shots) {
  await sleep(300);
  require('node:child_process').execSync(`import -window root ${path.join(shots, 'desk-main.png')}`);
}
console.log('✓ kim 키로 교정');

// 로그아웃 → 로그인 화면(창 전체), 편집 화면 창은 그대로 두지만 사이트는 숨김
await logout();
b = await bounds();
assert.equal(b.site.width, 0);
if (shots) await panel.screenshot({ path: path.join(shots, 'desk-login.png') });

// B 가입 → B의 마이픽 로그인은 비어 있음, A의 편집 화면 창은 닫힘
await signup('lee', KEY_B);
const pidB = await pid();
assert.notEqual(pidA, pidB);
assert.equal(await silo((s) => s.partition()), `persist:mypick-${pidB}`);
site = await sitePage();
assert.equal(await site.evaluate(() => document.cookie), '', 'lee는 kim의 마이픽 로그인을 못 봄');
assert.ok(!app.windows().some((w) => /make_book\.html/.test(w.url())), 'kim이 열어 둔 편집 화면 창은 닫힘');
console.log('✓ 다른 사람 가입하면 마이픽 로그인 따로, 앞사람 편집 창 닫힘');

// 다시 A로 로그인 → A의 마이픽 로그인 그대로
await logout();
await login('kim');
assert.equal(await pid(), pidA);
site = await sitePage();
assert.match(await site.evaluate(() => document.cookie), /login=kim/);
console.log('✓ kim으로 다시 로그인하면 kim의 마이픽 로그인 그대로');

assert.deepEqual(errors, []);
await app.close();
console.log('모두 통과');

// 데스크톱 앱 전체 흐름 테스트 (가짜 마이픽 화면 + 가짜 Claude 응답)
//   사이트 → 편집하기(팝업) → 패널이 편집 화면을 찾음 → 교정 → 편집기에 넣기 → 자동 모드(쪽 이동·저장·그림 올리기)
//   → 검수 창 전체로 넓히기 → 가운데 막대로 패널 폭 조절 → 로그인 화면(auth-open) 동안 사이트 숨김
//   → 프로필마다 사이트 로그인(쿠키) 따로 → storage.session → 다시 켜도 설정 유지
// 실행: cd desktop && npm install && xvfb-run -a npm test   (리눅스 서버에서는 xvfb-run, PC에서는 그냥 npm test)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-desk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  return electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox'],
    env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_USER_DATA: userData },
  });
}
let app = await launch();
const errors = [];
async function find(re, timeout = 10000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('화면 없음: ' + re + ' / ' + app.windows().map((w) => w.url()).join(', '));
}
const silo = (fn, arg) => app.evaluate(({}, [src, a]) => eval(src)(globalThis.__silo, a), [fn.toString(), arg]);
const mock = () => app.evaluate(() => globalThis.__mock);

let panel = await find(/^silo:\/\/ext\/sidepanel\.html/);
panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
panel.on('dialog', (d) => d.accept());
const bar = await find(/^silo:\/\/app\/bar\.html/);
const home = await find(/mypickebook\.org\/$/);

// 사이트에는 평범한 크롬처럼 보이고, chrome.* 흉내가 들어가지 않음
assert.doesNotMatch(await home.evaluate(() => navigator.userAgent), /Electron|silo/i);
assert.equal(await home.evaluate(() => typeof window.chrome?.storage), 'undefined');
assert.equal(await home.evaluate(() => typeof window.siloDesktop), 'undefined');

// 시작 모션: 처음 켜면 창 전체(위쪽 막대도 숨김)에서 재생되고, 끝나면 배치 A
let b;
for (let t = 0; t < 3000; t += 50) { b = await silo((s) => s.bounds()); if (b.panel.width === b.win[0]) break; await sleep(50); }
assert.equal(b.panel.width, b.win[0], '시작 모션은 창 전체');
assert.equal(b.panel.y, 0);
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 5000 });
const cv = await panel.evaluate(() => document.querySelector('canvas.splash').getBoundingClientRect().width);
assert.equal(Math.round(cv), b.win[0], '모션 캔버스가 창 폭');
if (process.env.SILO_SHOT) { await sleep(1300); await panel.screenshot({ path: path.join(process.env.SILO_SHOT, 'splash.png') }); }
await panel.waitForFunction(() => !document.body.classList.contains('splashing'), null, { timeout: 8000 });
await sleep(300);
console.log('✓ 시작 모션 창 전체');
// 1. 키 넣기: 계정 기능이 있는 확장이면 회원가입, 없으면 설정에 키 추가
const KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234';
const accounts = fs.existsSync(path.join(process.env.SILO_EXT || path.join(root, '..', 'extension'), 'lib', 'profiles.js'));
if (accounts) {
  await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
  await panel.fill('#newName', 'tester');
  await panel.fill('#newPw1', 'abcd');
  await panel.fill('#newPw1b', 'abcd');
  await panel.fill('#newKey', KEY);
  await panel.click('#btnSignup');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
  await sleep(500);
} else {
  await panel.waitForFunction(() => document.body.classList.contains('settings-open'));
  await panel.fill('#newKeyName', 'A 키');
  await panel.fill('#newKeyValue', KEY);
  await panel.click('#btnSaveKey');
  await panel.waitForFunction(() => document.querySelectorAll('#keyList .key-row').length === 1);
  await panel.click('#btnCloseSettings');
}

// 배치: 왼쪽 사이트, 오른쪽 패널(기본 420)
b = await silo((s) => s.bounds());
assert.equal(b.panel.width, 420);
assert.ok(b.site.width > 600 && b.site.x === 0 && b.panel.x > b.site.width && b.panel.y === 48);
console.log('✓ 배치 A: 사이트', b.site.width, '+ 패널', b.panel.width);

// 2. 편집하기 → 팝업 편집 화면 → 패널이 그 창을 찾아 교정 → 넣기
// 가입하면 그 사람 로그인 칸으로 사이트 화면이 새로 만들어지므로 다시 찾음
const home2 = await find(/mypickebook\.org\/$/);
await home2.waitForLoadState();
await home2.click('#editPopup');
const editor = await find(/make_book\.html/);
await editor.waitForFunction(() => window.CKEDITOR && CKEDITOR.instances.content);
await panel.click('#btnAuto');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#result[data-state="done"]', { timeout: 30000 });
await panel.waitForFunction(() => !document.querySelector('#btnAnalyze').classList.contains('on'), null, { timeout: 30000 });
assert.match(await panel.inputValue('#output'), /151쪽 제목/);
assert.equal((await mock()).apiCalls[0].key, KEY);
// 목차: 편집 화면 창에서 목차 쪽(2쪽)을 가져와 Claude로 정리하고 책 기록에 저장
{
  const m0 = await mock();
  assert.equal(m0.tocCalls, 1, '목차 정리 호출 한 번');
  assert.equal(m0.tocImages, 2, '목차 이미지 2쪽');
  const toc = await panel.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => /^book:/.test(k)).map(([, v]) => v.toc || v.tocError));
  assert.ok(toc.some((t) => /@@\[1부 시작/.test(t)), '목차 저장됨: ' + toc);
  assert.equal(await panel.textContent('#tocStatus'), '');
}
await panel.click('#btnApply');
await panel.waitForSelector('#btnApply.full', { timeout: 20000 });
assert.match(await editor.evaluate(() => CKEDITOR.instances.content.getData()), /151쪽 제목/);
console.log('✓ 편집하기(팝업) → 목차 읽기 → 교정 → 편집기에 넣기');

// 3. 자동 모드 151 → 153
await panel.click('#btnOpenSettings');
await panel.click('#btnAdvanced');
await panel.fill('#paceMinSec', '2');
await panel.fill('#paceMaxSec', '3');
await panel.click('#btnSaveAdvanced');
await panel.click('#btnCloseSettings');
await panel.click('#btnAuto');
await panel.click('#btnAnalyze');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('마지막 쪽') || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: 120000 });
const autoErr = await panel.textContent('#error');
await panel.waitForFunction(() => !document.querySelector('#btnAnalyze').classList.contains('on'), null, { timeout: 60000 });
let m = await mock();
assert.match(editor.url(), /book_page=153/, autoErr);
assert.ok(m.saves.some((s) => s.page === 152 && s.gubun === 'next'));
assert.equal(m.uploads.length, 1);
assert.ok(!m.saves.some((s) => s.gubun === 'complete'), '최종 제출 없음');
console.log('✓ 자동 모드 153쪽까지, 저장', m.saves.length, '번, 그림 올리기', m.uploads.length, '번');

// 4. 검수: 오른쪽 패널 안에서 열림 (사이트는 그대로 보임)
await panel.click('#btnReview');
await panel.waitForFunction(() => document.body.classList.contains('review-open'));
await sleep(300);
b = await silo((s) => s.bounds());
assert.equal(b.panel.width, 420, '검수 중에도 패널 폭 그대로');
assert.ok(b.site.width > 0, '검수 중에도 사이트가 보임');
if (process.env.SILO_SHOT) {
  await panel.screenshot({ path: path.join(process.env.SILO_SHOT, 'review.png') });
}
await panel.evaluate(() => document.querySelector('#btnSheetBack')?.click());
await panel.waitForFunction(() => !document.body.classList.contains('review-open'));
await sleep(300);
b = await silo((s) => s.bounds());
assert.equal(b.panel.width, 420);
console.log('✓ 검수 창 전체 ↔ 원래 배치');

// 5. 가운데 막대 끌어서 패널 폭 바꾸기
const divider = await find(/^silo:\/\/app\/divider\.html/);
// (가짜 마우스는 창이 바뀌면 실제 커서 위치가 끼어들어서, 막대 화면이 보내는 신호를 직접 보냄)
await divider.hover('#grip');
await divider.evaluate(() => silo.drag('start'));
await sleep(200);
assert.equal((await silo((s) => s.bounds())).divider.width, b.win[0], '끄는 동안 막대가 창 전체');
await divider.evaluate((x) => silo.drag('move', x), b.divider.x - 200);
await divider.evaluate(() => silo.drag('end'));
await sleep(300);
b = await silo((s) => s.bounds());
assert.ok(Math.abs(b.panel.width - 620) <= 12, '패널 폭 ' + JSON.stringify(b));
assert.equal(b.divider.width, 6, '끝나면 막대가 다시 얇아짐');
console.log('✓ 패널 폭 조절 →', b.panel.width);
if (process.env.SILO_SHOT) {
  await editor.close();
  await sleep(500);
  require('node:child_process').execSync(`import -window root ${path.join(process.env.SILO_SHOT, 'main.png')}`);
}

// 6. 로그인 화면(auth-open)이 떠 있는 동안 사이트를 숨김
await panel.evaluate(() => document.body.classList.add('auth-open'));
await sleep(300);
b = await silo((s) => s.bounds());
assert.equal(b.site.width, 0);
assert.equal(b.panel.width, b.win[0]);
assert.ok(await bar.evaluate(() => document.body.classList.contains('locked')), '막대의 이동 버튼 숨김');
await panel.evaluate(() => document.body.classList.remove('auth-open'));
await sleep(300);
b = await silo((s) => s.bounds());
assert.ok(b.site.width > 0);
console.log('✓ 로그인 화면 동안 사이트 숨김');

// 7. storage.session 과 onChanged
const sess = await panel.evaluate(async () => {
  const seen = [];
  chrome.storage.onChanged.addListener((c, area) => seen.push(area + ':' + Object.keys(c).join()));
  await chrome.storage.session.set({ unlock: { pid: 'p1', key: 'k' } });
  const got = await chrome.storage.session.get('unlock');
  await new Promise((r) => setTimeout(r, 100));
  return { got, seen };
});
assert.equal(sess.got.unlock.pid, 'p1');
assert.deepEqual(sess.seen, ['session:unlock']);
console.log('✓ storage.session');

// 8. 프로필(activeProfileId)마다 사이트 로그인 따로 (계정 기능이 있으면 e2e-accounts.mjs 가 실제 가입·로그인으로 시험)
if (!accounts) {
const setProfile = (id) => panel.evaluate((v) => (v ? chrome.storage.local.set({ activeProfileId: v }) : chrome.storage.local.remove('activeProfileId')), id);
const siteCookie = async () => {
  await sleep(400);
  const page = await find(/mypickebook\.org\/$/);
  await page.waitForLoadState();
  return page.evaluate(() => document.cookie);
};
await setProfile('user-a');
assert.equal(await silo((s) => s.partition()), 'persist:mypick-user-a');
let pg = await find(/mypickebook\.org\/$/);
await pg.evaluate(() => { document.cookie = 'login=A; path=/; max-age=3600'; });
await setProfile('user-b');
assert.equal(await siteCookie(), '', 'B는 A의 로그인을 못 봄');
pg = await find(/mypickebook\.org\/$/);
await pg.evaluate(() => { document.cookie = 'login=B; path=/; max-age=3600'; });
await setProfile('user-a');
assert.match(await siteCookie(), /login=A/, 'A로 돌아오면 A 로그인 그대로');
console.log('✓ 프로필마다 사이트 로그인 따로');
}

// 9. 다시 켜도 키·설정·패널 폭·프로필 유지, session 은 사라짐
await app.close();
app = await launch();
panel = await find(/^silo:\/\/ext\/sidepanel\.html/);
await panel.waitForLoadState();
// 데스크톱 앱은 켤 때마다 시작 모션
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 5000 });
await panel.waitForFunction(() => !document.querySelector('canvas.splash') && !document.body.classList.contains('splashing'), null, { timeout: 10000 });
console.log('✓ 다시 켜도 시작 모션');
const after = await panel.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
if (accounts) {
  assert.equal(after.local.profiles.length, 1, '계정 유지');
  await panel.waitForFunction(() => document.body.classList.contains('auth-open'), null, { timeout: 5000 });
  console.log('  (다시 켜면 로그인 화면부터)');
  await panel.fill('#loginId', 'tester');
  await panel.fill('#loginPw', 'abcd');
  await panel.click('#btnLogin');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
  await sleep(500);
} else {
  assert.equal(after.local.settings.keys.length, 1);
  assert.equal(after.local.activeProfileId, 'user-a');
}
assert.deepEqual(after.session, {}, 'session 은 비워짐');
b = await silo((s) => s.bounds());
assert.ok(Math.abs(b.panel.width - 620) <= 12, '다시 켜도 패널 폭 유지');
if (!accounts) assert.match(await siteCookie(), /login=A/);
console.log('✓ 다시 켜도 유지 (session 은 비워짐)');

assert.deepEqual(errors, []);
await app.close();
console.log('모두 통과');

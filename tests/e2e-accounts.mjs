// 계정 테스트: v0.9 이하에서 쓰던 평문 키·책 기록이 첫 회원가입 때 옮겨지는지, 로그인 화면 모양,
// 온라인 계정(가짜 Firebase): 가입 코드, 다른 컴퓨터에서 로그인, 인터넷이 끊겼을 때 로그인.
// 실행: node tests/e2e-accounts.mjs  (SHOTS=폴더 를 주면 로그인 화면 스크린숏)
import { appForChrome, APP_DIR } from './harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fakeFirebase } from './fake-firebase.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = appForChrome(); // app/을 크롬에 올릴 수 있게 복사 (tests/harness.mjs)
const OLD_KEY = 'sk-ant-api03-OLDKEY_abcdefghijklmnopqrstuvwxyz5678';

const userDataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'e2e-acc-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const fb = fakeFirebase('TESTCODE');
await fb.install(context);
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const errors = [];
const panel = await context.newPage();
panel.on('pageerror', (e) => errors.push(e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
// 예전 버전이 남긴 것: 평문 키 2개, 책 기록, 비용
await panel.evaluate((k) => chrome.storage.local.set({
  settings: { keys: [{ id: 'k1', name: '내 키', key: k }, { id: 'k2', name: '다른 키', key: k.replace('OLD', 'OLD2') }], activeKeyId: 'k1', model: 'claude-opus-5-5' },
  'book:23584': { lastOpened: Date.now(), pages: { 1: { text: 'x', at: Date.now() } } },
  [`cost:${new Date().toLocaleDateString('sv')}`]: 1.25,
}), OLD_KEY);
await panel.reload();
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
assert.ok(await panel.isVisible('#gateLogin'), '처음엔 로그인 화면 (다른 컴퓨터에서 만든 계정일 수 있음)');
await panel.click('#toSignup'); await panel.waitForFunction(() => document.activeElement?.id === 'newDisplayName', null, { timeout: 3000 }).catch(() => {}); // 가입 화면은 0.05초 뒤 이름 칸으로 포커스를 옮김
assert.ok(await panel.isVisible('#legacyFld'), '예전 키를 고를 수 있음');
assert.ok(!(await panel.isVisible('#newKeyFld')), '예전 키를 고르면 새 키 칸은 숨김');
assert.equal(await panel.locator('#legacyKey option').count(), 3);

if (process.env.SHOTS) {
  for (const [w, h] of [[360, 760], [1280, 820]]) {
    await panel.setViewportSize({ width: w, height: h });
    await panel.waitForTimeout(600);
    await panel.screenshot({ path: path.join(process.env.SHOTS, `signup-${w}.png`) });
  }
}

await panel.fill('#newDisplayName', '홍길동'); await panel.fill('#newName', 'maker');
await panel.fill('#newPw1', 'abcd');
await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newCode', 'WRONG');
await panel.click('#btnSignup');
await panel.waitForFunction(() => /가입 코드가 맞지 않아요/.test(document.querySelector('#gateMsg').textContent));
assert.equal(fb.users.size, 0, '코드가 틀리면 로그인 계정도 남기지 않음');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
const cloudDoc = [...fb.docs.values()][0];
assert.equal(cloudDoc.displayName?.stringValue, '홍길동', '이름이 계정 문서(Firestore users)에 남음');
assert.equal([...fb.users.values()][0].displayName, '홍길동', '이름이 로그인 계정(Authentication)에도 남음');
assert.ok(cloudDoc && !JSON.stringify([...fb.docs.values()]).includes('OLDKEY_'), '서버에는 잠긴 키만');
assert.ok(![...fb.users.values()][0].password.includes('abcd'), '서버로 원래 비밀번호를 보내지 않음');
const all = await panel.evaluate(() => chrome.storage.local.get(null));
const pid = all.profiles[0].id;
assert.ok(!JSON.stringify(all).includes('OLDKEY_'), '고른 예전 키는 평문에서 지움');
assert.equal(all.settings.keys.length, 1, '안 고른 키는 다음 가입 때 고를 수 있게 남음');
assert.ok(all[`book:${pid}:23584`] && !all['book:23584'], '책 기록을 첫 계정으로 옮김');
assert.equal(all[`costmonth:${pid}:${new Date().toLocaleDateString('sv').slice(0, 7)}`], 1.25);
assert.match(await panel.textContent('#costMonth'), /\$1\.25/);

// 로그아웃 → 로그인 화면
await panel.click('#btnOpenSettings');
await panel.fill('#monthlyLimit', '1');
await panel.dispatchEvent('#monthlyLimit', 'change');
await panel.waitForFunction(() => document.querySelector('#limitBar').classList.contains('over'));
assert.equal((await panel.evaluate(() => chrome.storage.local.get('profiles'))).profiles[0].monthlyLimit, 1);
await panel.click('#btnCloseSettings');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#error:not(.hidden)');
assert.match(await panel.textContent('#error'), /한도/, '월 한도를 넘으면 시작하지 않음');
await panel.click('#btnOpenSettings');
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.waitForTimeout(600);
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'settings.png') });
}
await panel.click('#btnLogout');
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
if (process.env.SHOTS) {
  for (const [w, h] of [[360, 760], [1280, 820]]) {
    await panel.setViewportSize({ width: w, height: h });
    await panel.waitForTimeout(600);
    await panel.screenshot({ path: path.join(process.env.SHOTS, `login-${w}.png`) });
  }
}

// 다른 컴퓨터: 이 컴퓨터 기록을 다 지우고 같은 아이디로 로그인
await panel.evaluate(() => chrome.storage.local.clear());
await panel.reload();
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
await panel.fill('#loginId', 'MAKER');
await panel.fill('#loginPw', 'abcd');
await panel.click('#btnLogin');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
await panel.waitForTimeout(600);
assert.ok(!(await panel.isVisible('#nameDlg')), '이름이 있는 계정은 묻지 않음');
const again = await panel.evaluate(() => chrome.storage.local.get(null));
assert.equal(again.profiles.length, 1);
assert.equal(again.profiles[0].monthlyLimit, 1, '월 한도도 따라옴');
assert.equal(again.settings.model, 'claude-opus-5-5', '설정도 따라옴');
await panel.waitForFunction(() => /\$/.test(document.querySelector('#costMonth').textContent));
await panel.click('#btnOpenSettings');
assert.match(await panel.textContent('#meKey'), /OLDKEY|sk-ant-a/);
await panel.click('#btnLogout');
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));

// 인터넷이 끊기면 이 컴퓨터의 마지막 계정으로
fb.offline = true;
await panel.fill('#loginId', 'maker');
await panel.fill('#loginPw', 'zzzz');
await panel.click('#btnLogin');
await panel.waitForFunction(() => /비밀번호가 맞지 않아요/.test(document.querySelector('#gateMsg').textContent));
await panel.fill('#loginPw', 'abcd');
await panel.click('#btnLogin');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
await panel.click('#btnOpenSettings');
await panel.click('#btnLogout');
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
fb.offline = false;

// 틀린 비밀번호 (온라인)
await panel.fill('#loginPw', 'zzzz');
await panel.click('#btnLogin');
await panel.waitForFunction(() => /맞지 않아요/.test(document.querySelector('#gateMsg').textContent));

// 예전 버전에서 이 컴퓨터에만 만든 계정: 가입 코드 받아 온라인으로 옮김
const { makeProfile } = await import('../app/lib/profiles.js');
const old = await makeProfile({ name: 'oldie', apiKey: OLD_KEY, password: 'qwer', iter: 1000 });
await panel.evaluate((p) => chrome.storage.local.get('profiles').then((r) => chrome.storage.local.set({ profiles: [...r.profiles, p], [`cost:${p.id}:${new Date().toLocaleDateString('sv')}`]: 0.5 })), old);
await panel.reload();
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
await panel.fill('#loginId', 'oldie');
await panel.fill('#loginPw', 'qwer');
await panel.click('#btnLogin');
await panel.waitForSelector('#loginCodeFld:not(.hidden)');
await panel.fill('#loginCode', 'TESTCODE');
await panel.click('#btnLogin');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
// 이름 없이 만든 계정: 로그인한 뒤 이름을 한 번 물어봄
await panel.waitForSelector('#nameDlg[open]', { timeout: 3000 });
await panel.click('#nameOk');
assert.match(await panel.textContent('#nameMsg'), /이름을 넣어/, '빈 이름은 저장 안 함');
await panel.fill('#nameInput', '  김 옛계정 ');
await panel.press('#nameInput', 'Enter');
await panel.waitForSelector('#nameDlg', { state: 'hidden' });
const moved = (await panel.evaluate(() => chrome.storage.local.get('profiles'))).profiles.find((p) => p.name === 'oldie');
assert.equal(moved.displayName, '김 옛계정');
const movedDoc = [...fb.docs.entries()].find(([k]) => k === `/users/${moved.uid}`)?.[1];
assert.equal(movedDoc?.displayName?.stringValue, '김 옛계정', '물어본 이름도 Firestore에 남음');
assert.equal([...fb.users.values()].find((u) => u.uid === moved.uid).displayName, '김 옛계정');
assert.ok(moved.uid && moved.id === old.id, '온라인으로 옮겨도 이 컴퓨터 기록 키는 그대로');
await panel.waitForFunction(() => [...document.querySelectorAll('#costMonth')].some((e) => /0\.50/.test(e.textContent)));

// 계정 지우기: 온라인 계정도 지움
await panel.click('#btnOpenSettings');
await panel.waitForTimeout(700);
await panel.click('#btnDeleteProfile');
// 브라우저 confirm 대신 앱 안 확인 창: 취소가 먼저 포커스, 빨간 지우기
await panel.waitForSelector('#askDlg[open]');
assert.equal(await panel.textContent('#askOk'), '지우기');
assert.ok(await panel.evaluate(() => document.getElementById('askOk').classList.contains('danger-solid')), '지우기는 빨간 버튼');
assert.equal(await panel.evaluate(() => document.activeElement?.id), 'askCancel', '취소가 먼저 포커스');
await panel.click('#askOk');
await panel.waitForFunction(() => document.body.classList.contains('auth-open'), null, { timeout: 8000 }).catch(async () => {
  throw new Error(`지우기 안 됨: ${await panel.textContent('#settingsMsg')}`);
});
assert.equal(fb.users.size, 1, '지운 계정은 서버에서도 사라짐');

// Claude 키 없이 Gemini 키만으로 가입 → Gemini 모델로 시작, 다시 로그인해도 됨
const GKEY = 'AIzaSyTESTGEMINIKEY_abcdefghijklmnop123';
let geminiChecks = 0;
await context.route(/generativelanguage\.googleapis\.com/, (route) => {
  geminiChecks++;
  const ok = route.request().headers()['x-goog-api-key'] === GKEY;
  return route.fulfill({ status: ok ? 200 : 400, contentType: 'application/json', body: JSON.stringify(ok ? { models: [] } : { error: { message: 'API key not valid' } }) });
});
await panel.click('#toSignup');
await panel.waitForFunction(() => document.activeElement?.id === 'newDisplayName', null, { timeout: 3000 }).catch(() => {});
await panel.fill('#newDisplayName', '박제미'); await panel.fill('#newName', 'gem'); await panel.fill('#newPw1', 'gggg'); await panel.fill('#newPw1b', 'gggg');
await panel.fill('#newCode', 'TESTCODE');
if (await panel.isVisible('#legacyKey')) await panel.selectOption('#legacyKey', '');
await panel.fill('#newKey', 'AIzaSyWRONGWRONGWRONGWRONGWRONG');
await panel.click('#btnSignup');
await panel.waitForFunction(() => /받지 않아요/.test(document.querySelector('#gateMsg').textContent));
await panel.fill('#newKey', GKEY);
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
assert.ok(geminiChecks >= 2, 'Gemini 키는 구글에 확인');
let gst = await panel.evaluate(() => chrome.storage.local.get(null));
let gp = gst.profiles.find((p) => p.name === 'gem');
assert.ok(!gp.enc && gp.genc && gp.gmask, 'Claude 키 없이 Gemini 키만 잠가 저장');
assert.match(gst.settings.model, /^gemini-/, 'Gemini 모델로 시작');
assert.ok(!JSON.stringify([...fb.docs.values()]).includes(GKEY), '서버에도 잠긴 키만');
await panel.click('#btnOpenSettings');
await panel.waitForTimeout(500);
assert.equal(await panel.textContent('#meKey'), '없음');
assert.equal(await panel.textContent('#btnChangeKey'), '키 넣기');
await panel.click('#btnDelGKey');
await panel.waitForFunction(() => /하나는 있어야/.test(document.querySelector('#settingsMsg').textContent));
await panel.click('#btnLogout');
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
await panel.evaluate(() => chrome.storage.local.clear()); // 다른 컴퓨터에서 로그인
await panel.reload();
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
await panel.fill('#loginId', 'gem'); await panel.fill('#loginPw', 'xxxx');
await panel.click('#btnLogin');
await panel.waitForFunction(() => /맞지 않아요|풀지 못했/.test(document.querySelector('#gateMsg').textContent));
await panel.fill('#loginPw', 'gggg');
await panel.click('#btnLogin');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
gst = await panel.evaluate(() => chrome.storage.local.get(null));
assert.match(gst.settings.model, /^gemini-/, '다른 컴퓨터에서도 Gemini 모델');
assert.equal((await panel.evaluate(() => chrome.storage.session.get('unlock'))).unlock.gkey, GKEY, 'Gemini 키가 풀림');

assert.deepEqual(errors, []);
console.log('통과: 예전 키·기록 옮기기, 가입 코드, 월 한도, 로그아웃, 다른 컴퓨터 로그인, 오프라인 로그인, 예전 계정 옮기기, 계정 지우기, Gemini 키만으로 가입');
await context.close();

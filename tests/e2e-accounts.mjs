// 계정 테스트: v0.9 이하에서 쓰던 평문 키·책 기록이 첫 회원가입 때 옮겨지는지, 로그인 화면 모양.
// 실행: node tests/e2e-accounts.mjs  (SHOTS=폴더 를 주면 로그인 화면 스크린숏)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(here, '../extension');
const OLD_KEY = 'sk-ant-api03-OLDKEY_abcdefghijklmnopqrstuvwxyz5678';

const userDataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'e2e-acc-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
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

await panel.fill('#newName', 'maker');
await panel.fill('#newPw1', 'abcd');
await panel.fill('#newPw1b', 'abcd');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
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
assert.deepEqual(errors, []);
console.log('통과: 예전 키·기록 옮기기, 월 한도, 로그아웃');
await context.close();

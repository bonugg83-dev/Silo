// 자동 업데이트 흐름 테스트 (가짜 업데이터)
//   켜면 새 버전을 찾아 받음 → 위쪽 막대에 "새 버전 9.9.9 · 다시 시작" 버튼
//   → 교정 중이면 눌러도 다시 시작하지 않고 안내 → 교정이 끝나면 조용히 설치하고 다시 켬
// 실행: cd desktop && xvfb-run -a node test/e2e-update.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_FAKE_UPDATE: path.join(here, 'fake-updater.js'),
    SILO_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'silo-upd-')) },
});
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re);
}
const fake = () => app.evaluate(() => ({ checks: globalThis.__fakeUpdater.checks, installs: globalThis.__fakeUpdater.installs }));
const panel = await find(/sidepanel\.html/);
const bar = await find(/bar\.html/);

// 시작 모션 → 가입
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 15000 });
await panel.waitForFunction(() => !document.querySelector('canvas.splash') && !document.body.classList.contains('splashing'), null, { timeout: 15000 });
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
if (await panel.isVisible('#toSignup')) await panel.click('#toSignup'); await panel.waitForFunction(() => document.activeElement?.id === 'newName', null, { timeout: 3000 }).catch(() => {}); // 가입 화면은 0.05초 뒤 이름 칸으로 포커스를 옮김: 그 전에 다른 칸을 채우면 글자가 이름 칸으로 감
await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));

// 새 버전을 받으면 버튼이 뜸
await bar.waitForSelector('#update:not([hidden])', { timeout: 10000 });
assert.match(await bar.textContent('#update'), /9\.9\.9/);
assert.ok((await fake()).checks >= 1);
console.log('✓ 새 버전을 받으면 위쪽 막대에 다시 시작 버튼');

// 교정 중이면 다시 시작하지 않음
await panel.evaluate(() => chrome.storage.session.set({ 'runlock:test': { owner: 'x', at: Date.now() } }));
await bar.click('#update');
await bar.waitForSelector('#toast:not([hidden])');
assert.match(await bar.textContent('#toast'), /교정이 끝난 뒤/);
await sleep(300);
assert.equal((await fake()).installs.length, 0, '교정 중에는 설치하지 않음');
console.log('✓ 교정 중에는 다시 시작하지 않고 안내');

// 교정이 끝나면 조용히 설치하고 다시 켬
await panel.evaluate(() => chrome.storage.session.remove('runlock:test'));
await bar.click('#update');
await sleep(300);
assert.deepEqual((await fake()).installs, [{ silent: true, runAfter: true }]);
console.log('✓ 누르면 조용히 설치하고 다시 켬');

await app.close();
console.log('모두 통과');

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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-upd-'));
const launch = () => electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_FAKE_UPDATE: path.join(here, 'fake-updater.js'), SILO_USER_DATA: userData },
});
let app = await launch();
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re);
}
const fake = () => app.evaluate(() => ({ checks: globalThis.__fakeUpdater.checks, installs: globalThis.__fakeUpdater.installs }));
let panel = await find(/sidepanel\.html/);
let bar = await find(/bar\.html/);

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

// 새 버전을 받으면 앱 전체를 흐리게 덮고 가운데에 안내 → 다음에 하기
const prompt = () => app.evaluate(() => globalThis.__silo.updatePrompt());
const upd = await find(/update\.html/);
for (let t = 0; t < 10000 && !(await prompt()); t += 100) await sleep(100);
assert.ok(await prompt(), '가운데 안내가 뜸');
await upd.waitForFunction(() => document.body.classList.contains('on') && document.querySelectorAll('#shots img').length >= 2);
assert.equal(await upd.textContent('#to'), '9.9.9');
assert.equal(await upd.textContent('#now'), '확인');
assert.equal(await upd.textContent('#later'), '다음에 하기');
if (process.env.SHOTS) await sleep(500), await upd.screenshot({ path: path.join(process.env.SHOTS, 'update-prompt.png') });
await upd.click('#later');
await sleep(300);
assert.equal(await prompt(), false, '다음에 하기를 누르면 닫힘');
assert.equal((await fake()).installs.length, 0, '다음에 하기는 설치하지 않음');
console.log('✓ 새 버전을 받으면 가운데 안내, 다음에 하기로 닫힘');

// 닫아도 위쪽 막대에 다시 시작 버튼은 남음
await bar.waitForSelector('#update:not([hidden])', { timeout: 10000 });
assert.match(await bar.textContent('#update'), /9\.9\.9/);
assert.ok((await fake()).checks >= 1);
console.log('✓ 위쪽 막대에 다시 시작 버튼이 남음');

// 교정 중이면 다시 시작하지 않음
await panel.evaluate(() => siloPlatform.storage.session.set({ 'runlock:test': { owner: 'x', at: Date.now() } }));
await bar.click('#update');
await bar.waitForSelector('#toast:not([hidden])');
assert.match(await bar.textContent('#toast'), /교정이 끝난 뒤/);
await sleep(300);
assert.equal((await fake()).installs.length, 0, '교정 중에는 설치하지 않음');
console.log('✓ 교정 중에는 다시 시작하지 않고 안내');

// 교정이 끝나면 조용히 설치하고 다시 켬
await panel.evaluate(() => siloPlatform.storage.session.remove('runlock:test'));
await bar.click('#update');
await sleep(300);
assert.deepEqual((await fake()).installs, [{ silent: true, runAfter: true }]);
console.log('✓ 누르면 조용히 설치하고 다시 켬');

await app.close();

// 업데이트 뒤 처음 켜면: 로그인하고 위쪽 막대가 보일 때 "새 버전 …로 업데이트했어요" 한 번
const prefsFile = path.join(userData, 'desktop.json');
const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
const ver = prefs.lastVersion;
assert.ok(ver, '지금 버전을 적어 둠');
fs.writeFileSync(prefsFile, JSON.stringify({ ...prefs, lastVersion: '0.0.1' }));
app = await launch();
panel = await find(/sidepanel\.html/);
bar = await find(/bar\.html/);
await panel.waitForFunction(() => document.body.classList.contains('auth-open') && !document.body.classList.contains('splashing'), null, { timeout: 20000 });
if (await panel.isVisible('#toLogin')) await panel.click('#toLogin');
await panel.fill('#loginId', 'kim');
await panel.fill('#loginPw', 'abcd');
await panel.press('#loginPw', 'Enter');
await bar.waitForSelector('#toast:not([hidden])', { timeout: 10000 });
assert.equal(await bar.textContent('#toast'), `새 버전 ${ver}로 업데이트했어요.`);
assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).lastVersion, ver);
console.log('✓ 업데이트 뒤 처음 켜면 한 번 알려 줌');

// 가운데 안내에서 확인을 누르면 바로 설치하고 다시 켬
const upd2 = await find(/update\.html/);
await upd2.waitForFunction(() => document.body.classList.contains('on'), null, { timeout: 10000 });
await upd2.click('#now');
await sleep(300);
assert.deepEqual((await fake()).installs, [{ silent: true, runAfter: true }]);
console.log('✓ 확인을 누르면 설치하고 다시 켬');
await app.close();
console.log('모두 통과');

// 쪽을 넘는 각주 잇기 (Gemini처럼 다음 쪽 설명에 새 번호를 붙이고, 모델이 알려 주지도 않는 경우)
//   자동 모드 151 → 153 끝 → 152쪽 [각주***] 자리에 153쪽 맨 위 "[각주*: 설명]"을 옮기고 153쪽 줄은 지움
// 실행: cd desktop && xvfb-run -a node test/e2e-footnotes.mjs
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
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_MOCK_FOOTNOTES: '1', SILO_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'silo-fn-')) },
});
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re);
}
const mock = () => app.evaluate(() => globalThis.__mock);
const panel = await find(/sidepanel\.html/);
panel.on('dialog', (d) => d.accept());
await panel.waitForFunction(() => document.body.classList.contains('auth-open') && !document.body.classList.contains('splashing'), null, { timeout: 20000 });
if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
await panel.waitForFunction(() => document.activeElement?.id === 'newName', null, { timeout: 3000 }).catch(() => {});
await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'), null, { timeout: 15000 });

// 쪽 넘김 간격 짧게
await panel.click('#btnOpenSettings');
await panel.click('#btnAdvanced');
await panel.fill('#paceMinSec', '1');
await panel.fill('#paceMaxSec', '2');
await panel.press('#paceMaxSec', 'Tab');
await panel.waitForFunction(() => /저장했어요/.test(document.querySelector('#advancedMsg').textContent));
await panel.click('#btnCloseSettings');

// 편집하기 → 자동 모드 151 → 153
const home = await find(/mypickebook\.org\/$/);
await home.waitForLoadState();
await home.click('#editPopup');
const editor = await find(/make_book\.html/);
await editor.waitForFunction(() => window.CKEDITOR && CKEDITOR.instances.content);
assert.equal(await panel.getAttribute('#btnAuto', 'aria-checked'), 'true', '자동 모드 기본 켜짐');
await panel.click('#btnAnalyze');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('마지막 쪽') || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: 180000 });
const progress = await panel.textContent('#progress');
console.log('끝 안내:', progress, await panel.textContent('#error'));
assert.match(progress, /쪽을 넘는 각주 1개도 이었어요/);

// 152쪽: 번호 자리에 설명이 들어가 다시 저장됨, 153쪽: 맨 위 설명 줄이 지워져 다시 저장됨
const saves = (await mock()).saves;
const last = (p) => [...saves].reverse().find((s) => s.page === p)?.content || '';
assert.match(last(152), /‘스메타나’\[각주\*\*\*: 이러한 설정은 연출적 장치로 해석할 수 있다\.\]에 대한/);
assert.ok(!/\[각주\*:/.test(last(153)), '153쪽 맨 위 설명 줄 지움: ' + last(153).slice(0, 80));
assert.match(last(153), /본문 153/);
console.log('✓ 번호가 다르고 모델이 알려 주지 않아도 자동 모드 끝에 각주를 앞쪽으로 옮김');
await app.close();
console.log('모두 통과');

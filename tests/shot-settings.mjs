// 설정 화면 스크린숏 (디자인 확인용)
// 실행: SHOTS=폴더 node tests/shot-settings.mjs  → settings-<폭>-<번호>.png
import { appForChrome } from './harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFirebase } from './fake-firebase.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.env.SHOTS || '.';
const extPath = appForChrome();
const userDataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shot-set-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true, channel: 'chromium', deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const fb = fakeFirebase('TESTCODE');
await fb.install(context);
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const panel = await context.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
await panel.waitForFunction(() => document.activeElement?.id === 'newName', null, { timeout: 3000 }).catch(() => {});
await panel.fill('#newName', 'bonwook526'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
await panel.click('#btnOpenSettings');
for (const [w, h] of [[420, 1100]]) {
  await panel.setViewportSize({ width: w, height: h });
  await panel.waitForTimeout(700);
  await panel.screenshot({ path: path.join(out, `settings-${w}-1.png`) });
  await panel.evaluate(() => { const s = document.querySelector('#settings'); s.scrollTop = s.scrollHeight; });
  await panel.click('label:has(#pacing)'); // 저장 안내도 보이게
  await panel.waitForTimeout(500);
  await panel.screenshot({ path: path.join(out, `settings-${w}-2.png`) });
}
await context.close();

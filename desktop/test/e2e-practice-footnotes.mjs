// 테스트 화면에서 쪽을 넘는 각주 잇기: 묶음 5쪽 가져오기 → 자동 모드 끝까지 → 3쪽 [각주***] 자리에 4쪽 맨 위 설명을 옮김
// 실행: cd desktop && xvfb-run -a node test/e2e-practice-footnotes.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-pfn-'));

const jpg = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, '../tests/fixtures/page.jpg')).toString('base64');
const pack = { type: 'silo-test-pack', version: 1, name: '각주 묶음',
  pages: [1, 2, 3, 4, 5].map((n) => ({ label: `${n}쪽`, pageNum: String(75 + n), image: jpg, ocr: [`OCR ${n}`], book: { title: '책' } })) };
const packFile = path.join(tmp, 'pack.json');
fs.writeFileSync(packFile, JSON.stringify(pack));

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_MOCK_FOOTNOTES: '3,4', SILO_USER_DATA: path.join(tmp, 'data') },
});
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re);
}
const panel = await find(/sidepanel\.html/);
const bar = await find(/bar\.html/);
const errors = [];
panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
panel.on('dialog', (d) => d.accept());
await panel.waitForFunction(() => document.body.classList.contains('auth-open') && !document.body.classList.contains('splashing'), null, { timeout: 20000 });
if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
await panel.waitForFunction(() => document.activeElement?.id === 'newName', null, { timeout: 3000 }).catch(() => {});
await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'), null, { timeout: 15000 });
await panel.click('#btnOpenSettings');
await panel.click('#btnAdvanced');
await panel.fill('#paceMinSec', '1');
await panel.fill('#paceMaxSec', '1');
await panel.press('#paceMaxSec', 'Tab');
await panel.waitForFunction(() => /저장했어요/.test(document.querySelector('#advancedMsg').textContent));
await panel.click('#btnCloseSettings');

// 테스트 화면 → 묶음 가져오기 → 1쪽
await bar.click('#practice');
let pv = await find(/practice\/practice\.html/);
pv.on('dialog', (d) => d.accept());
pv.on('pageerror', (e) => errors.push('practice: ' + e.message));
await pv.waitForLoadState();
await pv.setInputFiles('#packFile', packFile);
await pv.click('#btnImportPack');
await pv.waitForFunction(() => /5쪽을 가져왔어요/.test(document.querySelector('#packMsg')?.textContent || ''));

// 자동 모드 끝까지
await panel.click('#btnAnalyze');
for (let t = 0; t < 240; t += 3) {
  const st = await panel.evaluate(() => [document.querySelector('#progress').textContent, document.querySelector('#error').textContent, document.querySelector('#stepLine')?.textContent, document.querySelector('#btnAnalyze').className]);
  const pg = app.windows().find((w) => /practice\.html/.test(w.url()))?.url().match(/book_page=(\d+)/)?.[1];
  if (process.env.DEBUG) console.log(t + 's', '쪽', pg, JSON.stringify(st));
  if (st[0].includes('마지막 쪽') || st[1] || (t > 6 && !/\bon\b/.test(st[3]))) break;
  await sleep(3000);
}
await panel.waitForFunction(() => !document.querySelector('#btnAnalyze').classList.contains('on'), null, { timeout: 120000 });
const progress = await panel.textContent('#progress');
const err = await panel.textContent('#error');
console.log('끝 안내:', JSON.stringify(progress), '오류:', JSON.stringify(err));
const saved = (await panel.evaluate(() => siloPlatform.storage.local.get('practice:saved')))['practice:saved'] || {};
const links = await panel.evaluate(async () => Object.entries(await siloPlatform.storage.local.get(null)).filter(([k]) => /^book:/.test(k)).map(([, v]) => v.links));
console.log('연결:', JSON.stringify(links));
const issues = await panel.evaluate(async () => Object.entries(await siloPlatform.storage.local.get(null)).filter(([k]) => /^book:/.test(k)).map(([, v]) => ({ 3: v.pages[3]?.issues, 4: v.pages[4]?.issues })));
// 옮긴 뒤에는 검수 목록에서 "이어 붙임 / 앞쪽으로 옮김" 항목이 사라짐
for (const [p, list] of Object.entries(issues[0])) {
  assert.ok(!(list || []).some((x) => /각주\*\*\*/.test(x.text)), `${p}쪽 검수 항목에 각주가 남음: ${JSON.stringify(list)}`);
}
console.log('3쪽:', JSON.stringify(saved['3']?.content), '\n4쪽:', JSON.stringify(saved['4']?.content));
assert.deepEqual(errors, []);
assert.match(progress, /쪽을 넘는 각주 1개도 이었어요/);
assert.match(saved['3']?.content || '', /\[각주\*\*\*: 이러한 설정은 연출적 장치로 해석할 수 있다\.\]에 대한/);
assert.ok(!/\[각주\*\*\*:/.test(saved['4']?.content || ''), '4쪽 맨 위 설명 줄 지움');
console.log('✓ 테스트 화면: 자동 모드 끝에 각주를 앞쪽으로 옮김');

// 같은 쪽들을 한 번 더 교정(묶음 다시 가져오기 → 자동 모드): 지난번에 이은 기록이 있어도 다시 이어야 함
await pv.close().catch(() => {});
pv = await find(/practice\/practice\.html/).catch(() => null);
if (!pv) { await bar.click('#practice'); pv = await find(/practice\/practice\.html/); }
pv.on('dialog', (d) => d.accept());
await pv.waitForLoadState();
await pv.setInputFiles('#packFile', packFile);
await pv.click('#btnImportPack');
await pv.waitForFunction(() => /5쪽을 가져왔어요/.test(document.querySelector('#packMsg')?.textContent || ''));
await pv.waitForFunction(() => document.querySelector('#curr_page')?.value === '1');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#askDlg[open]', { timeout: 20000 }).then(() => panel.click('#askOk')).catch(() => {});
for (let t = 0; t < 240; t += 3) {
  const st = await panel.evaluate(() => [document.querySelector('#progress').textContent, document.querySelector('#error').textContent, document.querySelector('#btnAnalyze').className]);
  if (st[0].includes('마지막 쪽') || st[1] || (t > 6 && !/\bon\b/.test(st[2]))) break;
  await sleep(3000);
}
const progress2 = await panel.textContent('#progress');
const saved2 = (await panel.evaluate(() => siloPlatform.storage.local.get('practice:saved')))['practice:saved'] || {};
console.log('두 번째 끝 안내:', JSON.stringify(progress2), '\n3쪽:', JSON.stringify(saved2['3']?.content), '\n4쪽:', JSON.stringify(saved2['4']?.content));
assert.match(progress2, /쪽을 넘는 각주 1개도 이었어요/);
assert.match(saved2['3']?.content || '', /\[각주\*\*\*: 이러한 설정은/);
assert.ok(!/\[각주\*\*\*:/.test(saved2['4']?.content || ''), '두 번째에도 4쪽 맨 위 설명 줄 지움');
console.log('✓ 같은 쪽들을 다시 교정해도 다시 이음');
await app.close();
console.log('모두 통과');

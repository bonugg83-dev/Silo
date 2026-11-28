// 테스트 화면: 위쪽 막대 "테스트" 버튼 → 테스트 묶음 파일 가져오기 (쪽 이미지 + OCR + 책 정보)
// 실행: cd desktop && xvfb-run -a node test/e2e-testpack.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-pack-'));

// 작은 가짜 묶음 (저장소의 테스트 그림 사용)
const jpg = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, '../tests/fixtures/page.jpg')).toString('base64');
const pack = { type: 'silo-test-pack', version: 1, name: '가짜 묶음', pages: [
  { label: '1쪽', pageNum: '10', image: jpg, ocr: ['첫 줄 <꺾쇠>', '둘째 줄'], book: { title: '책 하나' } },
  { label: '2쪽', pageNum: '11', image: jpg, ocr: ['다른 책 쪽'], book: { title: '책 둘', author: '지은이 둘', publisher: '출판사 둘' } },
] };
const packFile = path.join(tmp, 'pack.json');
fs.writeFileSync(packFile, JSON.stringify(pack));

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_USER_DATA: path.join(tmp, 'data') },
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
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 15000 });
await panel.waitForFunction(() => !document.querySelector('canvas.splash') && !document.body.classList.contains('splashing'), null, { timeout: 15000 });
await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
await panel.waitForFunction(() => document.activeElement?.id === 'newDisplayName', null, { timeout: 3000 }).catch(() => {});
await panel.fill('#newDisplayName', '홍길동'); await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.fill('#newCode', 'TESTCODE');
await panel.click('#btnSignup');
await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));

// 버튼 이름은 "테스트"
assert.equal((await bar.textContent('#practice')).trim(), '테스트');
await bar.click('#practice');
const pv = await find(/practice\/practice\.html/);
await pv.waitForLoadState();
assert.match(await pv.title(), /테스트/);
const before = Number(await pv.textContent('#pageCount')) || 0;
const samples = await pv.evaluate(() => import('./samples/samples.js').then((m) => m.SAMPLES.length, () => 0));

// 가져오기 → 묶음 첫 쪽으로 감
await pv.setInputFiles('#packFile', packFile);
await pv.click('#btnImportPack');
await pv.waitForFunction(() => /2쪽을 가져왔어요/.test(document.querySelector('#packMsg')?.textContent || ''));
await pv.waitForFunction((n) => document.querySelector('#curr_page').value === String(n), samples + 1);
assert.equal(Number(await pv.textContent('#pageCount')), samples + 2);
assert.equal(await pv.inputValue('#page_num'), '10');
assert.match(await pv.textContent('#preview'), /첫 줄 <꺾쇠>[\s\S]*둘째 줄/, 'OCR이 편집기에 들어감');
assert.match(await pv.textContent('.makeInfor h2'), /책 하나/);
assert.match(await pv.textContent('#pageLabel'), /가짜 묶음: 1쪽/);
console.log('✓ 테스트 묶음 가져오기: 쪽 이미지·OCR·쪽 번호·책 정보');

// 다음 쪽은 다른 책 정보
// 목록의 둘째 쪽 링크로 이동 (다음 버튼은 저장하고 넘어감)
await pv.click('#customList li:last-child a');
await pv.waitForFunction((n) => document.querySelector('#curr_page').value === String(n), samples + 2);
assert.match(await pv.textContent('.makeInfor'), /책 둘[\s\S]*지은이 둘[\s\S]*출판사 둘/);
console.log('✓ 쪽마다 책 정보');

// 같은 묶음을 다시 가져오면 늘지 않고 바뀜
await pv.setInputFiles('#packFile', packFile);
await pv.click('#btnImportPack');
await pv.waitForFunction((n) => document.querySelector('#curr_page').value === String(n) && /가져왔어요/.test(document.querySelector('#packMsg').textContent), samples + 1);
assert.equal(Number(await pv.textContent('#pageCount')), samples + 2);
console.log('✓ 같은 묶음 다시 가져오면 바꿔 넣음');

// 잘못된 파일
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, '{"hello":1}');
await pv.setInputFiles('#packFile', bad);
await pv.click('#btnImportPack');
await pv.waitForFunction(() => /테스트 묶음 파일이 아니에요/.test(document.querySelector('#packMsg').textContent));
console.log('✓ 묶음 파일이 아니면 안내');
void before;
await app.close();
console.log('모두 통과');

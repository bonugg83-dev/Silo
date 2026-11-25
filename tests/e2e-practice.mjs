// 연습 페이지 흐름 테스트: 확장 안의 연습 편집 화면 + 가짜 Claude 응답. 사이트로는 아무 요청도 가지 않아야 한다.
// 실행: node tests/e2e-practice.mjs  (예시 쪽 이미지가 extension/practice/samples에 있어야 함)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(here, '../extension');
if (!fs.existsSync(path.join(extPath, 'practice/samples/samples.js'))) { console.log('예시 쪽이 없어 건너뜀'); process.exit(0); }

const siteRequests = [];
const apiCalls = [];
let tocCalls = 0;
const context = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/claude-0/e2ep-'), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
await context.route(/mypickebook\.org/, (route) => { siteRequests.push(route.request().url()); return route.abort(); });
let lastPage = 0;
await context.route('https://api.anthropic.com/**', async (route) => {
  const body = JSON.parse(route.request().postData());
  const reply = (obj) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 3000, output_tokens: 800 } }) });
  if (/차례\(목차\) 페이지 이미지/.test(body.system[0].text)) {
    tocCalls++;
    return reply({ toc: '@@[06. 대지와 민중을 사랑한 국민시인 휘트먼 140\n@@[07. 미국적 기독교 신앙의 구현자 호손 154', notes: '' });
  }
  const t = body.messages[0].content.at(-1).text;
  if (/2차 검수/.test(t)) { apiCalls.push({ page: lastPage, verify: true }); return reply({ fixes: [], flags: [] }); }
  const page = Number(t.match(/작업 쪽: (\d+)/)[1]);
  lastPage = page;
  apiCalls.push({ page, text: t });
  if (page === 2) {
    const w = Number(t.match(/가로 (\d+)px/)[1]);
    const h = Number(t.match(/세로 (\d+)px/)[1]);
    return reply({ text: '[그림] 〈미국의 진보(American Progress)〉\n@@i\n‘명백한 운명(Manifest Destiny)’을 상징하는 그림으로\n[그림 끝]\n후 팽배해진 물질주의 풍조를 비판하며', page_number: '', page_kind: 'body',
      is_blank_page: false, has_poem_or_quote: false, visuals: [{ kind: '그림', title: '〈미국의 진보(American Progress)〉', box: { x: Math.round(w * 0.05), y: Math.round(h * 0.03), width: Math.round(w * 0.8), height: Math.round(h * 0.55) } }], flags: [], notes: '' });
  }
  return reply({ text: `연습 ${page}쪽 본문`, page_number: '151', page_kind: 'body', is_blank_page: false, has_poem_or_quote: true, visuals: [], flags: [], notes: '' });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const errors = [];
const panel = await context.newPage();
panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
panel.on('dialog', (d) => d.accept());
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.fill('#newKeyName', '연습 키');
await panel.fill('#newKeyValue', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.click('#btnAddKey');
await panel.click('.tab[data-tab="advanced"]');
await panel.fill('#paceMinSec', '1');
await panel.fill('#paceMaxSec', '2');
await panel.click('#btnSaveAdvanced');

// 연습 페이지 열기 (설정 탭 버튼)
await panel.click('.tab[data-tab="settings"]');
const [practice] = await Promise.all([context.waitForEvent('page'), panel.click('#btnPractice2')]);
practice.on('pageerror', (e) => errors.push('practice: ' + e.message));
await practice.waitForLoadState();
await practice.waitForFunction(() => document.querySelector('#book_img').complete && document.querySelector('#book_img').naturalWidth > 0);
assert.equal(await practice.textContent('#pageCount'), '5');
await panel.click('.tab[data-tab="work"]');
await panel.waitForFunction(() => document.querySelector('#pageStatus').textContent.includes('작업 쪽 1'), null, { timeout: 20000 });

// 1쪽 교정 → 실제 OCR이 전달되고, 연습 목차 이미지도 읽힘
await panel.click('#btnAnalyze');
await panel.waitForSelector('#result:not(.hidden)', { timeout: 30000 });
assert.match(apiCalls[0].text, /남풍의 밤이 여- 큰 별/);
assert.equal(tocCalls, 1);
assert.equal(await panel.inputValue('#pageNum'), '151');
await panel.click('#btnApplySave');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
assert.match(await practice.textContent('#preview'), /연습 1쪽 본문/);

// 자동 모드: 1쪽 → 2쪽(그림)에서 멈춤, 쪽 번호는 152로 추정
await panel.click('#btnAuto');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('멈췄어요') || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: 60000 });
console.log('자동 모드:', await panel.textContent('#progress'), await panel.textContent('#error'));
assert.match(await panel.textContent('#progress'), /2쪽에서 멈췄어요/);
assert.equal(await panel.inputValue('#pageNum'), '152');
assert.ok(await panel.isVisible('#visualsBox'));
console.log('그림 크기:', await panel.textContent('#visuals .meta .row:nth-child(3) span'));
await panel.click('#btnApplySave');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
const pv = practice.url().includes('book_page=2') ? practice : context.pages().find((p) => p.url().includes('practice.html'));
assert.equal(await pv.locator('#preview figure img').count(), 1, '그림이 편집기에 들어감');
assert.match(await pv.locator('#preview figure img').getAttribute('src'), /^data:image\/png/);
const saved = await panel.evaluate(() => chrome.storage.local.get('practice:saved'));
assert.match(saved['practice:saved']['2'].content, /<figure class="image">/);

// 내 원본 넣기 → 6번째 쪽으로 붙음
await pv.setInputFiles('#customFile', path.join(here, 'fixtures/page.jpg'));
await pv.fill('#customPageNum', '77');
await pv.fill('#customOcr', '내 OCR <글자>');
await pv.click('#btnAddCustom');
await pv.waitForFunction(() => document.querySelector('#pageCount').textContent === '6');
await pv.click('#customList a');
await pv.waitForFunction(() => document.querySelector('#curr_page').value === '6');
assert.equal(await pv.inputValue('#page_num'), '77');
assert.equal(await pv.textContent('#preview'), '내 OCR <글자>');

if (process.env.SHOT) { await pv.setViewportSize({ width: 1400, height: 1000 }); await pv.screenshot({ path: process.env.SHOT }); }
assert.deepEqual(siteRequests, [], '사이트로는 아무 요청도 없음');
assert.deepEqual(errors, []);
console.log(`통과: API 호출 ${apiCalls.length + tocCalls}회, 사이트 요청 0회`);
await context.close();

// 확장 프로그램 전체 흐름 테스트: 모의 편집 화면 + 가짜 Claude 응답.
// 실행: node tests/e2e.mjs  (Playwright와 Chromium 필요)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(here, '../extension');
const mockHtml = fs.readFileSync(path.join(here, 'fixtures/mock_make_book.html'), 'utf8');
const pageImg = fs.readFileSync(path.join(here, 'fixtures/page.jpg'));

const OCR151 = '오라 벌거벗은 가슴의 밤이여— 오라 매력과 자양의 밤이여!/남풍의 밤이 여- 큰 별<br>\n52<br>\n—이영걸 옮김,『19세기 美詩」, 탐구당, 1990； 윤명옥 옮김';

function resultFor(page, call) {
  if (page === 151) {
    return {
      // 일부러 규칙 위반을 섞어 규칙 검사기가 고치는지 본다
      text: '오라 벌거벗은 가슴의 밤이여— 오라 "매력"과 자양의 밤이여!\n52\n―이영걸 옮김,『19세기 美詩』, 탐구당, 1990; 윤명옥 옮김\n\n<자원봉사론> 이야기 A & B',
      page_number: '151', is_blank_page: false, has_poem_or_quote: true,
      flags: call === 1 ? [{ kind: 'heading', message: '1차 확인 항목', needs_review: false }] : [],
      notes: `${call}차 작성`,
    };
  }
  if (page === 153) {
    return { text: '[그림]\n@@i\n설명\n[그림 끝]', page_number: '153', is_blank_page: false, has_poem_or_quote: false,
      flags: [{ kind: 'visual', message: '그림 삽입 필요', needs_review: true }], notes: '' };
  }
  return { text: `@@{${page}쪽 제목\n본문 ${page}`, page_number: String(page), is_blank_page: false, has_poem_or_quote: false, flags: [], notes: '' };
}

const apiCalls = [];
const saves = [];
const userDataDir = fs.mkdtempSync('/tmp/claude-0/e2e-');
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

await context.route('https://www.mypickebook.org/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/making/make_book.html') {
    const page = Number(url.searchParams.get('book_page') || 151);
    const ocr = page === 151 ? OCR151 : `${page}쪽 OCR 본문`;
    const html = mockHtml.replaceAll('__PAGE__', String(page)).replace('__OCR__', ocr.replace(/</g, '&lt;'));
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  }
  if (url.pathname === '/making/file.php') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: pageImg });
  if (url.pathname === '/module/book/table_of_content.php') {
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><ul><li>06. 대지와 민중을 사랑한 국민시인 휘트먼 140</li></ul></body></html>' });
  }
  if (url.pathname === '/making/make_save_proc.php') {
    saves.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":200}' });
  }
  return route.fulfill({ status: 404, body: '' });
});

await context.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const body = JSON.parse(req.postData());
  const headers = req.headers();
  const userText = body.messages[0].content[1].text;
  const page = Number((userText.match(/작업 쪽: (\d+)/) || [])[1]);
  const call = /draft_text/.test(userText) ? 2 : 1;
  apiCalls.push({ page, call, body, headers }); if (process.env.DEBUG) console.log(userText.slice(0, 1500));
  const result = resultFor(page, call);
  await route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }], usage: { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 5000 } }),
  });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const editor = await context.newPage();
const errors = [];
editor.on('pageerror', (e) => errors.push('editor: ' + e.message));
await editor.goto('https://www.mypickebook.org/making/make_book.html?idx=23584');

const panel = await context.newPage();
panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
panel.on('console', (m) => { if (m.type() === 'error') errors.push('panel console: ' + m.text()); });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

// 1. 키 저장 / 마스킹 / 로그아웃
await panel.fill('#apiKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.click('#btnSaveKey');
assert.equal(await panel.textContent('#keyMasked'), 'sk-ant-…1234');
await panel.click('#btnLogout');
assert.ok(await panel.isVisible('#apiKey'));
await panel.click('.tab[data-tab="work"]');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#error:not(.hidden)');
assert.match(await panel.textContent('#error'), /API 키/);
await panel.click('.tab[data-tab="settings"]');
await panel.fill('#apiKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.press('#apiKey', 'Enter');
await panel.click('.tab[data-tab="work"]');

// 2. 151쪽 교정
await panel.click('#btnAnalyze');
await panel.waitForSelector('#result:not(.hidden)', { timeout: 20000 });
const out = await panel.inputValue('#output');
console.log('--- 151쪽 결과 ---\n' + out);
assert.equal(apiCalls.length, 2, '1차 작성 + 2차 검증');
const c1 = apiCalls[0];
assert.equal(c1.body.model, 'claude-opus-5-5');
assert.equal(c1.body.output_config.effort, 'high');
assert.equal(c1.body.output_config.format.type, 'json_schema');
assert.equal(c1.body.fallbacks, 'default');
assert.equal(c1.headers['anthropic-dangerous-direct-browser-access'], 'true');
assert.equal(c1.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
assert.equal(c1.body.messages[0].content[0].type, 'image');
assert.match(c1.body.messages[0].content[1].text, /미주는 '주석'으로/); // 제작 Tip
assert.match(c1.body.messages[0].content[1].text, /휘트먼 140/); // 목차
assert.match(c1.body.messages[0].content[1].text, /남풍의 밤이 여- 큰 별/); // OCR 텍스트
assert.match(apiCalls[1].body.messages[0].content[1].text, /ocr_vs_draft_differences/);
assert.ok(out.includes('밤이여―오라 “매력”과'), '줄표/따옴표 교정');
assert.ok(out.includes('옮김, 『19세기'), '겹낫표 앞 띄우기');
assert.ok(out.includes('〈자원봉사론〉'), '산괄호');
assert.ok(!/[<>]/.test(out));
assert.equal(await panel.inputValue('#pageNum'), '151');
const flagsText = await panel.textContent('#flags');
assert.ok(flagsText.includes('1차 확인 항목'), '1차 확인 항목 유지');

// 3. 넣고 임시저장
await panel.click('#btnApplySave');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
const s1 = saves.at(-1);
assert.equal(s1.gubun, 'temp');
assert.equal(s1.page_num, '151');
assert.ok(s1.content.includes('밤이여―오라<br>') === false && s1.content.includes('<br>\n52<br>'), '줄마다 <br>');
assert.ok(s1.content.includes('A &amp; B'));
console.log('--- 저장된 편집기 데이터 ---\n' + s1.content);

// 4. 넣고 저장 후 다음 쪽 → 152쪽
await panel.click('#btnApplyNext');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('다음 쪽으로 넘어갔어요'), null, { timeout: 30000 });
assert.equal(saves.at(-1).gubun, 'next');
assert.match(editor.url(), /book_page=152/);

// 5. 자동 모드: 152 저장 → 153에서 그림 때문에 멈춤
await panel.click('#btnAuto');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('멈췄어요'), null, { timeout: 60000 });
console.log('자동 모드:', await panel.textContent('#progress'));
assert.match(editor.url(), /book_page=153/);
assert.ok(saves.some((s) => s.page === 152 && s.gubun === 'next' && s.content.includes('@@{152쪽 제목')));
assert.ok(!saves.some((s) => s.page === 153), '153쪽은 저장하지 않음');
// 152쪽 작성 때 151쪽 끝부분과 지금까지의 제목이 전달됐는지
const call152 = apiCalls.find((c) => c.page === 152 && c.call === 1);
assert.match(call152.body.messages[0].content[1].text, /previous_page_ending/);
const call153 = apiCalls.find((c) => c.page === 153 && c.call === 1);
assert.match(call153.body.messages[0].content[1].text, /152쪽: @@\{152쪽 제목/);

if (process.env.SHOT) { await panel.setViewportSize({ width: 420, height: 1300 }); await panel.screenshot({ path: process.env.SHOT, fullPage: true }); }
assert.deepEqual(errors, []);
console.log(`\n통과: API 호출 ${apiCalls.length}회, 저장 ${saves.length}회`);
await context.close();

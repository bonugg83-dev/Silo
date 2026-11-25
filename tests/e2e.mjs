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
const originalImg = fs.readFileSync(path.join(here, 'fixtures/original.png'));

const OCR151 = '오라 벌거벗은 가슴의 밤이여— 오라 매력과 자양의 밤이여!/남풍의 밤이 여- 큰 별<br>\n52<br>\n—이영걸 옮김,『19세기 美詩」, 탐구당, 1990； 윤명옥 옮김';

function resultFor(page) {
  if (page === 151) {
    return {
      // 일부러 규칙 위반을 섞어 규칙 검사기가 고치는지 본다
      text: '오라 벌거벗은 가슴의 밤이여— 오라 "매력"과 자양의 밤이여!\n남풍의 밤이여― 큰 별\n52\n―이영걸 옮김,『19세기 美詩』, 탐구당, 1990; 윤명옥 옮김\n\n<자원봉사론> 이야기 A & B',
      page_number: '151', page_kind: 'body', is_blank_page: false, has_poem_or_quote: true, visuals: [],
      flags: [{ kind: 'uncertain_text', message: '매력 글자가 흐려요', quote: '매력', needs_review: false }],
      notes: '1차 작성',
    };
  }
  if (page === 153) {
    return { text: '@@{153쪽 제목\n[그림] 꽃 그림(Flower)\n@@i\n설명 첫 줄\n설명 둘째 줄\n[그림 끝]\n본문 153', page_number: '153', page_kind: 'body',
      is_blank_page: false, has_poem_or_quote: false,
      visuals: [{ kind: '그림', title: '꽃 그림(Flower)', box: { x: 90, y: 140, width: 420, height: 320 } }],
      flags: [], notes: '' };
  }
  return { text: `@@{${page}쪽 제목\n본문 ${page}`, page_number: String(page), page_kind: 'body', is_blank_page: false, has_poem_or_quote: false, visuals: [], flags: [], notes: '' };
}
function verifyFor(page) {
  if (page === 151) {
    return { fixes: [
      { find: '큰 별', replace: '큰 별이여', reason: '원본에 “이여”가 있음' },
      { find: '없는 구절', replace: 'x', reason: '테스트' },
    ], flags: [] };
  }
  return { fixes: [], flags: [] };
}

const apiCalls = [];
const tocPagesFetched = [];
let tocCalls = 0;
let tocFail = true; // 처음에는 목차 팝업이 실패
const saves = [];
const uploads = [];
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
  if (url.pathname === '/upload/book/file.php') {
    assert.equal(url.searchParams.get('type'), 'u');
    return route.fulfill({ status: 200, contentType: 'image/png', body: originalImg });
  }
  if (url.pathname === '/module/book/cropbox_upload_proc.php') {
    const body = route.request().postData() || '';
    uploads.push(body);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 200, img_path: `/upload/crop/${uploads.length}.png` }) });
  }
  if (url.pathname === '/upload/crop/1.png') return route.fulfill({ status: 200, contentType: 'image/png', body: originalImg });
  if (url.pathname === '/module/book/table_of_content.php') {
    if (tocFail) return route.fulfill({ status: 500, body: '' });
    // 실제 목차 팝업처럼: 쪽 이동 링크 + 목차 이미지 한 장
    const p = Number(url.searchParams.get('page') || 1);
    tocPagesFetched.push(p);
    const body = `<html><body><div class="feed_wrap"><h1 class="title2">목차</h1><div class="page"><div class="num">
      <a href="javascript:;"><img src="/img/ic_page_before.png" alt="이전"></a><a class="on">1</a>
      <a href="/module/book/table_of_content.php?page=2&amp;book_idx=23584">2</a>
      <a href="javascript:;"><img src="/img/ic_page_next.png" alt="다음"></a></div></div>
      <div><img src="/common/file.php?toc=${p}" style="max-width:100%;"></div></div></body></html>`;
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  }
  if (url.pathname === '/common/file.php') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: pageImg });
  if (url.pathname === '/making/make_save_proc.php') {
    saves.push({ ...JSON.parse(route.request().postData()), at: Date.now() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":200}' });
  }
  return route.fulfill({ status: 404, body: '' });
});

let lastPage = NaN;
await context.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const body = JSON.parse(req.postData());
  const headers = req.headers();
  const reply = (obj, usage = { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 5000 }) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage }),
  });
  if (/차례\(목차\) 페이지 이미지/.test(body.system[0].text)) {
    tocCalls++;
    assert.equal(body.messages[0].content.filter((c) => c.type === 'image').length, 2, '목차 이미지 2장');
    return reply({ toc: '@@[06. 대지와 민중을 사랑한 국민시인 휘트먼 140\n@@{1. 풀잎 145', notes: '' }, { input_tokens: 4000, output_tokens: 500 });
  }
  const userText = body.messages[0].content.at(-1).text;
  const isVerify = /2차 검수/.test(userText);
  const page = isVerify ? lastPage : Number((userText.match(/작업 쪽: (\d+)/) || [])[1]);
  lastPage = page;
  apiCalls.push({ page, call: isVerify ? 2 : 1, body, headers }); if (process.env.DEBUG) console.log(userText.slice(0, 1500));
  if (isVerify) {
    assert.ok(body.output_config.format.schema.properties.fixes, '2차 검증은 고칠 곳만 받는 형식');
    return reply(verifyFor(page), { input_tokens: 3000, output_tokens: 200 });
  }
  return reply(resultFor(page));
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

panel.on('dialog', (d) => d.accept());

// 1. 키가 없으면 교정하지 않음
await panel.click('.tab[data-tab="work"]');
await panel.click('#btnAnalyze');
await panel.waitForSelector('#error:not(.hidden)');
assert.match(await panel.textContent('#error'), /API 키/);

// 2. 키 여러 개: 이름 붙이기, 고르기, 이름 바꾸기, 삭제
await panel.click('.tab[data-tab="settings"]');
await panel.fill('#newKeyName', 'A사용자 키');
await panel.fill('#newKeyValue', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.click('#btnAddKey');
await panel.fill('#newKeyName', 'B사용자 키');
await panel.fill('#newKeyValue', 'sk-ant-api03-OTHERKEY_abcdefghijklmnopqrstuvwxyz9999');
await panel.press('#newKeyValue', 'Enter');
let rows = panel.locator('#keyList .key-row');
assert.equal(await rows.count(), 2);
assert.equal(await rows.nth(0).locator('input[type=text]').inputValue(), 'A사용자 키');
assert.match(await rows.nth(1).locator('code').textContent(), /…9999$/);
assert.ok(await rows.nth(1).locator('input[type=radio]').isChecked(), '새로 추가한 키를 사용');
await rows.nth(0).locator('input[type=radio]').check();
await rows.nth(0).locator('input[type=text]').fill('A 선생님 키');
await rows.nth(0).locator('input[type=text]').press('Tab');
await rows.nth(1).locator('button').click(); // B 삭제
await panel.waitForFunction(() => document.querySelectorAll('#keyList .key-row').length === 1);
assert.equal(await rows.nth(0).locator('input[type=text]').inputValue(), 'A 선생님 키');
const stored = await panel.evaluate(() => chrome.storage.local.get('settings'));
assert.equal(stored.settings.keys.length, 1);
assert.equal(stored.settings.keys[0].name, 'A 선생님 키');
assert.equal(stored.settings.activeKeyId, stored.settings.keys[0].id);
assert.ok(!('apiKey' in stored.settings));
await panel.click('.tab[data-tab="work"]');

// 3. 151쪽 교정 (목차 팝업 실패 → 알림, 교정은 계속)
await panel.click('#btnAnalyze');
await panel.waitForSelector('#result:not(.hidden)', { timeout: 20000 });
assert.ok(await panel.isVisible('#tocAlert'), '목차 실패 알림');
assert.equal(tocCalls, 0);
const out = await panel.inputValue('#output');
console.log('--- 151쪽 결과 ---\n' + out);
assert.equal(apiCalls.length, 2, '1차 작성 + 2차 검증(고칠 곳만)');
const c1 = apiCalls[0];
assert.equal(c1.headers['x-api-key'], 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234', '고른 키 사용');
assert.equal(c1.body.model, 'claude-opus-5-5');
assert.equal(c1.body.output_config.effort, 'high');
assert.equal(c1.body.output_config.format.type, 'json_schema');
assert.equal(c1.body.fallbacks, 'default');
assert.equal(c1.headers['anthropic-dangerous-direct-browser-access'], 'true');
assert.equal(c1.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
assert.equal(c1.body.messages[0].content[0].type, 'image');
assert.match(c1.body.messages[0].content[1].text, /미주는 '주석'으로/); // 제작 Tip
assert.match(c1.body.messages[0].content[1].text, /남풍의 밤이 여- 큰 별/); // OCR 텍스트
assert.match(c1.body.messages[0].content[1].text, /가로 800px, 세로 1200px/);
assert.match(apiCalls[1].body.messages[0].content[1].text, /ocr_vs_draft_differences/);
assert.ok(!/<draft_text>[\s\S]*<draft_text>/.test(apiCalls[1].body.messages[0].content[1].text));
assert.ok(out.includes('큰 별이여'), '2차 검증 수정 적용');
assert.ok(out.includes('밤이여―오라 “매력”과'), '줄표/따옴표 교정');
assert.ok(out.includes('옮김, 『19세기'), '겹낫표 앞 띄우기');
assert.ok(out.includes('〈자원봉사론〉'), '산괄호');
assert.ok(!/[<>]/.test(out));
assert.equal(await panel.inputValue('#pageNum'), '151');
const flagsText = await panel.textContent('#flags');
assert.ok(flagsText.includes('매력 글자가 흐려요'));
assert.ok(flagsText.includes('적용하지 못했어요'), '적용 못 한 수정은 확인할 것으로');
assert.equal(await panel.textContent('#outputView mark'), '매력', '확인할 곳을 결과 글에 표시');
assert.match(await panel.getAttribute('#outputView mark', 'title'), /매력 글자가 흐려요/);
assert.match(await panel.textContent('#notes'), /2차 검증에서 1곳 고침/);

// 4. 목차 다시 읽기 → 성공, 다시 교정하면 목차가 전달됨
tocFail = false;
await panel.click('#btnTocRetry');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('목차를 다시 읽었어요'), null, { timeout: 20000 });
assert.ok(!(await panel.isVisible('#tocAlert')));
assert.equal(tocCalls, 1);
assert.deepEqual(tocPagesFetched, [1, 2]);
assert.match(await panel.inputValue('#tocText'), /@@\[06\./);
await panel.click('#btnAnalyze');
await panel.waitForFunction((n) => document.querySelector('#notes').textContent.includes('2차 검증') && !document.querySelector('#btnAnalyze').disabled, apiCalls.length, { timeout: 20000 });
assert.match(apiCalls.at(-2).body.messages[0].content[1].text, /@@\{1\. 풀잎 145/);

// 5. 넣고 임시저장
await panel.click('#btnApplySave');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
const s1 = saves.at(-1);
assert.equal(s1.gubun, 'temp');
assert.equal(s1.page_num, '151');
assert.ok(s1.content.includes('<br>\n52<br>'), '줄마다 <br>');
assert.ok(s1.content.includes('A &amp; B'));
console.log('--- 저장된 편집기 데이터 ---\n' + s1.content);

// 6. 넣고 저장 후 다음 쪽 → 152쪽
await panel.click('#btnApplyNext');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('다음 쪽으로 넘어갔어요'), null, { timeout: 30000 });
assert.equal(saves.at(-1).gubun, 'next');
assert.match(editor.url(), /book_page=152/);

// 7. 자동 모드: 152 저장 → 153에서 시각자료 때문에 멈춤
// 쪽 넘김 간격: 테스트에서는 2~3초로 줄여서 확인
await panel.click('.tab[data-tab="advanced"]');
assert.ok(await panel.isChecked('#pacing'), '기본으로 켜짐');
assert.equal(await panel.inputValue('#paceMinSec'), '60');
assert.equal(await panel.inputValue('#paceMaxSec'), '90');
await panel.uncheck('#runThrough'); // 이 테스트는 쪽마다 멈추는 방식
await panel.fill('#paceMinSec', '2');
await panel.fill('#paceMaxSec', '3');
await panel.click('#btnSaveAdvanced');
await panel.click('.tab[data-tab="work"]');
const autoStart = Date.now();
await panel.click('#btnAuto');
await panel.waitForFunction(() => /다음 쪽까지 \d+초 기다리는 중/.test(document.querySelector('#progress').textContent), null, { timeout: 30000 });
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('멈췄어요') || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: 60000 });
console.log('error:', await panel.textContent('#error'));
console.log('자동 모드:', await panel.textContent('#progress'));
assert.match(await panel.textContent('#progress'), /시각자료/);
assert.match(editor.url(), /book_page=153/);
assert.ok(saves.some((s) => s.page === 152 && s.gubun === 'next' && s.content.includes('@@{152쪽 제목')));
assert.ok(!saves.some((s) => s.page === 153), '153쪽은 저장하지 않음');
const save152 = saves.find((s) => s.page === 152 && s.gubun === 'next');
assert.ok(save152.at - autoStart >= 2000, `쪽당 최소 2초 대기 (${save152.at - autoStart}ms)`);
const call152 = apiCalls.find((c) => c.page === 152 && c.call === 1);
assert.match(call152.body.messages[0].content[1].text, /previous_page_ending/);
const call153 = apiCalls.find((c) => c.page === 153 && c.call === 1);
assert.match(call153.body.messages[0].content[1].text, /152쪽: @@\{152쪽 제목/);
assert.equal(tocCalls, 1, '목차는 책마다 한 번만');

// 8. 시각자료: 원본에서 잘라 미리보기 → 넣을 때만 올리고 <figure>로 넣음
assert.ok(await panel.isVisible('#visualsBox'));
assert.equal(uploads.length, 0, '넣기 전에는 올리지 않음');
const dim = await panel.textContent('#visuals .meta .row:nth-child(3) span');
console.log('잘린 그림 크기:', dim);
const [cw, ch] = dim.match(/(\d+)×(\d+)/).slice(1).map(Number);
assert.ok(Math.abs(cw - 808) <= 4 && Math.abs(ch - 608) <= 4, '원본 해상도에서 자르고 흰 여백을 다듬음');
await panel.click('#btnApplySave');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
assert.equal(uploads.length, 1);
assert.match(uploads[0], /name="crop_file"\r\n\r\ndata:image\/png;base64,/);
assert.match(uploads[0], /name="fnum"\r\n\r\n153/);
const s3 = saves.at(-1);
console.log('--- 153쪽 저장 데이터 ---\n' + s3.content);
assert.equal(s3.page, 153);
assert.ok(s3.content.includes('<p>[그림] 꽃 그림(Flower)</p><p>@@i</p><figure class="image"><img src="/upload/crop/1.png" style="max-width:500px;"><figcaption>설명 첫 줄<br>설명 둘째 줄</figcaption></figure><p>[그림 끝]</p>'));
assert.ok(s3.content.startsWith('@@{153쪽 제목\n') || s3.content.startsWith('@@{153쪽 제목<br>'), s3.content);
assert.ok(s3.content.endsWith('본문 153'));
// 한 번 더 저장해도 다시 올리지 않음
await panel.click('#btnApplySave');
await panel.waitForFunction((n) => !document.querySelector('#btnApplySave').disabled, null, { timeout: 20000 });
await panel.waitForTimeout(300);
assert.equal(uploads.length, 1, '같은 그림은 한 번만 올림');

// 9. 영역 고치기: 상자를 끌어 줄이면 다시 자르고, 다음 넣기 때 새로 올림
await panel.setViewportSize({ width: 420, height: 900 });
await panel.click('#visuals button:has-text("영역 고치기")');
await panel.waitForSelector('#cropModal:not(.hidden)');
await panel.waitForFunction(() => document.querySelector('#cropBox').getBoundingClientRect().width > 50);
await panel.locator('#cropBox .se').scrollIntoViewIfNeeded();
const hb = await panel.locator('#cropBox .se').boundingBox();
await panel.mouse.move(hb.x + 7, hb.y + 7);
await panel.mouse.down();
await panel.mouse.move(hb.x - 60, hb.y - 40, { steps: 5 });
await panel.mouse.up();
await panel.click('#btnCropApply');
await panel.waitForSelector('#cropModal.hidden', { state: 'attached' });
const dim2 = await panel.textContent('#visuals .meta .row:nth-child(3) span');
console.log('고친 뒤 크기:', dim2);
assert.notEqual(dim2, dim);
await panel.click('#btnApply');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('편집기에 넣었어요'), null, { timeout: 20000 });
assert.equal(uploads.length, 2, '영역을 고친 그림은 새로 올림');

if (process.env.SHOT) { await panel.setViewportSize({ width: 420, height: 1300 }); await panel.screenshot({ path: process.env.SHOT, fullPage: true }); }
assert.deepEqual(errors, []);
console.log(`\n통과: API 호출 ${apiCalls.length}회, 저장 ${saves.length}회, 그림 올리기 ${uploads.length}회`);
await context.close();

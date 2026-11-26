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
  const t = body.messages.at(-1).content.at(-1).text;
  if (/2차 검수/.test(t)) { apiCalls.push({ page: lastPage, verify: true }); return reply({ fixes: [], flags: [] }); }
  const page = Number(t.match(/작업 쪽: (\d+)/)[1]);
  lastPage = page;
  apiCalls.push({ page, text: t });
  if (page === 1) {
    return reply({ text: '연습 1쪽 본문에 각주가 있다[각주3].', page_number: '151', page_kind: 'body', is_blank_page: false, has_poem_or_quote: false,
      visuals: [], footnotes_without_note: [{ label: '각주3' }], notes_without_marker: [], flags: [], notes: '' });
  }
  if (page === 2) {
    assert.match(t, /pending_footnotes>\n앞쪽에 번호만 있고 설명이 없는 각주: 1쪽 \[각주3\]/);
    const w = Number(t.match(/가로 (\d+)px/)[1]);
    const h = Number(t.match(/세로 (\d+)px/)[1]);
    return reply({ footnotes_without_note: [], notes_without_marker: [{ label: '각주3', note: '각주 설명 내용' }], text: '[각주3: 각주 설명 내용]\n[그림] 〈미국의 진보(American Progress)〉\n@@i\n‘명백한 운명(Manifest Destiny)’을 상징하는 그림으로\n[그림 끝]\n후 팽배해진 물질주의 풍조를 비판하며', page_number: '', page_kind: 'body',
      is_blank_page: false, has_poem_or_quote: false, visuals: [{ kind: '그림', title: '〈미국의 진보(American Progress)〉', box: { x: Math.round(w * 0.05), y: Math.round(h * 0.03), width: Math.round(w * 0.8), height: Math.round(h * 0.55) } }], flags: [], notes: '' });
  }
  return reply({ text: `연습 ${page}쪽 본문`, page_number: String(150 + page), page_kind: 'body', is_blank_page: false, has_poem_or_quote: false, visuals: [], footnotes_without_note: [], notes_without_marker: [], flags: [], notes: '' });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const errors = [];
const panel = await context.newPage();
panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
panel.on('dialog', (d) => d.accept());
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => document.querySelector('#addKeyBox').classList.contains('open'));
await panel.fill('#newKeyName', '연습 키');
await panel.fill('#newKeyValue', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
await panel.click('#btnSaveKey');
await panel.click('#btnAdvanced');
await panel.fill('#paceMinSec', '1');
await panel.fill('#paceMaxSec', '2');
await panel.click('#btnSaveAdvanced');

// 연습 페이지 열기 (설정 탭 버튼)
const [practice] = await Promise.all([context.waitForEvent('page'), panel.click('#btnPractice2')]);
practice.on('pageerror', (e) => errors.push('practice: ' + e.message));
await practice.waitForLoadState();
await practice.waitForFunction(() => document.querySelector('#book_img').complete && document.querySelector('#book_img').naturalWidth > 0);
assert.equal(await practice.textContent('#pageCount'), '5');
await panel.click('#btnCloseSettings');

// 자동모드(기본 켜짐)로 교정하기: 빨간 항목이 있어도 멈추지 않고 마지막 쪽까지 저장
await panel.click('#btnAnalyze');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('마지막 쪽') || !document.querySelector('#error').classList.contains('hidden'), null, { timeout: 90000 });
console.log('자동 모드:', await panel.textContent('#progress'), await panel.textContent('#error'));
assert.match(apiCalls[0].text, /남풍의 밤이 여- 큰 별/); // 실제 OCR 전달
assert.equal(tocCalls, 1);
let saved = (await panel.evaluate(() => chrome.storage.local.get('practice:saved')))['practice:saved'];
assert.deepEqual(Object.keys(saved).sort(), ['1', '2', '3', '4', '5']);
assert.equal(saved['2'].pageNum, '152', '쪽 번호 추정');
assert.ok(/<figure class="image"><img src="data:image\/png/.test(saved['2'].content), '그림 자동 넣기');
// 자동 모드 끝에 쪽을 넘는 각주를 이어 붙임: 1쪽 번호 자리에 설명, 2쪽 맨 위 설명 줄 삭제, 그림은 그대로
assert.match(await panel.textContent('#progress'), /각주 1개도 이었어요/);
assert.match(saved['1'].content, /\[각주3: 각주 설명 내용\]\.$/);
assert.ok(!saved['2'].content.includes('[각주3'), '2쪽 설명 줄 삭제');
assert.ok(/^<p>\[그림\] 〈미국의 진보\(American Progress\)〉<\/p><p>@@i<\/p><figure class="image"><img src="data:image\/png/.test(saved['2'].content), '그림 유지: ' + saved['2'].content.slice(0, 120));

// 검수 창: 긴 버튼 → 아래에서 올라옴, 각주 연결은 남아 있지 않음
await panel.click('#btnReview');
await panel.waitForFunction(() => document.body.classList.contains('review-open'));
assert.ok(await panel.evaluate(() => document.querySelector('#reviewLinksBox').classList.contains('hidden')));
if (process.env.SHOT2) { await panel.setViewportSize({ width: 420, height: 900 }); await panel.screenshot({ path: process.env.SHOT2, fullPage: true }); }

// 이 쪽 열기 → 패널에 결과, 넣고 임시저장 → 확인함
await panel.waitForFunction(() => document.querySelectorAll('#reviewPages .rv-row').length > 0);
const firstTitle = await panel.textContent('#reviewPages .rv-row:first-child .rv-title');
await panel.click('#reviewPages .rv-row:first-child .rv-main');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('열었어요'), null, { timeout: 30000 });
console.log('열기:', firstTitle, '→', await panel.inputValue('#output'));
// 고친 뒤 확인함 → 넣고 임시저장까지
await panel.click('#btnToggleEdit');
await panel.fill('#output', (await panel.inputValue('#output')) + '\n고친 줄');
await panel.click('#btnReviewed');
await panel.waitForFunction(() => document.querySelector('#progress').textContent.includes('임시저장했어요'), null, { timeout: 20000 });
await panel.waitForFunction(() => document.body.classList.contains('review-open'));
await panel.waitForFunction((t) => !Array.from(document.querySelectorAll('#reviewPages .rv-title')).some((h) => h.textContent === t), firstTitle);
const pv = context.pages().find((p) => p.url().includes('practice.html'));
saved = (await panel.evaluate(() => chrome.storage.local.get('practice:saved')))['practice:saved'];
assert.ok(/<figure class="image"><img src="data:image\/png/.test(saved['2'].content), '다시 저장해도 그림 유지');
assert.ok(saved['2'].content.endsWith('고친 줄'), '고친 내용 저장');

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

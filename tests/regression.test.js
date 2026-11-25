// 자주 나오는 오류 사례 회귀 테스트: 각주, 제목 단계, 시각자료, 특수 쪽, 누락.
// 실제 책에서 나온 모양을 흉내 낸 입력으로, 프로그램 검사(AI 호출 없음)가 예상대로 동작하는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLinks, putNoteAtMarker, removeNoteLine } from '../extension/lib/footnotes.js';
import { alignHeadings, parseToc, coreTitle } from '../extension/lib/headings.js';
import { findOmissions, tooShort, suspiciousSpecial, repeatsPrevEnd } from '../extension/lib/omission.js';
import { parseVisualBlocks, buildEditorData } from '../extension/lib/visuals.js';
import { applyRules } from '../extension/lib/rules.js';
import { tidyMessage, sortReview } from '../extension/lib/issues.js';

const rules = (t) => applyRules(t).text;

// ───────── 각주 ─────────

test('각주: 띄어 쓴 번호도 앞쪽 번호와 짝지음, 3쪽 전은 잇지 않음', () => {
  const book = { pages: { 8: { footMissing: ['각주5'] }, 10: { footMissing: ['각주 3'] }, 11: {} } };
  const made = findLinks(book, 11, [{ label: '각주3', note: '설명' }, { label: '각주5', note: '멀리' }]);
  assert.deepEqual(made.map((l) => [l.label, l.from]), [['각주3', 10]]);
});

test('각주: 2쪽 전(사이에 그림만 있는 쪽)도 잇는다', () => {
  const book = { pages: { 20: { footMissing: ['미주7'] }, 21: {}, 22: {} } };
  assert.deepEqual(findLinks(book, 22, [{ label: '미주7', note: 'x' }]).map((l) => l.from), [20]);
});

test('각주: 설명 줄 옮기기는 표시 하나, 줄 하나일 때만', () => {
  assert.deepEqual(putNoteAtMarker('말했다.[미주1] 그리고', '미주1', '출처'), { ok: true, text: '말했다.[미주1: 출처] 그리고' });
  assert.equal(putNoteAtMarker('[각주1][각주12]', '각주1', 'x').text, '[각주1: x][각주12]', '각주1이 각주12를 건드리지 않음');
  assert.deepEqual(removeNoteLine('  [각주3: 앞쪽에서 이어진 설명]\n둘째 줄', '각주3'), { ok: true, text: '둘째 줄' });
  assert.equal(removeNoteLine('[각주3: 끝나지 않은\n설명]', '각주3').ok, false, '두 줄에 걸친 설명은 지우지 않음');
});

test('각주 표시 모양 정리: 띄어쓰기·쌍점', () => {
  assert.equal(rules('문장.[각주 3]'), '문장.[각주3]');
  assert.equal(rules('문장.[ 미주 12 : 설명]'), '문장.[미주12: 설명]');
  assert.equal(rules('문장.[각주3:설명]'), '문장.[각주3: 설명]');
  assert.equal(rules('문장.[각주*]'), '문장.[각주*]');
});

test('누락: 쪽 아래 각주 설명을 번호 자리로 옮긴 것은 누락이 아님', () => {
  const ocr = '이 주장은 처음 제기된 것이 아니다.1 그는 같은 말을 되풀이했다.\n123\n1 김철수, 『한국 근대사 연구』, 서울대학교출판부, 2001, 45쪽.';
  const res = '이 주장은 처음 제기된 것이 아니다.[각주1: 김철수, 『한국 근대사 연구』, 서울대학교출판부, 2001, 45쪽.] 그는 같은 말을 되풀이했다.';
  assert.deepEqual(findOmissions(ocr, res), []);
});

// ───────── 제목 단계 ─────────

const TOC_NO_PART = '@@[제1장 바다로 가는 길 13\n@@{1. 첫 항해 15\n@@{2. 폭풍의 밤 28\n@@[제2장 돌아온 사람들 41\n@@{1. 항구에서 43';

test('제목: 부가 없는 책은 장이 1단계 (AI가 장을 2단계로 써도 목차대로)', () => {
  const r = alignHeadings('@@{제1장 바다로 가는 길\n본문 시작.\n@@(1. 첫 항해\n본문.', TOC_NO_PART);
  assert.equal(r.text, '@@[제1장 바다로 가는 길\n본문 시작.\n@@{1. 첫 항해\n본문.');
  assert.equal(r.changes.length, 2);
});

test('제목: 번호 표기가 달라도 같은 제목 (제 1 장 / 1장 / Ⅰ.)', () => {
  assert.equal(coreTitle('제 1 장 바다로 가는 길'), coreTitle('1장 바다로 가는 길'));
  assert.equal(coreTitle('Ⅲ. 연구 방법'), coreTitle('3. 연구 방법'));
  assert.equal(alignHeadings('@@(1장 바다로 가는 길', TOC_NO_PART).text, '@@[1장 바다로 가는 길');
});

test('제목: 본문 제목에 영문이 붙어도 목차 제목으로 맞춤', () => {
  assert.equal(alignHeadings('@@{제2장 돌아온 사람들 (The Returned)', TOC_NO_PART).text, '@@[제2장 돌아온 사람들 (The Returned)');
});

test('제목: 목차에 두 번 나오고 단계가 다르면 건드리지 않음', () => {
  const toc = '@@[들어가며 5\n@@{들어가며 120';
  assert.equal(alignHeadings('@@(들어가며', toc).text, '@@(들어가며');
});

test('제목: 목차에 없는 제목, 긴 본문 줄, 시각자료 제목은 그대로', () => {
  const text = '@@(작은 소제목\n2. 폭풍의 밤\n폭풍의 밤\n[그림] 2. 폭풍의 밤\n@@i\n[그림 끝]\n바다로 가는 길이라는 말은 그가 늘 하던 말이었고 우리는 그 말을 오래 기억했다.';
  const r = alignHeadings(text, TOC_NO_PART);
  // 표시 없는 줄은 목차와 번호까지 똑같을 때만 단계를 붙임 (번호 없는 "폭풍의 밤"은 본문일 수 있어 그대로)
  assert.equal(r.text, text.replace('\n2. 폭풍의 밤\n폭풍', '\n@@{2. 폭풍의 밤\n폭풍'));
  assert.equal(r.changes.length, 1);
});

test('제목: 목차 끝 쪽 번호와 점선을 떼고 읽음', () => {
  const e = parseToc('@@[머리말 ······ 7\n@@{1-2. 개념의 정리…… 112\n일반 줄');
  assert.deepEqual(e.map((x) => [x.marker, x.title]), [['@@[', '머리말'], ['@@{', '1-2. 개념의 정리']]);
});

test('제목: 목차가 없으면 아무것도 바꾸지 않음', () => {
  assert.deepEqual(alignHeadings('@@{제1장 바다', ''), { text: '@@{제1장 바다', changes: [] });
});

// ───────── 시각자료 ─────────

test('시각자료: 제목을 종류 옆에 둔 블록을 찾고, 캡션은 그대로', () => {
  const t = '앞 문단.\n[사진] <사진 1> 호손의 생가\n@@i\n매사추세츠주 세일럼에 있다.\n[사진 끝]\n뒷 문단.';
  const b = parseVisualBlocks(t);
  assert.equal(b.length, 1);
  assert.equal(b[0].headLine, '[사진] <사진 1> 호손의 생가');
  assert.deepEqual(b[0].captionLines, ['매사추세츠주 세일럼에 있다.']);
});

test('시각자료: 끝 표시가 없는 블록은 넣지 않고 글 그대로 둠', () => {
  const t = '[그림] 제목\n@@i\n설명';
  assert.deepEqual(parseVisualBlocks(t), []);
  assert.equal(buildEditorData(t, [{ src: '/a.png', width: 10 }]), '[그림] 제목<br>\n@@i<br>\n설명');
});

test('시각자료: 넓은 그림은 500px로 줄여 넣음', () => {
  const d = buildEditorData('[그래프] 인구\n@@i\n[그래프 끝]', [{ src: '/g.png', width: 900 }]);
  assert.match(d, /style="max-width:500px;"/);
  assert.doesNotMatch(d, /figcaption/, '캡션이 없으면 figcaption도 없음');
});

test('누락: 그림 안 글자와 캡션을 옮겨 적었으면 누락이 아님', () => {
  const ocr = '본문 첫 문장이 여기에 있다.\n그림 2-4 연도별 방문자 수\n2004 1,273\n2005 1,410\n출처: 통계청 2006년 보고서';
  const res = '본문 첫 문장이 여기에 있다.\n[그래프] 그림 2-4 연도별 방문자 수\n@@i\n2004: 1,273\n2005: 1,410\n(출처: 통계청 2006년 보고서)\n[그래프 끝]';
  assert.deepEqual(findOmissions(ocr, res), []);
});

// ───────── 특수 쪽 ─────────

const LONG = '그날 아침 우리는 일찍 일어나 항구로 걸어갔다. 바람은 차가웠고 하늘은 낮게 내려앉아 있었다. '.repeat(4);

test('특수 쪽: 빈 면·사진만 있는 쪽인데 글자가 많으면 의심', () => {
  assert.equal(suspiciousSpecial(LONG, 'blank'), true);
  assert.equal(suspiciousSpecial(LONG, 'visual_only'), true);
  assert.equal(suspiciousSpecial(LONG, 'body'), false, '본문 쪽은 검사 대상 아님');
});

test('특수 쪽: 장 표지의 짧은 글(장 번호·제목·인용구)은 정상', () => {
  assert.equal(suspiciousSpecial('제3장\n떠나는 사람들\n“바다는 기억한다.” — 옛 노래', 'chapter_cover'), false);
  assert.equal(suspiciousSpecial('', 'blank'), false);
});

// ───────── 누락 ─────────

test('누락: 문단 가운데 빠진 문장을 찾음', () => {
  const ocr = '첫째 문장은 그대로 옮겼다. 둘째 문장은 결과에서 빠져 버렸다고 가정한다. 셋째 문장도 그대로 옮겼다.';
  const res = '첫째 문장은 그대로 옮겼다. 셋째 문장도 그대로 옮겼다.';
  const o = findOmissions(ocr, res);
  assert.equal(o.length, 1);
  assert.match(o[0], /둘째 문장은/);
});

test('누락: 쪽 맨 아래 작은 글씨 줄을 통째로 빠뜨리면 찾음', () => {
  const ocr = `${LONG}\n※ 이 장의 일부는 2015년 학회 발표문을 고친 것이다.`;
  const o = findOmissions(ocr, LONG.trim());
  assert.equal(o.length, 1);
  assert.match(o[0], /학회 발표문/);
});

test('누락 아님: 머리말·쪽 번호를 지운 것, 줄바꿈·하이픈·부호만 다른 것, 오타를 고친 것', () => {
  const ocr = '제2장 돌아온 사람들\n그는 오랫동안 바다를 바라\n보았다. "언제 돌아오나" 하고\n중얼거렸다. 그 배는 끝내 돌\n아오지않았다.\n57';
  const res = '그는 오랫동안 바다를 바라보았다. “언제 돌아오나?” 하고 중얼거렸다. 그 배는 끝내 돌아오지 않았다.';
  assert.deepEqual(findOmissions(ocr, res), []);
});

test('누락: 결과가 OCR의 3/4보다 짧으면 경고, 머리말 정도 차이는 아님', () => {
  assert.equal(tooShort(LONG + LONG, LONG), true);
  assert.equal(tooShort(`머리말 줄\n${LONG}\n57`, LONG), false);
  assert.equal(tooShort('짧은 쪽', ''), false, '200자 미만 쪽은 비교하지 않음');
});

test('쪽 경계: 앞쪽 끝 문장을 이 쪽 처음에 또 쓰면 찾음, 우연히 짧게 겹치는 건 아님', () => {
  const prev = '바람이 불었다. 그는 문을 열고 밖으로 나가 오래도록 돌아오지 않았다.';
  assert.equal(repeatsPrevEnd(prev, '그는 문을 열고 밖으로 나가 오래도록 돌아오지 않았다. 다음 날 아침이 밝았다.'), true);
  assert.equal(repeatsPrevEnd(prev, '다음 날 아침이 밝았다. 그는 돌아오지 않았다.'), false);
  assert.equal(repeatsPrevEnd('짧다.', '짧다. 다음'), false);
});

// ───────── 검수 표시 ─────────

test('검수 문장: 흔한 군더더기 꼬리를 뗌', () => {
  for (const [a, b] of [
    ['각주 번호 3이 흐림. 확인이 필요합니다.', '각주 번호 3이 흐림'],
    ['낫표 종류 불분명, 원본에서 확인하세요', '낫표 종류 불분명'],
    ['확인 필요: 두 줄이 겹쳐 보임', '두 줄이 겹쳐 보임'],
    ['글자 번짐으로 판독 어려움', '글자 번짐으로 판독 어려움'],
  ]) assert.equal(tidyMessage(a), b, a);
});

test('검수 목록: 확인한 빨간 쪽은 뒤로, 문제 없는 쪽은 기본으로 숨김', () => {
  const pages = {
    3: { issues: [{ cls: 'note' }] },
    5: { issues: [{ cls: 'review' }], reviewed: true },
    9: { issues: [{ cls: 'review' }, { cls: 'note' }] },
    12: { issues: [] },
  };
  assert.deepEqual(sortReview(pages).map((x) => x.n), [9, 3]);
  assert.deepEqual(sortReview(pages, { showAll: true }).map((x) => x.n), [9, 3, 5, 12]);
  assert.deepEqual(sortReview(pages, { showAll: true, desc: true }).map((x) => x.n), [5, 12, 3, 9]);
});

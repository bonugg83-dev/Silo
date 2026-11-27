import test from 'node:test';
import assert from 'node:assert/strict';
import { findLinks, putNoteAtMarker, removeNoteLine } from '../app/lib/footnotes.js';

test('다른 쪽 각주: 앞쪽 번호와 다음 쪽 설명을 짝지음', () => {
  const book = { pages: { 10: { footMissing: ['각주3'] }, 11: {} } };
  const made = findLinks(book, 11, [{ label: '각주3', note: '설명' }, { label: '각주9', note: '짝 없음' }]);
  assert.deepEqual(made, [{ label: '각주3', note: '설명', from: 10, to: 11, done: false }]);
  assert.equal(findLinks(book, 11, [{ label: '각주3', note: '설명' }]).length, 0, '같은 연결을 두 번 만들지 않음');
});

test('번호 자리에 설명 넣기, 다음 쪽의 설명 줄 지우기', () => {
  assert.deepEqual(putNoteAtMarker('가나[각주3] 다라', '각주3', '설명 $& 글'), { ok: true, text: '가나[각주3: 설명 $& 글] 다라' });
  assert.equal(putNoteAtMarker('[각주3] [각주3]', '각주3', 'x').ok, false);
  assert.equal(putNoteAtMarker('없음', '각주3', 'x').ok, false);
  assert.deepEqual(removeNoteLine('[각주3: 설명]\n본문', '각주3'), { ok: true, text: '본문' });
  assert.equal(removeNoteLine('본문[각주3: 설명] 계속', '각주3').ok, false, '본문 안의 각주는 지우지 않음');
});

test('번호가 달라도 차례대로 짝지음: 앞쪽 [각주***] ↔ 다음 쪽 맨 위 [각주*: 설명] (Gemini처럼 새 번호를 붙인 경우)', () => {
  const book = { pages: { 78: { footMissing: ['각주***'] }, 79: {} } };
  const made = findLinks(book, 79, [{ label: '각주*', note: '이러한 설정은 …' }]);
  assert.deepEqual(made, [{ label: '각주***', toLabel: '각주*', note: '이러한 설정은 …', from: 78, to: 79, done: false }]);
  // 앞쪽에는 앞쪽 번호로 넣고, 다음 쪽에서는 그 쪽 번호의 줄을 지움
  assert.equal(putNoteAtMarker('‘스메타나’[각주***]에 대한', '각주***', '이러한 설정은 …').text, '‘스메타나’[각주***: 이러한 설정은 …]에 대한');
  assert.equal(removeNoteLine('[각주*: 이러한 설정은 …]\n고, 클래식', '각주*').text, '고, 클래식');
  assert.equal(findLinks(book, 79, [{ label: '각주*', note: 'x' }]).length, 0, '이미 짝지은 번호는 다시 안 씀');
});

test('결과 글에서 직접 찾기: 설명 없는 번호, 맨 위에 따로 있는 설명 줄 (모델이 안 알려 줘도)', async () => {
  const { deriveFootnotes } = await import('../app/lib/footnotes.js');
  // 앞쪽: 본문 속 [각주***] 번호만 → 다음 쪽에 설명
  assert.deepEqual(deriveFootnotes('본문 [각주*: 설명] 그리고 ‘스메타나’[각주***]에 대한').missing, ['각주***']);
  // 다음 쪽: 맨 위 설명 줄만 (본문 속 각주는 아님)
  const d = deriveFootnotes('[각주*: 이러한 설정은 연출적 장치로 해석할 수 있다.]\n고, 클래식 음악을 [각주1: 본문 속]');
  assert.deepEqual(d.orphans, [{ label: '각주*', note: '이러한 설정은 연출적 장치로 해석할 수 있다.' }]);
  assert.deepEqual(d.missing, []);
  // 모델이 알려 준 것은 그대로 두고 더함 (같은 것은 한 번만)
  const e = deriveFootnotes('[각주3: 설명]\n본문[각주4]', ['각주4'], [{ label: '각주3', note: '설명' }]);
  assert.deepEqual(e, { missing: ['각주4'], orphans: [{ label: '각주3', note: '설명' }] });
});

test('모든 각주 모양: 숫자·기호·다른 이름, 여러 개는 차례대로. "[주의]" 같은 글은 각주가 아님', async () => {
  const { deriveFootnotes } = await import('../app/lib/footnotes.js');
  const miss = (t) => deriveFootnotes(t).missing;
  assert.deepEqual(miss('가[각주3] 나[각주12] 다[각주***] 라[각주#] 마[미주5] 바[주석*] 사[주2] 아[각주†]'),
    ['각주3', '각주12', '각주***', '각주#', '미주5', '주석*', '주2', '각주†']);
  assert.deepEqual(miss('[주의] 뜨거움 [주요 내용] [주인공]'), []);
  assert.deepEqual(deriveFootnotes('[주의: 뜨거운 물]\n본문').orphans, [], '맨 위 "[주의: …]"도 각주 설명이 아님');
  assert.deepEqual(deriveFootnotes('[미주5: 설명 가]\n[각주12: 설명 나]\n본문').orphans.map((o) => o.label), ['미주5', '각주12']);
  const book = { pages: { 10: { footMissing: ['각주12', '각주13'] }, 11: {} } };
  const made = findLinks(book, 11, [{ label: '각주1', note: '가' }, { label: '각주2', note: '나' }]);
  assert.deepEqual(made.map((l) => [l.label, l.toLabel]), [['각주12', '각주1'], ['각주13', '각주2']]);
});

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

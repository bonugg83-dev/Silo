// 안내서·자료실 규칙: 기호 각주, 책 표지, 차례, 표 표시, 첨자 제작자 주
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../app/lib/rules.js';
import { fixPageKind, tableFlags, hasSubscriptNote, SUBSCRIPT_NOTE } from '../app/lib/special.js';
import { RESULT_SCHEMA, SYSTEM_PROMPT, buildWriteMessage } from '../app/lib/prompt.js';

const rules = (t) => applyRules(t).text;

test('기호 각주는 종류와 상관없이 *, 나온 순서대로', () => {
  assert.equal(rules('본문[각주†] 다음[각주‡]\n[각주†: 하나]\n[각주‡: 둘]'), '본문[각주*] 다음[각주**]\n[각주*: 하나]\n[각주**: 둘]');
  assert.equal(rules('가[각주*] 나[각주※: 설명]'), '가[각주*] 나[각주**: 설명]', '이미 쓴 * 다음 칸을 씀');
  assert.equal(rules('문장[각주 † : 설명]'), '문장[각주*: 설명]');
  assert.equal(rules('문장[각주3: 설명 † 기호]'), '문장[각주3: 설명 † 기호]', '설명 안의 기호는 그대로');
});

test('책 표지: 제목의 단계 표시 삭제', () => {
  const r = fixPageKind('초등 인문학\n@@[그리스·로마 신화\n나음출판', 'book_cover');
  assert.equal(r.text, '초등 인문학\n그리스·로마 신화\n나음출판');
  assert.equal(fixPageKind('@@[머리말', 'body').text, '@@[머리말', '본문은 그대로');
});

test('차례: 제목에 @@[, 항목은 표시 없이, 쪽 번호 앞 0 삭제', () => {
  const r = fixPageKind('차례\n딸기 001\n@@{바나나 003\n석류 015\n레몬 115', 'toc');
  assert.equal(r.text, '@@[차례\n딸기 1\n바나나 3\n석류 15\n레몬 115');
  assert.equal(fixPageKind('@@[차례\n시인의 말\n링 13', 'toc').text, '@@[차례\n시인의 말\n링 13');
  assert.equal(fixPageKind('차 례\n가 1', 'toc').text, '@@[차례\n가 1');
});

test('표: 표마다 빨간 표시(제목 줄 또는 이어진 표의 첫 줄)', () => {
  const f = tableFlags('본문\n[표 2-1] 사회적 경제\n@@t\n영역 시장\nt@@\n[표 끝]');
  assert.equal(f.length, 1);
  assert.equal(f[0].quote, '[표 2-1] 사회적 경제');
  assert.equal(f[0].needs_review, true);
  assert.equal(tableFlags('@@t\n유연탄 50 48.3\nt@@\n[표 끝]')[0].quote, '유연탄 50 48.3');
  assert.equal(tableFlags('[표] 글로만 된 표\n• 우울증\n[표 끝]').length, 0, '@@t 없는 글 표는 표시 안 함');
});

test('첨자 제작자 주: 배정 범위에서 한 번만', () => {
  assert.ok(hasSubscriptNote(`${SUBSCRIPT_NOTE}\nx^10`));
  assert.ok(!hasSubscriptNote('x^10'));
  const base = { currPage: 5, imageWidth: 1, imageHeight: 1 };
  assert.match(buildWriteMessage({ ...base, subscriptNoteUsed: true }), /subscript_note_used/);
  assert.doesNotMatch(buildWriteMessage(base), /subscript_note_used/);
});

test('프롬프트: 새 규칙이 들어 있음', () => {
  assert.ok(RESULT_SCHEMA.properties.page_kind.enum.includes('book_cover'));
  for (const s of ['@@[차례', '" // "', '□1', '○51', '(우)', 'a_n^2', 'x=∑ (i=0 ∞) x_i', '42~43쪽에 이어지는', '자녀:', '찾아보기 면은 생략함', '평가척도', '지은이: 김누리', 'ㅺ→ㄲ']) {
    assert.ok(SYSTEM_PROMPT.includes(s), s);
  }
  assert.ok(!SYSTEM_PROMPT.includes('차례 페이지 자체에는 목차 스타일 표시를 붙이지 않습니다'));
});

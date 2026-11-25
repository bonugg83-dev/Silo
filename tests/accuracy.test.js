import test from 'node:test';
import assert from 'node:assert/strict';
import { alignHeadings, parseToc } from '../extension/lib/headings.js';
import { findOmissions, tooShort, suspiciousSpecial } from '../extension/lib/omission.js';
import { tidyMessage, sortReview } from '../extension/lib/issues.js';

const TOC = '@@[1 청교도의 나라 13\n@@{주홍글씨의 고향 15\n@@[2 아메리칸 르네상스 40\n@@{호손과 멜빌 42';

test('목차 읽기: 쪽 번호를 떼고 단계와 제목', () => {
  const e = parseToc(TOC);
  assert.equal(e.length, 4);
  assert.deepEqual([e[0].marker, e[0].title], ['@@[', '1 청교도의 나라']);
});

test('제목 단계를 목차대로: 장 표지·영문 병기·번호 차이', () => {
  const r = alignHeadings('@@{2 아메리칸 르네상스 (American Renaissance)\n본문입니다.\n@@[제2장 호손과 멜빌', TOC);
  assert.equal(r.text, '@@[2 아메리칸 르네상스 (American Renaissance)\n본문입니다.\n@@{제2장 호손과 멜빌');
  assert.equal(r.changes.length, 2);
});

test('표시 없는 짧은 제목 줄에 목차 단계를 붙임, 본문·시각자료 안은 그대로', () => {
  const r = alignHeadings('호손과 멜빌\n호손과 멜빌은 친구였다.\n[그림] 사진\n@@i\n주홍글씨의 고향\n[그림 끝]', TOC);
  assert.equal(r.text.split('\n')[0], '@@{호손과 멜빌');
  assert.equal(r.text.split('\n')[1], '호손과 멜빌은 친구였다.');
  assert.equal(r.text.split('\n')[4], '주홍글씨의 고향');
});

test('목차에 없는 제목은 건드리지 않음', () => {
  const r = alignHeadings('@@(작은 제목\n본문', TOC);
  assert.equal(r.changes.length, 0);
});

test('누락 경보: 빠진 문장만, 머리말·쪽 번호·옮긴 각주는 제외', () => {
  const ocr = '미국문학 기행\n첫 문장입니다 그리고 이어집니다.\n둘째 문장이 여기에 아주 길게 있습니다 빠지면 안 됩니다.\n셋째 문장.\n1) 각주 설명이 여기에 있습니다 아주 깁니다\n92';
  const res = '첫 문장입니다 그리고 이어집니다.[각주1: 각주 설명이 여기에 있습니다 아주 깁니다]\n셋째 문장.';
  assert.deepEqual(findOmissions(ocr, res), ['둘째 문장이 여기에 아주 길게 있습니다 빠지면 안 됩니다.']);
});

test('누락 경보: 줄바꿈·부호만 다르면 조용', () => {
  const ocr = '남풍의 밤이 여- 큰 별\n오라 벌거벗은 가슴의 밤이여— 오라';
  assert.deepEqual(findOmissions(ocr, '남풍의 밤이여―큰 별 오라 벌거벗은 가슴의 밤이여―오라'), []);
});

test('너무 짧은 결과, 글자 많은 빈 면', () => {
  const long = '가나다라마바사아자차카타파하 '.repeat(20);
  assert.ok(tooShort(long, '가나다'));
  assert.ok(!tooShort(long, long));
  assert.ok(suspiciousSpecial(long, 'blank'));
  assert.ok(!suspiciousSpecial('3 아메리칸 르네상스', 'chapter_cover'));
});

test('검수 문장: “확인이 필요합니다” 같은 꼬리 삭제', () => {
  assert.equal(tidyMessage('앞쪽과 맞지 않습니다. 다른 책의 쪽이 섞였는지 확인이 필요합니다.'), '앞쪽과 맞지 않습니다');
  assert.equal(tidyMessage('[그림]와 [그림 끝]의 개수가 달라요(1/0). 다른 쪽으로 이어지는 경우가 아니면 확인하세요.'), '[그림]와 [그림 끝]의 개수가 달라요(1/0)');
  assert.equal(tidyMessage('낫표 종류 애매, 원본 확인 필요'), '낫표 종류 애매');
  assert.equal(tidyMessage('쪽 번호 추정 (93)'), '쪽 번호 추정 (93)');
});

test('검수 목록 정렬: 빨강 → 노랑 → 없음, 같은 색은 쪽 순서', () => {
  const pages = { 3: { issues: [{ cls: 'warn' }] }, 1: { issues: [] }, 5: { issues: [{ cls: 'review' }, { cls: 'warn' }] }, 2: { issues: [{ cls: 'review' }] }, 4: { issues: [{ cls: 'review' }], reviewed: true } };
  assert.deepEqual(sortReview(pages).map((x) => x.n), [2, 5, 3]);
  assert.deepEqual(sortReview(pages, { showAll: true }).map((x) => x.n), [2, 5, 3, 1, 4]);
  assert.deepEqual(sortReview(pages, { showAll: true, desc: true }).map((x) => x.n), [1, 4, 3, 2, 5]);
});

test('쪽 경계: 앞쪽 끝 문장을 다시 쓰면 잡음', async () => {
  const { repeatsPrevEnd } = await import('../extension/lib/omission.js');
  const prev = '앞 문단입니다.\n그는 마침내 바다로 나아가 오래도록 돌아오지 않았다.';
  assert.ok(repeatsPrevEnd(prev, '그는 마침내 바다로 나아가 오래도록 돌아오지 않았다.\n새 문단.'));
  assert.ok(!repeatsPrevEnd(prev, '새 문단이 시작된다. 아주 다른 이야기다.'));
});

test('주석 표시 띄어쓰기 정리', async () => {
  const { applyRules } = await import('../extension/lib/rules.js');
  assert.equal(applyRules('본문[각주 3]이다.').text, '본문[각주3]이다.');
  assert.equal(applyRules('[각주12 :설명]').text, '[각주12: 설명]');
});

test('사이드 패널이 쓰는 이름을 모듈들이 모두 내보냄', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/lib\/(\w+)\.js'/g)) {
    if (['page', 'splash', 'convert', 'visuals', 'cleanup'].includes(m[2])) continue; // 브라우저 전용 모듈
    const mod = await import(`../extension/lib/${m[2]}.js`);
    for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(name in mod, `${m[2]}.js에 ${name} 없음`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../app/lib/rules.js';

const fix = (s, o) => applyRules(s, o).text;

// 151쪽 최종 교정본: 이미 규칙에 맞으므로 바뀌는 것이 없어야 한다
const PAGE151 = `오라 벌거벗은 가슴의 밤이여―오라 매력과 자양의 밤이여!/남풍의 밤이여―큰 별 드문드문한 밤이여!/조용히 조는 밤―열정과 나신의 밤./요염한 웃음 서늘한 입김의 땅이여!/잠자며 유동하는 수목의 땅이여!/사라진 일몰의 땅이여―안개 자욱한 산봉오리의 땅이여!/푸른빛 도는 만월의 유리 빛 흐름의 땅이여!/강물에 반점을 그리는 명암의 땅이여!/날 위해 더 밝고 뚜렷한 은회색 구름의 땅이여!/비스듬히 길게 누운 땅이여―사과꽃 향기 짙은 땅이여!/웃어라, 네 애인이 오니,/풍부한 자여, 그대는 내게 사랑을 주었다―그리하여/나도 네게 사랑을 준다!/아, 말할 수 없이 열정적인 사랑을.
52
나는 내 자신을 흙에 양도한다. 내가 사랑하는 풀에서 자라게끔/나를 또 보고 싶으면 그대의 구두창 밑을 살펴라./그대는 내가 누구이며 내가 뜻하는 바를 전혀 모를 것이다/그러나 그대의 건강을 도울 것이다/그대의 피를 걸러주고 힘 있게 해줄 것이다./처음에 못 만나더라도 계속 힘을 내라/한 곳에 없으면 딴 곳을 찾아라/어딘가 멈추어 그대를 기다린다.
―이영걸 옮김, 『19세기 美詩』, 탐구당, 1990; 윤명옥 옮김, 『휘트먼 시선』, 지만지, 2010.

미국 문학사에서는 물론이고 세계의 유명 시인들도 접근조차 하지 못했던 주제와 소재로 쓴 시 「나는 미국이 노래하는 소리를 듣는다(I Hear America Singing)」도 주목해보자. “나는 미국이 노래하는 소리를 듣는다, 다양하고 즐거운 노래들을 듣는다”로 시작하는 이 시는 기계공, 목공, 석공, 뱃사공, 갑판원, 제화공, 모자 기능공, 나무꾼, 어머니, 아가씨 등 온갖 민중들의 활기찬 삶을 보여준다. “미국이 노래하는” 구절에서 ‘미국(America)’은 단순한 국가명이 아닌, 영토와 주민과 그 삶 전체를 두루 포괄하는 개념이다.`;

test('151쪽 교정본은 그대로 통과', () => {
  const r = applyRules(PAGE151, { allowBlankLines: true });
  assert.equal(r.text, PAGE151);
  assert.deepEqual(r.changes, []);
});

test('OCR 오류 부호 교정', () => {
  assert.equal(fix('밤이여一 오라 매력'), '밤이여―오라 매력');
  assert.equal(fix('밤이여— 오라'), '밤이여―오라');
  assert.equal(fix('밤이여— 오라', { dashSpacing: 'keep' }), '밤이여― 오라');
  assert.equal(fix('탐구당, 1990； 윤명옥'), '탐구당, 1990; 윤명옥');
  assert.equal(fix('天人一體'), '天人一體');
  assert.equal(fix('이영걸 옮김,『19세기'), '이영걸 옮김, 『19세기');
});

test('산괄호/부등호', () => {
  assert.equal(fix('<자원봉사론>을 읽었다'), '〈자원봉사론〉을 읽었다');
  assert.equal(fix('영화 <그녀(Her)>(2013)와'), '영화 〈그녀(Her)〉(2013)와');
  assert.equal(fix('−1<x<1'), '−1＜x＜1');
  assert.equal(fix('『 맛있는 포도 』'), '『맛있는 포도』');
});

test('빼기, 단위, 가운뎃점, 로마숫자', () => {
  assert.equal(fix('5-1=4'), '5−1=4');
  assert.equal(fix('2010-2015년'), '2010-2015년');
  assert.equal(fix('키가 170cm이다'), '키가 170㎝이다');
  assert.equal(fix('icm 같은 글자'), 'icm 같은 글자');
  assert.equal(fix('이미솔 ・ 신현주'), '이미솔·신현주');
  assert.equal(fix('제Ⅳ장'), '제IV장');
});

test('따옴표', () => {
  assert.equal(fix('"전자도서란 무엇인가"'), '“전자도서란 무엇인가”');
  assert.equal(fix("I'm a student."), "I'm a student.");
  assert.equal(fix("'88 서울올림픽"), "'88 서울올림픽");
  assert.equal(fix("그는 '미국'이라 했다"), '그는 ‘미국’이라 했다');
});

test('쌍점과 공백', () => {
  assert.equal(fix('영양:가공식품'), '영양: 가공식품');
  assert.equal(fix('영양 : 가공식품'), '영양: 가공식품');
  assert.equal(fix('10:30에 만나'), '10:30에 만나');
  assert.equal(fix('형: 도저히'), '형: 도저히');
  assert.equal(fix('  들여쓰기  된   줄  '), '들여쓰기 된 줄');
});

test('빈 줄', () => {
  assert.equal(fix('\n\n가\n\n나\n\n'), '가\n나');
  assert.equal(fix('\n가\n\n\n나\n', { allowBlankLines: true }), '가\n\n나');
});

test('장면 전환', () => {
  assert.equal(fix('가\n◆ ◆ ◆\n나'), '가\n***\n나');
  assert.equal(fix('가\n***\n나'), '가\n***\n나');
  assert.equal(fix('--년 --월'), '--년 --월');
});

test('경고: 괄호 짝, 숫자 줄', () => {
  const r = applyRules('『맛있는 포도>');
  assert.ok(r.warnings.some((w) => w.rule === '괄호 짝'));
  const r2 = applyRules('본문\n151');
  assert.ok(r2.warnings.some((w) => w.rule === '쪽 번호'));
});

test('시각자료 짝', () => {
  assert.equal(applyRules('[그림]\n@@i\n설명\n[그림 끝]').warnings.length, 0);
  assert.equal(applyRules('[표 2-1] 사회적 경제\n@@t\n가 나\nt@@\n[표 끝]').warnings.length, 0);
  assert.ok(applyRules('[사진]\n@@i').warnings.some((w) => w.rule === '시각자료'));
});

test('짝 검사: 낫표·산괄호만', () => {
  // 쪽을 넘어 이어지는 소괄호·따옴표는 경고하지 않음
  assert.equal(applyRules('그는 “안녕(하세요').warnings.filter((w) => w.rule === '괄호 짝').length, 0);
  assert.ok(applyRules('『주홍글씨」를 읽었다').warnings.some((w) => w.rule === '괄호 짝' && /『/.test(w.message)));
  assert.ok(applyRules('「인간·종교·국가』').warnings.some((w) => w.rule === '괄호 짝'));
  assert.equal(applyRules('『주홍글씨』와 「큰 바위 얼굴」').warnings.length, 0);
});

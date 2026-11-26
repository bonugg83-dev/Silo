// 관리자 피드백: 마이페이지·피드백 팝업 읽기, 합치기, Claude에게 줄 목록, 모두의 목록(클라우드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBookList, parseFeedPopup, mergeFeedback, feedbackDigest, cellText } from '../extension/lib/feedback.js';
import { createCloud } from '../extension/lib/cloud.js';
import { buildBookBlock } from '../extension/lib/prompt.js';
import { fakeFirebase } from './fake-firebase.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('마이페이지: 피드백 버튼이 있는 책만', () => {
  const books = parseBookList(fx('mypage_book.html'));
  assert.deepEqual(books, [{ idx: '319679', title: '세상에서 가장 짧은 경제사', range: '91 ~ 105', count: 2 }]);
});

test('피드백 팝업: 쪽·유형·내용·날짜', () => {
  const f = parseFeedPopup(fx('pop_feed.html'));
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { page: '98', type: '기타', text: '내용이 없거나, 또는 장식적 기능의 문구만 있는 페이지는 편집화면에 ‘빈 면’이라고 입력주세요.', date: '2026.11.26' });
  assert.equal(f[1].text, '기호로 된 각주는 기호의 종류와 상관없이 *로 수정합니다.(제작안내서 50페이지를 참고)\n예) [각주*: ...] [각주**: …]');
  assert.equal(cellText('a&nbsp;&lt;b&gt;<br>c'), 'a <b>\nc');
});

test('합치기: 같은 책·쪽·내용은 한 번만', () => {
  const items = parseFeedPopup(fx('pop_feed.html')).map((f) => ({ ...f, idx: '1' }));
  const a = mergeFeedback([], items);
  assert.equal(a.added.length, 2);
  const b = mergeFeedback(a.list, items);
  assert.equal(b.added.length, 0);
  assert.equal(b.list.length, 2);
});

test('Claude에게 줄 목록: 모두의 것과 합쳐 많이 받은 순, 같은 내용은 하나', () => {
  const mine = [{ type: '기타', text: '빈 면이라고 입력주세요.' }, { type: '오탈자', text: '띄어쓰기 오류' }];
  const shared = [{ type: '기타', text: '빈 면이라고 입력주세요', count: 5 }, { type: '형식', text: '각주는 *', count: 2 }];
  const d = feedbackDigest(mine, shared).split('\n');
  assert.deepEqual(d, ['- [기타 5회] 빈 면이라고 입력주세요', '- [형식 2회] 각주는 *', '- [오탈자] 띄어쓰기 오류']);
  assert.equal(feedbackDigest([], []), '');
  assert.match(buildBookBlock({ adminFeedback: d.join('\n') }), /<admin_feedback>[\s\S]*빈 면/);
  assert.doesNotMatch(buildBookBlock({}), /admin_feedback/);
});

test('모두의 피드백: 올리면 같은 내용은 횟수만 늘고, 회원만 읽음', async () => {
  const fb = fakeFirebase('CODE');
  const fetch = async (url, init = {}) => {
    let body = init.body;
    try { body = JSON.parse(body); } catch { /* form */ }
    const r = fb.handle(url, init.method || 'GET', body, init.headers?.Authorization);
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  const c = createCloud({ fetch });
  const a = await c.signUp({ id: '가', password: 'pw1234', code: 'CODE', profile: { name: '가' } });
  const b = await c.signUp({ id: '나', password: 'pw1234', code: 'CODE', profile: { name: '나' } });
  await c.pushFeedback(a, [{ type: '기타', text: '빈 면이라고 입력주세요.', idx: '1', page: '98', title: '책' }]);
  await c.pushFeedback(b, [{ type: '기타', text: '빈 면이라고  입력주세요', idx: '2', page: '3' }, { type: '오탈자', text: '오타' }]);
  const list = await c.listFeedback(a);
  assert.deepEqual(list.map((x) => [x.text, x.count]), [['빈 면이라고  입력주세요', 2], ['오타', 1]]);
  const stored = [...fb.docs].filter(([k]) => k.startsWith('/feedback/')).map(([, f]) => Object.keys(f).sort().join(','));
  assert.deepEqual([...new Set(stored)], ['count,text,type'], '사람·책 정보는 올리지 않음');
});

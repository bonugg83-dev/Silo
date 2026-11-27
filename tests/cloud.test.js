import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, idEmail, authPassword, toFields, fromFields, pickSettings, pickProfile, monthFromDoc, OfflineError } from '../app/lib/cloud.js';

test('아이디는 대소문자 상관없이 같은 내부 이메일, 한글도 됨', async () => {
  assert.equal(await idEmail(' Kim '), await idEmail('kim'));
  assert.match(await idEmail('김교정'), /^u[0-9a-f]{40}@silo-app\.com$/);
});

test('서버로 가는 비밀번호는 원래 비밀번호가 아님', async () => {
  const a = await authPassword('kim', '1234');
  assert.ok(!a.includes('1234'));
  assert.ok(a.length >= 6, 'Firebase 최소 6자');
  assert.notEqual(a, await authPassword('lee', '1234'));
});

test('Firestore 값 주고받기', () => {
  const o = { a: 1, b: 1.5, c: 'x', d: true, e: null, f: [1, 'y'], g: { h: 2 } };
  assert.deepEqual(fromFields(toFields(o)), o);
});

test('평문 키, 책 진행은 올리지 않음', () => {
  assert.deepEqual(pickSettings({ keys: [{ key: 'sk' }], apiKey: 'sk', verify: true }), { verify: true });
  const p = pickProfile({ id: 'local', name: 'kim', enc: {}, mask: 'm', book: 1 });
  assert.deepEqual(Object.keys(p).sort(), ['enc', 'mask', 'name']);
});

test('한 달 비용 문서 읽기', () => {
  assert.deepEqual(monthFromDoc({ usd: 0.75, u26: 0.75, p26: 3 }), { usd: 0.75, days: { 26: { usd: 0.75, pages: 3 } } });
  assert.deepEqual(monthFromDoc(null), { usd: 0, days: {} });
});

const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('인터넷이 끊기면 OfflineError', async () => {
  const c = createCloud({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(c.signIn({ id: 'kim', password: '1234' }), OfflineError);
});

test('가입 코드가 틀리면 만든 로그인 계정을 지우고 알림', async () => {
  const calls = [];
  const c = createCloud({
    fetch: async (url) => {
      calls.push(url);
      if (url.includes(':signUp')) return res(200, { localId: 'U', idToken: 'T', refreshToken: 'R', expiresIn: '3600' });
      if (url.includes('/users?documentId=U')) return res(403, { error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } });
      return res(200, {});
    },
  });
  await assert.rejects(c.signUp({ id: 'kim', password: '1234', code: 'x', profile: { name: 'kim' } }), /가입 코드/);
  assert.ok(calls.some((u) => u.includes(':delete')));
});

test('없는 아이디 / 틀린 비밀번호 문구', async () => {
  const c = createCloud({ fetch: async () => res(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS', status: 'INVALID_ARGUMENT' } }) });
  await assert.rejects(c.signIn({ id: 'kim', password: '1' }), /맞지 않아요/);
});

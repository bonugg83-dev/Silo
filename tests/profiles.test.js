import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptKey, decryptKey, makeProfile, checkPassword, isApiKey, maskKey, legacyMigration, profileDataKeys,
  lockExpired, overLimit, runLockedByOther, bookKey, costMonthKey,
} from '../app/lib/profiles.js';
import { staleBookKeys } from '../app/lib/cleanup.js';

const KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234';

test('비밀번호로 키를 잠그고 풂, 틀린 비밀번호는 null', async () => {
  const rec = await encryptKey(KEY, '1234', 1000);
  assert.ok(!JSON.stringify(rec).includes('TESTKEY'), '저장된 값에 키가 보이지 않음');
  assert.equal(await decryptKey(rec, '1234'), KEY);
  assert.equal(await decryptKey(rec, '1235'), null);
});

test('계정 기록에는 키 앞뒤 일부만', async () => {
  const p = await makeProfile({ name: ' 김교정 ', apiKey: KEY, password: 'abcd', index: 7, iter: 1000 });
  assert.equal(p.name, '김교정');
  assert.equal(p.mask, 'sk-ant-a…1234');
  assert.equal(p.lockAfterMin, 30);
  assert.ok(!JSON.stringify(p).includes('TESTKEY'));
  assert.equal(maskKey(''), '');
});

test('입력 검사', () => {
  assert.ok(isApiKey(KEY));
  assert.ok(!isApiKey('sk-123'));
  assert.match(checkPassword('12'), /4자/);
  assert.match(checkPassword('1234', '1235'), /달라/);
  assert.equal(checkPassword('1234', '1234'), '');
});

test('계정이 없던 때 기록은 처음 계정으로 옮김', () => {
  const all = { settings: {}, 'book:23584': { pages: {} }, 'book:p1:9': {}, 'cost:2026-11-24': 1.5, 'cost:2026-11-25': 0.5, 'costpages:2026-11-25': 3, usageLog: [] };
  const { set, remove } = legacyMigration(all, 'P');
  assert.deepEqual(Object.keys(set).sort(), ['book:P:23584', 'cost:P:2026-11-24', 'cost:P:2026-11-25', 'costmonth:P:2026-11', 'costpages:P:2026-11-25']);
  assert.equal(set['costmonth:P:2026-11'], 2);
  assert.deepEqual(remove.sort(), ['book:23584', 'cost:2026-11-24', 'cost:2026-11-25', 'costpages:2026-11-25']);
});

test('계정 지울 때 그 계정 기록만', () => {
  const all = { 'book:A:1': 1, 'book:B:1': 1, 'cost:A:2026-11-25': 1, [costMonthKey('A', '2026-11')]: 1, profiles: [] };
  assert.deepEqual(profileDataKeys(all, 'A').sort(), ['book:A:1', 'cost:A:2026-11-25', 'costmonth:A:2026-11']);
});

test('오래된 책 정리는 계정별 키에도', () => {
  const now = Date.UTC(2026, 10, 25);
  const all = { [bookKey('A', 1)]: { lastOpened: now - 72 * 3600e3, pages: {} }, [bookKey('A', 2)]: { lastOpened: now, pages: {} } };
  assert.deepEqual(staleBookKeys(all, now), ['book:A:1']);
});

test('자동 로그아웃, 월 한도, 다른 창 실행', () => {
  const now = 10_000_000;
  assert.ok(lockExpired({ lastUsed: now - 31 * 60000 }, { lockAfterMin: 30 }, now));
  assert.ok(!lockExpired({ lastUsed: now - 29 * 60000 }, { lockAfterMin: 30 }, now));
  assert.ok(!lockExpired({ lastUsed: 0 }, { lockAfterMin: 0 }, now), '0이면 브라우저를 닫을 때만');
  assert.ok(lockExpired(null, {}, now));
  assert.ok(overLimit({ monthlyLimit: 20 }, 20));
  assert.ok(!overLimit({ monthlyLimit: 0 }, 999));
  assert.ok(runLockedByOther({ owner: 'x', at: now - 1000 }, 'me', now));
  assert.ok(!runLockedByOther({ owner: 'me', at: now }, 'me', now));
  assert.ok(!runLockedByOther({ owner: 'x', at: now - 61000 }, 'me', now));
});

test('Gemini 키만으로 프로필 만들기 (Claude 키 칸 없음)', async () => {
  const p = await makeProfile({ name: 'gem', geminiKey: 'AIzaSyTESTGEMINIKEY_abcdefghijklmnop', password: 'abcd', iter: 1000 });
  assert.ok(!('enc' in p) && !('mask' in p));
  assert.equal(await decryptKey(p.genc, 'abcd'), 'AIzaSyTESTGEMINIKEY_abcdefghijklmnop');
  assert.equal(await decryptKey(p.enc, 'abcd'), null, '없는 키는 null');
});

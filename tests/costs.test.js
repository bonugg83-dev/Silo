import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionCosts, costLabel, priceOf, TOKENS } from '../app/lib/costs.js';

const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('기록이 없으면 예상값: Opus 5.5 1차 약 $0.10, 2차 +$0.07, 전체 +$0.04, 확대 +$0.03', () => {
  const c = optionCosts('claude-opus-5-5', { verify: true, verifyFull: false, zoom: true }, []);
  near(c.first, 0.101); near(c.verify, 0.075); near(c.full, 0.04); near(c.zoom, 0.034);
  assert.deepEqual(c.measured, { first: false, verify: false, full: false, zoom: false });
  near(c.total, 0.101 + 0.075 + 0.4 * 0.034);
});

test('모델 값에 따라: Sonnet 5.5는 절반, Fable 5.2는 두 배 (캐시 읽기 값만 조금 다름)', () => {
  const o = priceOf('claude-opus-5-5', TOKENS.first);
  near(priceOf('claude-sonnet-5-5', TOKENS.first), o / 2, 0.002);
  near(priceOf('claude-fable-5-2', TOKENS.first), o * 2, 0.003);
});

test('2차 검증을 끄면 확대가 필요한 쪽에서 확인 호출 값까지 더함', () => {
  const c = optionCosts('claude-opus-5-5', { verify: false, zoom: true }, []);
  near(c.total, c.first + 0.4 * (c.zoom + c.verify));
  const off = optionCosts('claude-opus-5-5', { verify: false, zoom: false }, []);
  near(off.total, off.first);
});

test('기록이 쌓이면 실제 평균으로', () => {
  const log = [
    ...Array(3).fill({ model: 'claude-opus-5-5', usd: 0.12, calls: 1, zoom: false, verifyFull: false }),
    ...Array(3).fill({ model: 'claude-opus-5-5', usd: 0.2, calls: 2, zoom: false, verifyFull: false }),
    ...Array(2).fill({ model: 'claude-opus-5-5', usd: 0.3, calls: 2, zoom: true, verifyFull: false }), // 2개라 아직 예상값
    { model: 'claude-sonnet-5-5', usd: 9, calls: 1 }, // 다른 모델은 안 섞음
  ];
  const c = optionCosts('claude-opus-5-5', { verify: true }, log);
  near(c.first, 0.12); near(c.verify, 0.08);
  assert.equal(c.measured.zoom, false);
  assert.equal(c.samples, 8);
});

test('비용 글자', () => {
  assert.equal(costLabel(0.07), '+$0.07 (약 100원)');
  assert.equal(costLabel(0.175, { plus: false }), '$0.17 (약 250원)');
});

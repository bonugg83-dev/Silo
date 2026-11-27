import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleBookKeys, lastUsed, BOOK_MAX_AGE_MS } from '../app/lib/cleanup.js';

const now = Date.UTC(2026, 10, 25);
const H = 3600 * 1000;

test('2일 넘게 안 연 책만 지움', () => {
  const all = {
    settings: { keys: [] },
    'cost:2026-11-20': 1.2,
    'book:1': { lastOpened: now - 49 * H, pages: {} },
    'book:2': { lastOpened: now - 47 * H, pages: {} },
    'book:3': { pages: { 5: { at: now - H } } },
    'book:4': { pages: { 5: { at: now - 72 * H } } },
    'book:5': { pages: {} },
  };
  assert.deepEqual(staleBookKeys(all, now).sort(), ['book:1', 'book:4', 'book:5']);
});

test('열어 본 때와 쪽을 넣은 때 중 늦은 때 기준', () => {
  assert.equal(lastUsed({ lastOpened: 10, pages: { 1: { at: 30 }, 2: { at: 20 } } }), 30);
  assert.equal(lastUsed(null), 0);
  assert.equal(BOOK_MAX_AGE_MS, 48 * H);
});

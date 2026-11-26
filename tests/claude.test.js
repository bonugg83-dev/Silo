import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, ClaudeError } from '../extension/lib/claude.js';

const okResponse = () => new Response(JSON.stringify({
  content: [{ type: 'text', text: '{"text":"ok"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn',
}), { status: 200, headers: { 'content-type': 'application/json' } });

const params = { apiKey: 'k', model: 'claude-opus-5-5', effort: 'high', userText: 'hi', useFallbacks: false };

test('연결이 잠깐 끊겨도 다시 시도해서 받는다', async () => {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { if (n++ === 0) throw new TypeError('Failed to fetch'); return okResponse(); };
  try {
    const r = await callClaude(params);
    assert.equal(r.result.text, 'ok');
    assert.equal(n, 2);
  } finally { globalThis.fetch = orig; }
});

test('취소하면 다시 시도하지 않고 바로 멈춘다', async () => {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError('Failed to fetch'); };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  try {
    await assert.rejects(callClaude({ ...params, signal: ac.signal }), (e) => e.name === 'AbortError' && !(e instanceof ClaudeError));
    assert.equal(n, 1);
  } finally { globalThis.fetch = orig; }
});

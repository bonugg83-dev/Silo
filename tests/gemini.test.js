// Gemini 호출(app/lib/gemini.js)을 가짜 응답으로 시험: callClaude 와 같은 모양으로 받고 돌려주는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, ClaudeError, MODELS, estimateCostUsd } from '../app/lib/claude.js';
import { isGemini, isGeminiKey, usageFromGemini, verifyGeminiKey } from '../app/lib/gemini.js';
import { RESULT_SCHEMA, VERIFY_SCHEMA } from '../app/lib/prompt.js';

const KEY = 'AIzaSyTESTKEY_abcdefghijklmnopqrstuvwx';
const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const reply = (obj, { finishReason = 'STOP', usage = { promptTokenCount: 5000, cachedContentTokenCount: 3000, candidatesTokenCount: 800, thoughtsTokenCount: 1200 } } = {}) =>
  new Response(JSON.stringify({
    candidates: [{ finishReason, content: { role: 'model', parts: [{ text: '생각', thought: true }, { text: JSON.stringify(obj), thoughtSignature: 'SIG' }] } }],
    usageMetadata: usage, modelVersion: 'gemini-3.1-pro-preview',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

async function withFetch(f, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try { return await run(); } finally { globalThis.fetch = orig; }
}

test('모델·키 알아보기', () => {
  assert.ok(isGemini('gemini-3.1-pro-preview'));
  assert.ok(!isGemini('claude-opus-5-5'));
  assert.ok(isGeminiKey(KEY));
  assert.ok(isGeminiKey('AQ.Ab8RN6Kz_newStyleKey-1234567890abcdef'), '앞글자가 AIza가 아닌 새 모양 키도 받음');
  assert.ok(!isGeminiKey('sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx'), 'Claude 키는 아님');
  assert.ok(!isGeminiKey('짧은키'));
  assert.ok(!isGeminiKey('abc def ghi jkl mno pqr stu'), '띄어쓰기 섞인 것은 아님');
  assert.ok(MODELS.some((m) => m.id === 'gemini-3.1-pro-preview' && m.provider === 'gemini'));
});

test('1차 교정: 키는 x-goog-api-key, 지시문+책 정보는 systemInstruction, 응답 형식은 JSON 스키마', async () => {
  let req;
  const r = await withFetch(async (url, init) => { req = { url, init, body: JSON.parse(init.body) }; return reply({ text: '고친 글' }); },
    () => callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', effort: 'high', images: [IMG], userText: '이 쪽', system: '지침', bookBlock: '책 정보' }));
  assert.match(req.url, /models\/gemini-3\.1-pro-preview:generateContent$/);
  assert.equal(req.init.headers['x-goog-api-key'], KEY);
  assert.equal(req.body.systemInstruction.parts[0].text, '지침\n\n책 정보');
  assert.deepEqual(req.body.generationConfig.responseJsonSchema, RESULT_SCHEMA);
  assert.equal(req.body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.equal(req.body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(r.result.text, '고친 글');
  // 사용량은 Claude 이름으로: 캐시된 3000은 따로, 생각 토큰은 출력에
  assert.deepEqual(r.usage, { input_tokens: 2000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 2000 });
  // 비용: 2000×$2 + 3000×$0.2 + 2000×$12 (100만 토큰당)
  assert.equal(Math.round(estimateCostUsd('gemini-3.1-pro-preview', r.usage) * 1e6), 2000 * 2 + 3000 * 0.2 + 2000 * 12);
});

test('2차 검증은 앞 대화에 이어서: 모델 답(생각 서명 포함)을 그대로 돌려 보냄', async () => {
  const first = await withFetch(async () => reply({ text: '초안' }),
    () => callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', effort: 'high', images: [IMG], userText: '1차' }));
  let body;
  await withFetch(async (_u, init) => { body = JSON.parse(init.body); return reply({ fixes: [], flags: [] }); },
    () => callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', effort: 'high', prior: first.turn, images: [], userText: '2차', schema: VERIFY_SCHEMA }));
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(body.contents[1].parts.at(-1).thoughtSignature, 'SIG');
  assert.deepEqual(body.generationConfig.responseJsonSchema, VERIFY_SCHEMA);
});

test('오류: 키 없음, 틀린 키, 저작권 반복 막힘, 잘림', async () => {
  await assert.rejects(callClaude({ apiKey: '', model: 'gemini-3.1-pro-preview', userText: 'x' }), /Gemini 키를 넣어/);
  await withFetch(async () => new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 }),
    () => assert.rejects(callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', userText: 'x' }), /Gemini 키가 올바르지/));
  await withFetch(async () => reply({}, { finishReason: 'RECITATION' }),
    () => assert.rejects(callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', userText: 'x' }), (e) => e instanceof ClaudeError && e.retryable && /그대로 옮기는/.test(e.message)));
  await withFetch(async () => reply({}, { finishReason: 'MAX_TOKENS' }),
    () => assert.rejects(callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', userText: 'x' }), /잘렸어요/));
});

test('연결이 잠깐 끊겨도 다시 시도', async () => {
  let n = 0;
  const r = await withFetch(async () => { if (n++ === 0) throw new TypeError('Failed to fetch'); return reply({ text: 'ok' }); },
    () => callClaude({ apiKey: KEY, model: 'gemini-3.1-pro-preview', userText: 'x' }));
  assert.equal(r.result.text, 'ok');
  assert.equal(n, 2);
});

test('사용량 바꾸기: 빈 값도 0', () => {
  assert.deepEqual(usageFromGemini(), { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
});

test('키 확인: 구글이 받으면 ok, 거절하면 그 이유, 연결이 안 되면 offline', async () => {
  let hdr;
  assert.deepEqual(await withFetch(async (u, init) => { hdr = init.headers['x-goog-api-key']; return new Response('{"models":[]}', { status: 200 }); }, () => verifyGeminiKey(KEY)), { ok: true });
  assert.equal(hdr, KEY);
  const bad = await withFetch(async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }), () => verifyGeminiKey(KEY));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not valid/);
  const off = await withFetch(async () => { throw new TypeError('Failed to fetch'); }, () => verifyGeminiKey(KEY));
  assert.equal(off.offline, true);
});

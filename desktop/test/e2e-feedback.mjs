// 관리자 피드백 자동 가져오기
//   마이픽 로그인 확인(마이페이지를 읽을 수 있음) → 지난 기록과 비교해 새 피드백만 가져와 저장·모두의 목록에 올림
//   → 같은 실행에서 다시 읽지 않음 → 다른 Silo 계정은 로그인하자마자 모두의 목록을 받음
// 실행: cd desktop && xvfb-run -a node test/e2e-feedback.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'silo-fb-')) },
});
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re);
}
const mock = () => app.evaluate(() => ({ feedPops: globalThis.__mock.feedPops || 0 }));
const panel = await find(/sidepanel\.html/);
const record = () => panel.evaluate(async () => {
  const { activeProfileId: id } = await siloPlatform.storage.local.get('activeProfileId');
  return (await siloPlatform.storage.local.get(`feedback:${id}`))[`feedback:${id}`] || null;
});
async function until(f, why, timeout = 20000) {
  for (let t = 0; t < timeout; t += 200) { if (await f()) return; await sleep(200); }
  throw new Error(why);
}
async function signup(name) {
  await panel.waitForFunction(() => document.body.classList.contains('auth-open') && !document.body.classList.contains('splashing'), null, { timeout: 20000 });
  if (await panel.isVisible('#toSignup')) await panel.click('#toSignup');
  await panel.waitForFunction(() => document.activeElement?.id === 'newDisplayName', null, { timeout: 3000 }).catch(() => {});
  await panel.fill('#newDisplayName', '홍길동'); await panel.fill('#newName', name); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
  if (await panel.isVisible('#newKey')) await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
  await panel.fill('#newCode', 'TESTCODE');
  await panel.click('#btnSignup');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'), null, { timeout: 15000 });
}

// A 가입 → 사이트(마이픽)가 열려 있으므로 로그인 확인 → 피드백 자동으로 가져옴
await signup('kim');
await until(async () => ((await record())?.list || []).length > 0, '내 피드백을 가져오지 않음');
let fb = await record();
assert.ok(fb.list.length >= 1, '내 피드백 저장');
assert.ok(fb.pushed.length >= 1, '모두의 목록에 올림');
assert.ok(fb.shared.length >= 1, '모두의 목록 받음');
assert.match(await panel.textContent('#progress'), /새 관리자 피드백 \d+건을 가져왔어요/);
const pops = (await mock()).feedPops;
console.log('✓ 마이픽 로그인 확인 → 새 피드백 자동으로 가져와 올림', fb.list.length, '건');

// 같은 실행에서는 마이픽 쪽이 다시 열려도 다시 읽지 않음
await app.evaluate(({ webContents }) => { for (const wc of webContents.getAllWebContents()) if (/mypickebook\.org\/$/.test(wc.getURL())) wc.reload(); });
await sleep(2500);
assert.equal((await mock()).feedPops, pops, '다시 읽지 않음');
console.log('✓ 같은 실행에서는 다시 가져오지 않음');

// B(다른 Silo 계정) 가입 → 로그인하자마자 A가 올린 모두의 피드백을 받음
await panel.click('#btnOpenSettings');
await panel.click('#btnLogout');
await signup('lee');
await until(async () => ((await record())?.shared || []).length > 0, 'B가 모두의 피드백을 받지 않음');
fb = await record();
assert.ok(fb.shared.some((f) => f.text), 'B도 모두의 피드백을 받음');
console.log('✓ 다른 계정은 로그인하자마자 모두의 피드백을 받음');

await app.close();
console.log('모두 통과');

// 사이트가 여는 여러 방식의 팝업이 모두 열리고, 편집 화면 팝업은 패널이 찾는지
//   빈 창을 먼저 열고 폼을 그 창으로 보내기 / about:blank 로 열고 주소 바꾸기 / 일반 팝업(기록 확인)
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
const accounts = fs.existsSync(path.join(process.env.SILO_EXT || path.join(root, '..', 'extension'), 'lib', 'profiles.js'));

const app = await electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, SILO_MOCK: path.join(here, 'mock-site.js'), SILO_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'silo-pop-')) },
});
async function find(re, timeout = 15000) {
  for (let t = 0; t < timeout; t += 100) {
    const p = app.windows().find((w) => re.test(w.url()));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('창 없음: ' + re + ' / ' + app.windows().map((w) => w.url()).join(', '));
}
const panel = await find(/sidepanel\.html/);
panel.on('dialog', (d) => d.accept());
await panel.waitForFunction(() => !document.querySelector('canvas.splash'), null, { timeout: 15000 });
if (accounts) {
  await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
  await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
  await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
  await panel.click('#btnSignup');
  await panel.waitForFunction(() => !document.body.classList.contains('auth-open'));
  await sleep(800);
}
// 지금 왼쪽 사이트 화면 (가입하면 그 사람 로그인 칸으로 새로 만들어짐)
async function sitePage() {
  const id = await app.evaluate(() => globalThis.__silo.siteId());
  for (let t = 0; t < 5000; t += 100) {
    for (const w of app.windows()) {
      if (!/mypickebook\.org\/$/.test(w.url())) continue;
      if (await app.evaluate(({ webContents }, [u, i]) => webContents.fromId(i)?.getURL() === u, [w.url(), id])) { await w.waitForLoadState(); return w; }
    }
    await sleep(100);
  }
  throw new Error('사이트 화면 없음');
}
const closeEditors = async () => {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/make_book|history/.test(w.webContents.getURL())) w.close(); });
  await sleep(400);
};
async function editorFound() {
  // 패널이 편집 화면을 찾아 읽을 수 있는지 (교정하기 첫 단계와 같은 길)
  return panel.evaluate(async () => {
    const all = (await chrome.tabs.query({})).filter((t) => /mypickebook\.org\/making\/make_book\.html/.test(t.url));
    if (all.length !== 1) return 'editors=' + all.length;
    const [r] = await chrome.scripting.executeScript({ target: { tabId: all[0].id }, world: 'MAIN', func: () => document.querySelector('#curr_page') ? 'ok' : 'no-editor', args: [] });
    return r.result;
  });
}

for (const [btn, label] of [['#editPopup', '일반 팝업'], ['#editForm', '빈 창 + 폼 전송'], ['#editBlankThenGo', 'about:blank → 주소 이동'], ['#editBlank', '새 탭(target=_blank)']]) {
  const home = await sitePage();
  await home.click(btn);
  const ed = await find(/make_book\.html/);
  await ed.waitForFunction(() => window.CKEDITOR && CKEDITOR.instances.content);
  assert.equal(await editorFound(), 'ok', label);
  const bar = await find(/bar\.html/);
  await bar.waitForFunction(() => /편집 화면 연결됨/.test(document.getElementById('link').textContent), null, { timeout: 5000 });
  console.log('✓', label, ': 열리고 패널이 찾음');
  await closeEditors();
}
const home = await sitePage();
await home.click('#history');
const hist = await find(/history\.html/);
assert.equal(await hist.textContent('#h'), '작업 기록');
console.log('✓ 기록 확인 팝업');
const bar = await find(/bar\.html/);
await bar.click('#diagnostics');
const diag = await app.evaluate(({ clipboard }) => clipboard.readText());
assert.match(diag, /history\.html/);
assert.match(diag, /사이트 창/);
console.log('✓ 연결 정보 복사');
await app.close();
console.log('모두 통과');

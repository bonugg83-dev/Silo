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
// 시작 모션은 앱이 화면을 보여 준 뒤에 시작하므로, 나타났다가 사라질 때까지 기다림
await panel.waitForFunction(() => document.querySelector('canvas.splash'), null, { timeout: 15000 });
await panel.waitForFunction(() => !document.querySelector('canvas.splash') && !document.body.classList.contains('splashing'), null, { timeout: 15000 });
if (accounts) {
  await panel.waitForFunction(() => document.body.classList.contains('auth-open'));
  if (await panel.isVisible('#toSignup')) await panel.click('#toSignup'); await panel.waitForFunction(() => document.activeElement?.id === 'newName', null, { timeout: 3000 }).catch(() => {}); // 가입 화면은 0.05초 뒤 이름 칸으로 포커스를 옮김: 그 전에 다른 칸을 채우면 글자가 이름 칸으로 감
  await panel.fill('#newName', 'kim'); await panel.fill('#newPw1', 'abcd'); await panel.fill('#newPw1b', 'abcd');
  await panel.fill('#newKey', 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz1234');
  await panel.fill('#newCode', 'TESTCODE');
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
const S = (fn) => app.evaluate(({}, src) => eval(src)(globalThis.__silo), fn.toString());
const bar = await find(/bar\.html/);
// 열린 창 목록 줄의 × 로 모두 닫기
const closeEditors = async () => {
  while (await bar.locator('#strip .tab:not(.home) button[aria-label$="닫기"]').count()) {
    await bar.locator('#strip .tab:not(.home) button[aria-label$="닫기"]').first().click();
    await sleep(300);
  }
  assert.equal((await S((s) => s.popups())).length, 0);
  assert.ok(await bar.evaluate(() => document.getElementById('strip').hidden), '창이 없으면 목록 줄 숨김');
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
  // 따로 뜨는 창이 아니라 앱 안 왼쪽 칸에 겹쳐 보임
  assert.equal(await S((s) => s.windows()), 0, '따로 뜨는 창 없음');
  const [pp] = await S((s) => s.popups());
  const b = await S((s) => s.bounds());
  assert.ok(pp.visible && pp.bounds.width === b.site.width && pp.bounds.x === 0 && pp.bounds.y === b.site.y, JSON.stringify([pp, b]));
  assert.equal(b.panel.width, 420, '패널은 그대로 오른쪽');
  await bar.waitForFunction(() => /편집 화면 연결됨/.test(document.getElementById('link').textContent), null, { timeout: 5000 });
  console.log('✓', label, ': 열리고 패널이 찾음');
  await closeEditors();
}
// 두 창 겹쳐 띄우기, 내리기, 다시 보기, 사이트가 스스로 닫기
let home = await sitePage();
await home.click('#editPopup');
await (await find(/make_book\.html/)).waitForLoadState();
home = await sitePage();
await bar.locator('#strip .tab.home button').click(); // 마이픽 탭으로
await sleep(200);
assert.equal(await S((s) => s.shown()), null);
await home.click('#history');
const hist = await find(/history\.html/);
assert.equal(await hist.textContent('#h'), '작업 기록');
await sleep(300);
let tabs = await bar.locator('#strip .tab .t span').allTextContents();
assert.deepEqual(tabs, ['마이픽', '편집 화면 151쪽', '기록'], tabs.join());
await bar.locator('#strip button[aria-label="기록 내리기"]').click();
await sleep(200);
assert.equal(await S((s) => s.shown()), null, '내리면 마이픽 화면');
await bar.locator('#strip .tab.editor button.t').click();
await sleep(200);
assert.match((await S((s) => s.popups())).find((p) => p.visible).url, /make_book/, '탭을 누르면 그 창');
await hist.evaluate(() => window.close());
await sleep(500);
tabs = await bar.locator('#strip .tab .t span').allTextContents();
assert.deepEqual(tabs, ['마이픽', '편집 화면 151쪽'], '사이트가 window.close() 하면 목록에서 빠짐');
await closeEditors();
console.log('✓ 기록 확인 팝업, 두 창 겹치기, 내리기, 닫기');
if (process.env.SILO_SHOT) {
  home = await sitePage();
  await home.click('#editPopup');
  await (await find(/make_book\.html/)).waitForLoadState();
  await sleep(300);
  await bar.locator('#strip .tab.home button').click();
  await (await sitePage()).click('#history');
  await sleep(300);
  await bar.locator('#strip .tab.editor button.t').click();
  await sleep(600);
  require('node:child_process').execSync(`import -window root ${path.join(process.env.SILO_SHOT, 'desk-tabs.png')}`);
}
await (await sitePage()).click('#history');
await find(/history\.html/);
await bar.click('#diagnostics');
const diag = await app.evaluate(({ clipboard }) => clipboard.readText());
assert.match(diag, /왼쪽 사이트 · .*mypickebook\.org/);
assert.match(diag, /사이트 창 · .*history\.html/);
console.log('✓ 연결 정보 복사');
await app.close();
console.log('모두 통과');

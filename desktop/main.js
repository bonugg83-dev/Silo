// Silo 데스크톱 앱 (Electron)
//
// 창 구성 (시안 A "나란히"):
//   위쪽 막대 ─ 로고, 뒤로/새로고침, 지금 주소, 연습 페이지, 패널 접기
//   왼쪽     ─ 마이픽 사이트 (앱 안 브라우저, 로그인 유지)
//   오른쪽   ─ 확장의 sidepanel.html 그대로 (가운데 막대를 끌어 폭 조절)
//   검수를 열면 패널이 창 전체로 넓어짐 (시안 C)
//
// 앱 코드(../app)는 플랫폼 창구(app/lib/platform.js)로만 플랫폼에 부탁한다. 그 창구는 preload-shim.js 가
// window.siloPlatform 으로 만들고, 실제 일은 이 파일(메인 프로세스)이 한다.
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, protocol, session, net, shell, clipboard, webContents: allWebContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { setupUpdater } = require('./updater');

protocol.registerSchemesAsPrivileged([{
  scheme: 'silo',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

if (process.env.SILO_USER_DATA) app.setPath('userData', process.env.SILO_USER_DATA);
if (!process.env.SILO_MOCK && !app.requestSingleInstanceLock()) app.quit();

// 앱 폴더: 개발 중에는 저장소의 ../app, 빌드한 앱에서는 resources/silo-app
// (resources/app 이라는 이름은 쓰면 안 됨: Electron이 app.asar 대신 그 폴더를 앱으로 읽음)
const EXT_DIR = path.resolve(process.env.SILO_APP
  || (app.isPackaged ? path.join(process.resourcesPath, 'silo-app') : path.join(__dirname, '..', 'app')));
const UI_DIR = path.join(__dirname, 'ui');
const SITE_HOME = 'https://www.mypickebook.org/';
const APP_PARTITION = 'persist:silo'; // 패널, 위쪽 막대, 연습 페이지
const BAR_H = 48;
const STRIP_H = 38; // 사이트 창이 여러 개일 때 그 아래 창 목록 줄
const DIVIDER_W = 6;
const PANEL_MIN = 360;
const PANEL_MAX = 900;

// 사이트에는 평범한 크롬처럼 보이게: UA에서 Electron과 앱 이름만 뺀다
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s(silo-desktop|Silo)\/\S+/gi, '');

// ---------- 파일 저장소 ----------
function jsonFile(name, initial) {
  let file;
  let data = initial;
  let timer = null;
  return {
    load() {
      file = path.join(app.getPath('userData'), name);
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = initial; }
      return data;
    },
    get data() { return data; },
    set data(v) { data = v; },
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => this.flush(), 200);
    },
    flush() {
      clearTimeout(timer);
      if (!file) return;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
  };
}
const extStore = jsonFile('storage.json', {}); // 플랫폼 창구 storage.local
const prefs = jsonFile('desktop.json', { panelWidth: 420, bounds: null });

// ---------- 프로필별 마이픽 로그인 ----------
// 앱의 교정자 프로필 기능이 storage.local 의 "activeProfileId" 에 지금 고른 사람을 적으면,
// 사이트 로그인(쿠키)도 그 사람 것으로 바꾼다. 확장 코드는 읽기만 한다.
function activeProfileId(store) {
  const v = store.activeProfileId;
  return typeof v === 'string' && v ? v : null;
}
const partitionFor = (profileId) => (profileId ? `persist:mypick-${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}` : 'persist:mypick');
let currentProfile = null;

// ---------- 플랫폼 창구: storage.local / storage.session ----------
// local 은 파일(storage.json)에, session 은 메모리에만 (앱을 닫으면 사라짐: 풀린 키는 여기에만 둔다)
let sessionStore = {};
const areaData = (area) => (area === 'session' ? sessionStore : extStore.data);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
ipcMain.handle('storage:get', (_e, area, keys) => {
  const store = areaData(area);
  if (keys == null) return clone(store);
  const out = {};
  if (typeof keys === 'string') keys = [keys];
  if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = store[k]; return clone(out); }
  for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
  return clone(out);
});
function afterStoreChange(area, changes) {
  if (area !== 'session') extStore.save();
  if (Object.keys(changes).length) broadcast('storage:changed', changes, area);
  const p = activeProfileId(extStore.data);
  if (p !== currentProfile) switchProfile(p);
}
ipcMain.handle('storage:set', (_e, area, items) => {
  const store = areaData(area);
  const changes = {};
  for (const [k, v] of Object.entries(items || {})) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
  afterStoreChange(area, changes);
});
ipcMain.handle('storage:remove', (_e, area, keys) => {
  const store = areaData(area);
  const changes = {};
  for (const k of [].concat(keys)) { if (k in store) changes[k] = { oldValue: store[k] }; delete store[k]; }
  afterStoreChange(area, changes);
});
ipcMain.handle('storage:clear', (_e, area) => {
  const store = areaData(area);
  const changes = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { oldValue: v }]));
  if (area === 'session') sessionStore = {}; else extStore.data = {};
  afterStoreChange(area, changes);
});

// ---------- 탭 = 사이트 화면, 사이트가 연 창(편집 화면), 연습 페이지 ----------
const tabs = new Map();      // id -> webContents
const shimmed = new Set();   // 플랫폼 창구를 받는 webContents (패널, 테스트 화면)
let win, barView, siteView, dividerView, panelView;
let shimPrefs;

function windowOf(wc) {
  if (siteView && wc === siteView.webContents) return win;
  if (popups.some((p) => p.wc === wc)) return win;
  return BrowserWindow.fromWebContents(wc);
}
function tabInfo(wc) {
  if (!wc || wc.isDestroyed()) return null;
  const w = windowOf(wc);
  return {
    id: wc.id, url: wc.getURL(), title: wc.getTitle(),
    status: wc.isLoading() ? 'loading' : 'complete',
    active: shownPopup ? wc.id === shownPopup : wc === siteView?.webContents,
    windowId: w ? w.id : -1,
  };
}
function broadcast(channel, ...args) {
  for (const wc of shimmed) if (!wc.isDestroyed()) wc.send(channel, ...args);
}
function siteWindowOptions(partition) {
  return {
    width: 1360, height: 920, autoHideMenuBar: true, backgroundColor: '#ffffff',
    icon: path.join(EXT_DIR, 'icon128.png'),
    webPreferences: { partition, contextIsolation: true, sandbox: true },
  };
}
function registerTab(wc, partition) {
  if (tabs.has(wc.id)) return;
  tabs.set(wc.id, wc);
  const id = wc.id;
  wc.on('did-start-loading', () => broadcast('tabs:updated', id, { status: 'loading' }, tabInfo(wc)));
  wc.on('did-stop-loading', () => {
    broadcast('tabs:updated', id, { status: 'complete', url: wc.getURL() }, tabInfo(wc));
    sendBar();
  });
  wc.on('did-navigate', () => wc === siteView?.webContents && sendBar());
  wc.on('did-navigate-in-page', () => wc === siteView?.webContents && sendBar());
  wc.on('focus', () => broadcast('tabs:activated', { tabId: id, windowId: tabInfo(wc)?.windowId ?? -1 }));
  wc.once('destroyed', () => { tabs.delete(id); shimmed.delete(wc); if (!quitting) setImmediate(sendBar); });
  if (!partition) return; // 연습 페이지 창
  // 사이트가 여는 창(편집하기 → 편집 화면 팝업/새 탭)은 같은 로그인으로 열고 탭으로 등록한다
  // 사이트는 빈 창(about:blank)을 먼저 열고 그 창에 주소를 넣거나 폼을 보내기도 하므로 빈 창도 허용한다.
  // 막는 것은 앱 내부 주소와 파일뿐.
  // 팝업은 따로 뜨는 창이 아니라 앱 안 왼쪽 칸에 겹쳐 띄우고, 위쪽 창 목록 줄에서 내리거나 닫는다.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(silo|file|devtools|chrome|chrome-extension):/i.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      createWindow: (options) => openInAppPopup(options, partition),
    };
  });
  wc.on('did-create-window', (child) => registerTab(child.webContents, partition));
}

// ---------- 앱 안 팝업 창 ----------
const popups = []; // { view, wc, opener }
let shownPopup = null; // 지금 왼쪽 칸에 보이는 팝업의 webContents id (null 이면 마이픽 화면)
function openInAppPopup(options, partition) {
  const view = new WebContentsView({
    webContents: options.webContents,
    webPreferences: { ...(options.webPreferences || {}), partition, contextIsolation: true, sandbox: true },
  });
  view.setBackgroundColor('#ffffff');
  const wc = view.webContents;
  popups.push({ view, wc });
  win.contentView.addChildView(view, win.contentView.children.indexOf(panelView));
  registerTab(wc, partition);
  shownPopup = wc.id;
  const remove = () => {
    const i = popups.findIndex((p) => p.wc === wc);
    if (i < 0) return;
    popups.splice(i, 1);
    try { win.contentView.removeChildView(view); } catch {}
    if (shownPopup === wc.id) shownPopup = popups.at(-1)?.wc.id ?? null;
    if (!quitting) layout();
  };
  wc.once('destroyed', remove);
  // 사이트가 window.close() 로 스스로 닫는 경우도 webContents 가 없어지면서 'destroyed' 로 정리된다
  wc.on('page-title-updated', () => sendBar());
  setImmediate(layout);
  return wc;
}
function closePopup(id) {
  const p = popups.find((x) => x.wc.id === id);
  if (!p) return;
  if (!p.wc.isDestroyed()) p.wc.close({ waitForBeforeUnload: false });
}
function closeAllPopups() {
  for (const p of [...popups]) closePopup(p.wc.id);
}
// 왼쪽 칸에 지금 보이는 사이트 화면 (팝업 또는 마이픽)
function currentWc() {
  return popups.find((p) => p.wc.id === shownPopup && !p.wc.isDestroyed())?.wc || siteView.webContents;
}
function showPopup(id) {
  shownPopup = popups.some((p) => p.wc.id === id) ? id : null;
  layout();
}

ipcMain.handle('tabs:query', (_e, q = {}) => {
  let list = [...tabs.values()].filter((wc) => !wc.isDestroyed());
  if (q.active) list = [popups.find((p) => p.wc.id === shownPopup)?.wc || siteView.webContents];
  const pats = q.url ? [].concat(q.url).map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')) : null;
  return list.map(tabInfo).filter((t) => t && (!pats || pats.some((r) => r.test(t.url))));
});
ipcMain.handle('tabs:get', (_e, id) => {
  const wc = tabs.get(id);
  if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${id}.`);
  return tabInfo(wc);
});
ipcMain.handle('tabs:getCurrent', (e) => (tabs.has(e.sender.id) ? tabInfo(e.sender) : undefined));
function openPracticeWindow(url) {
  const w = new BrowserWindow({ width: 1360, height: 920, autoHideMenuBar: true, title: 'Silo 테스트', backgroundColor: '#0b0b0b',
    icon: path.join(EXT_DIR, 'icon128.png'), webPreferences: shimPrefs });
  registerTab(w.webContents, null);
  w.loadURL(url);
  return w.webContents;
}
ipcMain.handle('tabs:create', (_e, { url }) => {
  // 앱이 새 탭을 여는 경우는 테스트 화면뿐 → 플랫폼 창구를 받는 별도 창
  if (String(url).startsWith('silo:')) return tabInfo(openPracticeWindow(url));
  siteView.webContents.loadURL(url);
  return tabInfo(siteView.webContents);
});
ipcMain.handle('tabs:update', (_e, id, props = {}) => {
  const wc = tabs.get(id);
  if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${id}.`);
  if (props.url) wc.loadURL(props.url);
  if (props.active) { if (popups.some((p) => p.wc === wc)) showPopup(wc.id); else if (wc === siteView.webContents) showPopup(null); else windowOf(wc)?.focus(); }
  return tabInfo(wc);
});
ipcMain.handle('windows:update', (_e, id, props = {}) => {
  const w = BaseWindow.fromId(id);
  if (w && props.focused) { if (w.isMinimized()) w.restore(); w.focus(); }
});

// 플랫폼 창구 scripting.executeScript({ world: 'MAIN', func, args })
// func 는 바깥 변수를 쓰지 않는 독립 함수(lib/page.js 규칙)라 소스 문자열로 넘겨 실행해도 같다
ipcMain.handle('scripting:exec', async (_e, tabId, src, args) => {
  const wc = tabs.get(tabId);
  if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`);
  const result = await wc.executeJavaScript(`(${src}).apply(null, ${JSON.stringify(args || [])})`, true);
  return [{ result, frameId: 0 }];
});

// 플랫폼 창구 runtime.sendMessage / onMessage (패널 ↔ 테스트 화면)
let msgSeq = 0;
const pending = new Map();
ipcMain.handle('runtime:send', (e, msg) => new Promise((resolve) => {
  const targets = [...shimmed].filter((wc) => !wc.isDestroyed() && wc !== e.sender);
  if (!targets.length) return resolve(undefined);
  const id = ++msgSeq;
  let left = targets.length;
  const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, 120000);
  pending.set(id, (r) => {
    if (r !== undefined || --left === 0) { clearTimeout(timer); pending.delete(id); resolve(r); }
  });
  for (const wc of targets) wc.send('runtime:message', id, msg);
}));
ipcMain.on('runtime:response', (_e, id, r) => pending.get(id)?.(r));
// Claude API와 온라인 계정(Firebase) 주소만 앱 본체가 대신 보낸다
const API_HOSTS = /^https:\/\/(api\.anthropic\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firestore\.googleapis\.com|generativelanguage\.googleapis\.com)\//;
// Claude API: 패널 대신 앱 본체가 보낸다 (preload-shim.js 의 fetch 참고)
const apiCalls = new Map();
const netLog = [];
function logNet(line) {
  netLog.push(`${new Date().toLocaleTimeString('sv')} ${line}`);
  if (netLog.length > 30) netLog.shift();
}
ipcMain.handle('api:fetch', async (e, id, url, { method, headers, body }) => {
  if (!shimmed.has(e.sender) || !API_HOSTS.test(url)) return { error: 'blocked' };
  const ctl = new AbortController();
  apiCalls.set(id, ctl);
  try {
    const res = await e.sender.session.fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) logNet(`API ${res.status} ${text.slice(0, 160)}`);
    return { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body: text };
  } catch (err) {
    if (ctl.signal.aborted) return { aborted: true };
    logNet(`API 연결 실패 ${err.message}`);
    return { error: err.message || String(err) };
  } finally {
    apiCalls.delete(id);
  }
});
ipcMain.on('api:abort', (_e, id) => apiCalls.get(id)?.abort());

let splashShown = false;
ipcMain.on('splash:first', (e) => {
  const first = !splashShown && e.sender === panelView?.webContents;
  if (first) splashShown = true;
  e.returnValue = first;
});
// 위쪽 막대 로고 위치 (막대는 창 왼쪽 위 0,0 에 있으므로 창 좌표와 같음): 시작 모션이 끝나는 자리
let barBrand = null;
ipcMain.on('bar:brand', (e, r) => { if (e.sender === barView?.webContents && r && r.height > 0) barBrand = r; });
ipcMain.on('bar:brand-get', (e) => { e.returnValue = barBrand; });
ipcMain.on('shim:hello', (e) => {
  shimmed.add(e.sender);
  e.sender.once('destroyed', () => shimmed.delete(e.sender));
});

// ---------- 배치 ----------
let panelHidden = false;
let quitting = false;
let reviewOpen = false;
let authOpen = false;   // 확장의 로그인/회원가입 화면이 떠 있음 → 로그인 전에는 패널만 창 전체로
let splashOpen = false; // 시작 모션 → 창 전체에서 재생
let dragging = false;
// 켜는 중: 화면(사이트·패널·막대)이 준비되기 전에는 아무것도 보이지 않고 창 바탕(검정)만 보인다.
// 사이트 화면(흰 바탕)이나 아직 안 그려진 화면이 잠깐 하얗게 보이지 않게.
// 창 자체는 숨기지 않는다 (숨기면 늦게 뜨고, 크기가 바뀌어 시작 모션 좌표가 틀어짐).
let booting = true;
let revealWaiters = [];
function endBoot() {
  if (!booting) return;
  booting = false;
  layout();
  if (win && !win.isDestroyed()) win.setOpacity(1); // 이제 창을 보여 줌 (그 전에는 투명)
  // 패널의 시작 모션은 화면이 실제로 보인 뒤에 시작한다 (그때 창 크기를 읽음)
  for (const r of revealWaiters) r(true);
  revealWaiters = [];
}
ipcMain.handle('boot:revealed', () => (booting ? new Promise((r) => revealWaiters.push(r)) : true));

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const views = [barView, siteView, panelView, dividerView];
  if (booting) {
    // 크기는 미리 정해 두되(패널은 창 전체) 보이지는 않게
    for (const v of views) v.setVisible(false);
    for (const p of popups) p.view.setVisible(false);
    barView.setBounds({ x: 0, y: 0, width: w, height: 0 });
    siteView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    dividerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    panelView.setBounds({ x: 0, y: 0, width: w, height: h });
    return;
  }
  for (const v of [barView, panelView, dividerView]) v.setVisible(true);
  // 검수 창은 오른쪽 패널 안에서만 열림 (창 전체로 넓히지 않음)
  const full = authOpen || splashOpen;
  const strip = !full && popups.length ? STRIP_H : 0; // 창 목록 줄
  const top = authOpen || splashOpen ? 0 : BAR_H + strip; // 시작 모션과 로그인 화면에서는 위쪽 막대도 숨김
  const ch = Math.max(0, h - top);
  barView.setBounds({ x: 0, y: 0, width: w, height: top });
  if (full) {
    // 검수, 로그인, 시작 모션: 패널이 창 전체 (로그인 전에는 사이트를 보여 주지 않음)
    siteView.setBounds({ x: 0, y: top, width: 0, height: 0 });
    dividerView.setBounds({ x: 0, y: top, width: 0, height: 0 });
    panelView.setBounds({ x: 0, y: top, width: w, height: ch });
  } else if (panelHidden) {
    siteView.setBounds({ x: 0, y: top, width: w, height: ch });
    dividerView.setBounds({ x: 0, y: top, width: 0, height: 0 });
    panelView.setBounds({ x: w, y: top, width: 0, height: ch });
  } else {
    const pw = Math.max(PANEL_MIN, Math.min(prefs.data.panelWidth, PANEL_MAX, w - 400));
    const sx = w - pw - DIVIDER_W;
    siteView.setBounds({ x: 0, y: top, width: Math.max(0, sx), height: ch });
    panelView.setBounds({ x: w - pw, y: top, width: pw, height: ch });
    dividerView.setBounds(dragging ? { x: 0, y: top, width: w, height: ch } : { x: sx, y: top, width: DIVIDER_W, height: ch });
  }
  // 왼쪽 칸: 보이는 팝업이 있으면 그 창을 마이픽 화면 위에 겹쳐 보여 줌
  if (!full && updatedToast) {
    const t = updatedToast;
    updatedToast = '';
    setTimeout(() => barView.webContents.send('bar:toast', t), 600);
  }
  const shown = !full && popups.find((p) => p.wc.id === shownPopup);
  const sb = siteView.getBounds();
  for (const p of popups) {
    const on = p === shown;
    p.view.setVisible(on);
    p.view.setBounds(on ? sb : { x: 0, y: top, width: 0, height: 0 });
  }
  siteView.setVisible(!shown);
  sendBar();
}
function sendBar() {
  if (!barView || barView.webContents.isDestroyed() || !siteView || siteView.webContents.isDestroyed()) return;
  const wc = currentWc();
  barView.webContents.send('bar:state', {
    url: wc.getURL(), title: wc.getTitle(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(),
    panelHidden, reviewOpen, authOpen, splashOpen, profile: currentProfile,
    editors: editorTabs().map((t) => (t.url.match(/[?&]book_page=(\d+)/) || [])[1] || ''),
    popups: popups.filter((p) => !p.wc.isDestroyed()).map((p) => ({ id: p.wc.id, title: popupTitle(p.wc), shown: p.wc.id === shownPopup })),
    siteTitle: siteView.webContents.getTitle(),
    update: updater?.state || null, version: app.getVersion(),
  });
}
function popupTitle(wc) {
  const u = wc.getURL();
  if (isEditorUrl(u)) { const n = (u.match(/[?&]book_page=(\d+)/) || [])[1]; return n ? `편집 화면 ${n}쪽` : '편집 화면'; }
  const t = wc.getTitle();
  return t && !/^(https?:|about:)/.test(t) ? t : '새 창';
}
const isEditorUrl = (u) => /mypickebook\.org\/making\/make_book\.html/.test(u || '');
function editorTabs() {
  return [...tabs.values()].filter((wc) => !wc.isDestroyed() && !shimmed.has(wc)).map(tabInfo).filter((t) => t && isEditorUrl(t.url));
}

// 연결 정보: 앱이 아는 창·탭과 그 안의 프레임 주소를 클립보드로 (팝업을 못 찾을 때 원인 찾기용)
function diagnostics() {
  const lines = [`Silo 데스크톱 ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform}`,
    `확장 ${EXT_DIR}`, `사이트 로그인 칸 ${partitionFor(currentProfile)}`, ''];
  for (const wc of allWebContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const kind = wc === siteView?.webContents ? '왼쪽 사이트' : wc === panelView?.webContents ? '패널'
      : shimmed.has(wc) ? '앱 화면' : tabs.has(wc.id) ? '사이트 창' : '등록 안 됨';
    lines.push(`[${wc.id}] ${kind} · ${wc.getType()} · ${wc.getURL() || '(빈 주소)'}${isEditorUrl(wc.getURL()) ? '  ← 편집 화면' : ''}`);
    try {
      for (const f of wc.mainFrame.framesInSubtree) if (f !== wc.mainFrame) lines.push(`     프레임 ${f.name || ''} ${f.url}`);
    } catch {}
  }
  lines.push('', '최근 연결 오류:', ...(netLog.length ? netLog : ['(없음)']));
  return lines.join('\n');
}

ipcMain.on('bar:cmd', (_e, cmd, arg) => {
  const wc = currentWc();
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'home') { showPopup(null); siteView.webContents.loadURL(SITE_HOME); }
  if (cmd === 'practice') openPracticeWindow('silo://ext/practice/practice.html?idx=0&book_page=1');
  if (cmd === 'togglePanel') { panelHidden = !panelHidden; layout(); }
  if (cmd === 'showSite') showPopup(null);
  if (cmd === 'showPopup') showPopup(arg);
  if (cmd === 'closePopup') closePopup(arg);
  if (cmd === 'installUpdate') installUpdate();
  if (cmd === 'diagnostics') { clipboard.writeText(diagnostics()); barView.webContents.send('bar:toast', '연결 정보를 복사했어요. 채팅에 붙여 넣어 주세요.'); }
});
ipcMain.on('divider:drag', (_e, phase, x) => {
  if (phase === 'start') { dragging = true; win.contentView.addChildView(dividerView); layout(); return; }
  const [w] = win.getContentSize();
  if (phase === 'move') { prefs.data.panelWidth = Math.round(w - x - DIVIDER_W / 2); layout(); return; }
  if (phase === 'end') { dragging = false; layout(); prefs.save(); }
});
ipcMain.on('layout:mode', (e, mode) => {
  if (e.sender !== panelView.webContents) return;
  reviewOpen = !!mode.review;
  authOpen = !!mode.auth;
  splashOpen = !!mode.splash;
  layout();
});

// 연결 오류를 진단 정보에 남긴다 (광고·통계처럼 막혀도 되는 요청은 빼고)
function watchNetErrors(ses, label) {
  ses.webRequest.onErrorOccurred((d) => {
    if (d.error === 'net::ERR_ABORTED' || d.resourceType === 'image' && !/mypickebook/.test(d.url)) return;
    if (!/mypickebook|anthropic/.test(d.url)) return;
    logNet(`${label} ${d.method} ${d.url.slice(0, 120)} → ${d.error}`);
  });
}

// ---------- 프로필 바꾸기: 사이트 화면을 그 사람의 로그인으로 다시 만든다 ----------
const sitePartitions = new Map(); // session -> partition 이름
function makeSiteView(profileId) {
  const partition = partitionFor(profileId);
  const ses = session.fromPartition(partition);
  if (!sitePartitions.has(ses)) watchNetErrors(ses, '사이트');
  sitePartitions.set(ses, partition);
  const v = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true } });
  v.setBackgroundColor('#ffffff');
  registerTab(v.webContents, partition);
  return v;
}
function switchProfile(profileId) {
  currentProfile = profileId;
  if (!win) return;
  const old = siteView;
  // 앞사람이 연 편집 화면 창은 닫는다 (다른 사람 로그인으로 저장되지 않게)
  closeAllPopups();
  for (const wc of tabs.values()) {
    if (wc.isDestroyed() || wc === old?.webContents || shimmed.has(wc) || popups.some((p) => p.wc === wc)) continue;
    BrowserWindow.fromWebContents(wc)?.close();
  }
  siteView = makeSiteView(profileId);
  win.contentView.addChildView(siteView, 1);
  if (old) { win.contentView.removeChildView(old); old.webContents.close(); }
  layout();
  siteView.webContents.loadURL(process.env.SILO_START_URL || SITE_HOME);
}

function serveExtension(ses) {
  ses.protocol.handle('silo', (req) => {
    // silo://ext/... = 확장 폴더, silo://app/... = 이 앱의 ui 폴더
    const u = new URL(req.url);
    const root = u.host === 'app' ? UI_DIR : EXT_DIR;
    const f = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!f.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(f).toString());
  });
}

// ---------- 자동 업데이트 ----------
let updater = null;
/** 설치 파일로 설치한 앱인지 (zip을 풀어 쓰는 앱은 스스로 업데이트할 수 없음) */
function isInstalled() {
  return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Silo.exe'));
}
/** 교정이 도는 중인지: 패널이 교정하는 동안 20초마다 남기는 표시(runlock:)가 최근 것이면 */
function correcting() {
  return Object.entries(sessionStore).some(([k, v]) => k.startsWith('runlock:') && v && Date.now() - (v.at || 0) < 60000);
}
// 업데이트 뒤 처음 켰을 때: 로그인하고 위쪽 막대가 보이면 한 번 알려 줌
let updatedToast = '';
function checkUpdatedNotice() {
  const v = app.getVersion();
  const last = prefs.data.lastVersion;
  // 0.3.0 이하는 버전을 적어 두지 않았으므로, 기록은 없지만 전에 쓰던 흔적(창 위치)이 있으면 업데이트로 본다
  const usedBefore = last || prefs.data.bounds;
  if (usedBefore && last !== v) updatedToast = `새 버전 ${v}로 업데이트했어요.`;
  if (last !== v) { prefs.data.lastVersion = v; prefs.save(); }
}
function installUpdate() {
  if (!updater) return;
  const r = updater.install();
  if (r.ok) return;
  const why = r.reason === 'busy' ? '교정이 끝난 뒤에 눌러 주세요. 앱을 닫을 때도 자동으로 설치돼요.' : '아직 새 버전을 받는 중이에요.';
  barView.webContents.send('bar:toast', why);
}

app.whenReady().then(() => {
  extStore.load();
  prefs.load();
  currentProfile = activeProfileId(extStore.data);
  const appSes = session.fromPartition(APP_PARTITION);
  serveExtension(appSes);
  watchNetErrors(appSes, '앱');
  if (process.env.SILO_MOCK) {
    // 테스트 전용: 가짜 사이트·가짜 API, 배치 확인용 정보
    require(path.resolve(process.env.SILO_MOCK))({ appSes });
    globalThis.__silo = {
      bounds: () => ({ site: siteView.getBounds(), panel: panelView.getBounds(), divider: dividerView.getBounds(), win: win.getContentSize() }),
      partition: () => partitionFor(currentProfile),
      siteId: () => siteView.webContents.id,
      popups: () => popups.map((p) => ({ id: p.wc.id, url: p.wc.getURL(), bounds: p.view.getBounds(), visible: p.wc.id === shownPopup })),
      shown: () => shownPopup,
      windows: () => BrowserWindow.getAllWindows().length,
      update: () => updater?.state || null,
    };
  }

  const b = prefs.data.bounds;
  win = new BaseWindow({
    width: b?.width || 1500, height: b?.height || 960, x: b?.x, y: b?.y,
    minWidth: 900, minHeight: 600, title: 'Silo', backgroundColor: '#000000', autoHideMenuBar: true,
    icon: path.join(EXT_DIR, 'icon128.png'), show: false,
  });
  // 윈도는 새 창을 처음 그릴 때 하얗게 칠하고, 원래 크기로 띄운 뒤 최대화하면 그 크기의 흰 사각형이 잠깐 보인다.
  // 그래서 창을 완전히 투명하게 둔 채 처음부터 최대화(또는 그냥) 상태로 띄우고, 패널이 준비되면(endBoot) 보이게 한다.
  // 창은 실제로 떠 있으므로 크기는 처음부터 맞다 (시작 모션은 endBoot 뒤에 크기를 읽음).
  win.setOpacity(0);
  if (prefs.data.maximized) win.maximize(); // 숨은 창은 최대화하면서 바로 뜬다
  else win.show();
  shimPrefs = { partition: APP_PARTITION, preload: path.join(__dirname, 'preload-shim.js'), contextIsolation: false, sandbox: true };
  const uiPrefs = { partition: APP_PARTITION, preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true };

  barView = new WebContentsView({ webPreferences: uiPrefs });
  barView.setBackgroundColor('#0b0b0b');
  siteView = makeSiteView(currentProfile);
  dividerView = new WebContentsView({ webPreferences: uiPrefs });
  dividerView.setBackgroundColor('#00000000');
  panelView = new WebContentsView({ webPreferences: shimPrefs });
  panelView.setBackgroundColor('#000000'); // 패널 글이 그려지기 전 첫 화면도 검정
  for (const v of [barView, siteView, panelView, dividerView]) win.contentView.addChildView(v);
  layout();
  win.on('resize', layout);
  const remember = () => {
    prefs.data.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) prefs.data.bounds = win.getBounds();
    prefs.save();
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('close', () => { quitting = true; remember(); prefs.flush(); extStore.flush(); });
  win.on('closed', () => app.quit());

  // 패널은 확장 페이지만 보여 준다
  panelView.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('silo:')) { e.preventDefault(); shell.openExternal(url); } });
  panelView.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  barView.webContents.loadURL('silo://app/bar.html');
  dividerView.webContents.loadURL('silo://app/divider.html');
  checkUpdatedNotice();
  // 자동 업데이트: 윈도 설치판에서만 (개발 중·맥·zip판에서는 끔). 테스트는 가짜 업데이터
  const fakeUpdater = process.env.SILO_FAKE_UPDATE ? require(path.resolve(process.env.SILO_FAKE_UPDATE)) : null;
  if (fakeUpdater || (app.isPackaged && process.platform === 'win32' && isInstalled())) {
    updater = setupUpdater({ isBusy: correcting, onState: sendBar, log: logNet, updater: fakeUpdater, firstCheckMs: fakeUpdater ? 500 : undefined });
  }

  // 패널 화면이 다 읽히면(시작 모션은 화면이 보이기를 기다리는 중) 화면을 보여 준다. 늦어도 4초 뒤에는 보여 줌
  panelView.webContents.once('dom-ready', endBoot);
  setTimeout(endBoot, 4000);
  panelView.webContents.loadURL('silo://ext/sidepanel.html');
  siteView.webContents.loadURL(process.env.SILO_START_URL || SITE_HOME);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => {
  quitting = true; prefs.flush(); extStore.flush(); });
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (/^(mailto|tel):/.test(url)) { ev.preventDefault(); shell.openExternal(url); } });
  // F12: 사이트 창의 개발자 도구 (문제 찾기용)
  wc.on('before-input-event', (ev, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !shimmed.has(wc)) { wc.toggleDevTools(); ev.preventDefault(); }
  });
  // 사이트 로그인 칸에서 만들어진 창은 어떤 경로로 열렸든 탭으로 등록 (did-create-window 를 놓쳐도)
  setImmediate(() => {
    if (wc.isDestroyed() || tabs.has(wc.id) || wc.getType() !== 'window') return;
    const part = sitePartitions.get(wc.session);
    if (part) registerTab(wc, part);
  });
});

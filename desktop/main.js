// Silo 데스크톱 앱 (Electron)
//
// 창 구성 (시안 A "나란히"):
//   위쪽 막대 ─ 로고, 뒤로/새로고침, 지금 주소, 연습 페이지, 패널 접기
//   왼쪽     ─ 마이픽 사이트 (앱 안 브라우저, 로그인 유지)
//   오른쪽   ─ 확장의 sidepanel.html 그대로 (가운데 막대를 끌어 폭 조절)
//   검수를 열면 패널이 창 전체로 넓어짐 (시안 C)
//
// 확장 코드는 고치지 않는다. 확장이 쓰는 chrome.* 기능은 preload-shim.js 가 같은 이름으로
// 흉내 내고, 실제 일은 이 파일(메인 프로세스)이 한다.
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, protocol, session, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([{
  scheme: 'silo',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

if (process.env.SILO_USER_DATA) app.setPath('userData', process.env.SILO_USER_DATA);
if (!process.env.SILO_MOCK && !app.requestSingleInstanceLock()) app.quit();

// 확장 폴더: 개발 중에는 저장소의 ../extension, 빌드한 앱에서는 resources/extension
const EXT_DIR = path.resolve(process.env.SILO_EXT
  || (app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension')));
const UI_DIR = path.join(__dirname, 'ui');
const SITE_HOME = 'https://www.mypickebook.org/';
const APP_PARTITION = 'persist:silo'; // 패널, 위쪽 막대, 연습 페이지
const BAR_H = 48;
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
const extStore = jsonFile('storage.json', {}); // chrome.storage.local 대신
const prefs = jsonFile('desktop.json', { panelWidth: 420, bounds: null });

// ---------- 프로필별 마이픽 로그인 ----------
// 확장의 교정자 프로필 기능(A안)이 chrome.storage.local 의 "activeProfileId" 에 지금 고른 사람을 적으면,
// 사이트 로그인(쿠키)도 그 사람 것으로 바꾼다. 확장 코드는 읽기만 한다.
function activeProfileId(store) {
  const v = store.activeProfileId;
  return typeof v === 'string' && v ? v : null;
}
const partitionFor = (profileId) => (profileId ? `persist:mypick-${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}` : 'persist:mypick');
let currentProfile = null;

// ---------- chrome.storage.local / chrome.storage.session ----------
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
const shimmed = new Set();   // chrome.* 흉내를 받는 webContents (패널, 연습 페이지)
let win, barView, siteView, dividerView, panelView;
let shimPrefs;

function windowOf(wc) {
  return BrowserWindow.fromWebContents(wc) || (siteView && wc === siteView.webContents ? win : null);
}
function tabInfo(wc) {
  if (!wc || wc.isDestroyed()) return null;
  const w = windowOf(wc);
  return {
    id: wc.id, url: wc.getURL(), title: wc.getTitle(),
    status: wc.isLoading() ? 'loading' : 'complete',
    active: wc === siteView?.webContents || (w !== win && !!w?.isFocused()),
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
    if (wc === siteView?.webContents) sendBar();
  });
  wc.on('did-navigate', () => wc === siteView?.webContents && sendBar());
  wc.on('did-navigate-in-page', () => wc === siteView?.webContents && sendBar());
  wc.on('focus', () => broadcast('tabs:activated', { tabId: id, windowId: tabInfo(wc)?.windowId ?? -1 }));
  wc.once('destroyed', () => { tabs.delete(id); shimmed.delete(wc); });
  if (!partition) return; // 연습 페이지 창
  // 사이트가 여는 창(편집하기 → 편집 화면 팝업/새 탭)은 같은 로그인으로 열고 탭으로 등록한다
  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/.test(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: siteWindowOptions(partition) };
  });
  wc.on('did-create-window', (child) => registerTab(child.webContents, partition));
}

ipcMain.handle('tabs:query', (_e, q = {}) => {
  let list = [...tabs.values()].filter((wc) => !wc.isDestroyed());
  if (q.active) list = [siteView.webContents];
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
  const w = new BrowserWindow({ width: 1360, height: 920, autoHideMenuBar: true, title: 'Silo 연습', backgroundColor: '#0b0b0b',
    icon: path.join(EXT_DIR, 'icon128.png'), webPreferences: shimPrefs });
  registerTab(w.webContents, null);
  w.loadURL(url);
  return w.webContents;
}
ipcMain.handle('tabs:create', (_e, { url }) => {
  // 확장이 새 탭을 여는 경우는 연습 페이지뿐 → chrome.* 흉내를 받는 별도 창
  if (String(url).startsWith('silo:')) return tabInfo(openPracticeWindow(url));
  siteView.webContents.loadURL(url);
  return tabInfo(siteView.webContents);
});
ipcMain.handle('tabs:update', (_e, id, props = {}) => {
  const wc = tabs.get(id);
  if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${id}.`);
  if (props.url) wc.loadURL(props.url);
  if (props.active) windowOf(wc)?.focus();
  return tabInfo(wc);
});
ipcMain.handle('windows:update', (_e, id, props = {}) => {
  const w = BaseWindow.fromId(id);
  if (w && props.focused) { if (w.isMinimized()) w.restore(); w.focus(); }
});

// chrome.scripting.executeScript({ world: 'MAIN', func, args })
// func 는 바깥 변수를 쓰지 않는 독립 함수(lib/page.js 규칙)라 소스 문자열로 넘겨 실행해도 같다
ipcMain.handle('scripting:exec', async (_e, tabId, src, args) => {
  const wc = tabs.get(tabId);
  if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`);
  const result = await wc.executeJavaScript(`(${src}).apply(null, ${JSON.stringify(args || [])})`, true);
  return [{ result, frameId: 0 }];
});

// chrome.runtime.sendMessage / onMessage (패널 ↔ 연습 페이지)
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
ipcMain.on('shim:hello', (e) => {
  shimmed.add(e.sender);
  e.sender.once('destroyed', () => shimmed.delete(e.sender));
});

// ---------- 배치 ----------
let panelHidden = false;
let reviewOpen = false;
let authOpen = false;   // 확장의 로그인/회원가입 화면이 떠 있음 → 로그인 전에는 패널만 창 전체로
let splashOpen = false; // 시작 모션 → 창 전체에서 재생
let dragging = false;

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const full = reviewOpen || authOpen || splashOpen;
  const top = authOpen || splashOpen ? 0 : BAR_H; // 시작 모션과 로그인 화면에서는 위쪽 막대도 숨김
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
  sendBar();
}
function sendBar() {
  if (!barView || barView.webContents.isDestroyed() || !siteView) return;
  const wc = siteView.webContents;
  barView.webContents.send('bar:state', {
    url: wc.getURL(), title: wc.getTitle(),
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(),
    panelHidden, reviewOpen, authOpen, splashOpen, profile: currentProfile,
  });
}

ipcMain.on('bar:cmd', (_e, cmd) => {
  const wc = siteView.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'home') wc.loadURL(SITE_HOME);
  if (cmd === 'practice') openPracticeWindow('silo://ext/practice/practice.html?idx=0&book_page=1');
  if (cmd === 'togglePanel') { panelHidden = !panelHidden; layout(); }
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

// ---------- 프로필 바꾸기: 사이트 화면을 그 사람의 로그인으로 다시 만든다 ----------
function makeSiteView(profileId) {
  const partition = partitionFor(profileId);
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
  for (const wc of tabs.values()) {
    if (wc !== old?.webContents && !shimmed.has(wc)) BrowserWindow.fromWebContents(wc)?.close();
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

app.whenReady().then(() => {
  extStore.load();
  prefs.load();
  currentProfile = activeProfileId(extStore.data);
  const appSes = session.fromPartition(APP_PARTITION);
  serveExtension(appSes);
  if (process.env.SILO_MOCK) {
    // 테스트 전용: 가짜 사이트·가짜 API, 배치 확인용 정보
    require(path.resolve(process.env.SILO_MOCK))({ appSes });
    globalThis.__silo = {
      bounds: () => ({ site: siteView.getBounds(), panel: panelView.getBounds(), divider: dividerView.getBounds(), win: win.getContentSize() }),
      partition: () => partitionFor(currentProfile),
      siteId: () => siteView.webContents.id,
    };
  }

  const b = prefs.data.bounds;
  win = new BaseWindow({
    width: b?.width || 1500, height: b?.height || 960, x: b?.x, y: b?.y,
    minWidth: 900, minHeight: 600, title: 'Silo', backgroundColor: '#0b0b0b', autoHideMenuBar: true,
    icon: path.join(EXT_DIR, 'icon128.png'),
  });
  if (prefs.data.maximized) win.maximize();
  shimPrefs = { partition: APP_PARTITION, preload: path.join(__dirname, 'preload-shim.js'), contextIsolation: false, sandbox: true };
  const uiPrefs = { partition: APP_PARTITION, preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true };

  barView = new WebContentsView({ webPreferences: uiPrefs });
  barView.setBackgroundColor('#0b0b0b');
  siteView = makeSiteView(currentProfile);
  dividerView = new WebContentsView({ webPreferences: uiPrefs });
  dividerView.setBackgroundColor('#00000000');
  panelView = new WebContentsView({ webPreferences: shimPrefs });
  panelView.setBackgroundColor('#121212');
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
  win.on('close', () => { remember(); prefs.flush(); extStore.flush(); });
  win.on('closed', () => app.quit());

  // 패널은 확장 페이지만 보여 준다
  panelView.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('silo:')) { e.preventDefault(); shell.openExternal(url); } });
  panelView.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  barView.webContents.loadURL('silo://app/bar.html');
  dividerView.webContents.loadURL('silo://app/divider.html');
  panelView.webContents.loadURL('silo://ext/sidepanel.html');
  siteView.webContents.loadURL(process.env.SILO_START_URL || SITE_HOME);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { prefs.flush(); extStore.flush(); });
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (/^(mailto|tel):/.test(url)) { ev.preventDefault(); shell.openExternal(url); } });
});

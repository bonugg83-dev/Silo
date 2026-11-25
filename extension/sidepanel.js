import { applyRules } from './lib/rules.js';
import { diffWords, disagreements } from './lib/diff.js';
import {
  buildWriteMessage, buildVerifyMessage, buildTocMessage, TOC_SYSTEM_PROMPT, TOC_SCHEMA, VERIFY_SCHEMA,
} from './lib/prompt.js';
import { callClaude, estimateCostUsd, MODELS } from './lib/claude.js';
import {
  pageRead, pageFetchImage, pageFetchToc, pageFetchOriginal, pageUploadCrop, pageApply, pageSave,
} from './lib/page.js';
import { editorHtmlToText, downscaleImage } from './lib/convert.js';
import { applyFixes } from './lib/fixes.js';
import {
  parseVisualBlocks, buildEditorData, existingFigureSrcs, cropImage, IMAGE_KINDS,
} from './lib/visuals.js';

const $ = (id) => document.getElementById(id);
const TOC_VERSION = 2;

const DEFAULT_SETTINGS = {
  keys: [], // [{id, name, key}]
  activeKeyId: '',
  model: 'claude-opus-5-5',
  effort: 'high',
  verify: true,
  useToc: true,
  imageMax: 2000,
  dashSpacing: 'attach',
  unitSymbols: true,
  autoVisuals: true,
  stopOnVisuals: true,
  stopOnSpecial: true,
  stopOnPageGuess: true,
  stopOnWarnings: false,
  timeWarnMin: 20,
  showCost: true,
};

let settings = { ...DEFAULT_SETTINGS };
let current = null;
let autoRunning = false;
let abort = null;
let sessionCost = 0;
let editing = false;

// ---------- 설정 ----------
async function loadSettings() {
  const s = await chrome.storage.local.get('settings');
  const raw = s.settings || {};
  settings = { ...DEFAULT_SETTINGS, ...raw };
  // 예전 버전: 키 하나(apiKey) → 이름 붙은 키 목록
  if (raw.apiKey && !(raw.keys && raw.keys.length)) {
    const id = crypto.randomUUID();
    settings.keys = [{ id, name: '내 키', key: raw.apiKey }];
    settings.activeKeyId = id;
  }
  delete settings.apiKey;
  if (!settings.keys.find((k) => k.id === settings.activeKeyId)) settings.activeKeyId = settings.keys[0]?.id || '';
  await chrome.storage.local.set({ settings });
}
async function persist() {
  await chrome.storage.local.set({ settings });
}
function activeKey() {
  return settings.keys.find((k) => k.id === settings.activeKeyId)?.key || '';
}
const maskKey = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');

function renderKeys() {
  const box = $('keyList');
  box.innerHTML = '';
  if (!settings.keys.length) {
    box.innerHTML = '<p class="small muted">저장된 키가 없어요. 아래에서 추가하세요.</p>';
  }
  for (const k of settings.keys) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeKey';
    radio.checked = k.id === settings.activeKeyId;
    radio.title = '이 키 사용';
    radio.addEventListener('change', async () => { settings.activeKeyId = k.id; await persist(); msg('settingsMsg', `“${k.name}”을 사용해요.`); });
    const name = document.createElement('input');
    name.type = 'text';
    name.value = k.name;
    name.title = '이름을 바꾸려면 고치고 다른 곳을 누르세요';
    name.addEventListener('change', async () => { k.name = name.value.trim() || '이름 없음'; await persist(); msg('settingsMsg', '이름을 바꿨어요.'); });
    const code = document.createElement('code');
    code.textContent = maskKey(k.key);
    const del = document.createElement('button');
    del.className = 'small-btn';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm(`“${k.name}” 키를 삭제할까요?`)) return;
      settings.keys = settings.keys.filter((x) => x.id !== k.id);
      if (settings.activeKeyId === k.id) settings.activeKeyId = settings.keys[0]?.id || '';
      await persist();
      renderKeys();
      msg('settingsMsg', '키를 삭제했어요.');
    });
    row.append(radio, name, code, del);
    box.appendChild(row);
  }
}

async function addKey() {
  const name = $('newKeyName').value.trim() || `키 ${settings.keys.length + 1}`;
  const key = $('newKeyValue').value.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) { msg('settingsMsg', 'API 키 형식이 아니에요. sk-ant- 로 시작하는 키를 붙여 넣어 주세요.'); return; }
  const id = crypto.randomUUID();
  settings.keys.push({ id, name, key });
  settings.activeKeyId = id;
  await persist();
  $('newKeyName').value = '';
  $('newKeyValue').value = '';
  renderKeys();
  msg('settingsMsg', `“${name}”을 저장하고 사용 키로 골랐어요.`);
}

const ADV_FIELDS = {
  effort: 'value', verify: 'checked', useToc: 'checked', imageMax: 'value', dashSpacing: 'value', unitSymbols: 'checked',
  autoVisuals: 'checked', stopOnVisuals: 'checked', stopOnSpecial: 'checked', stopOnPageGuess: 'checked',
  stopOnWarnings: 'checked', timeWarnMin: 'value', showCost: 'checked',
};
function fillForms() {
  const sel = $('model');
  sel.innerHTML = '';
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  sel.value = settings.model;
  for (const [id, prop] of Object.entries(ADV_FIELDS)) $(id)[prop] = settings[id];
  renderKeys();
}
async function saveAdvanced() {
  for (const [id, prop] of Object.entries(ADV_FIELDS)) {
    let v = $(id)[prop];
    if (id === 'imageMax' || id === 'timeWarnMin') v = Number(v) || 0;
    settings[id] = v;
  }
  await persist();
  msg('advancedMsg', '저장했어요.');
}
function msg(id, text) {
  $(id).textContent = text;
  clearTimeout(msg[id]);
  msg[id] = setTimeout(() => { $(id).textContent = ''; }, 3000);
}

// ---------- 공통 ----------
function setProgress(text) {
  $('progress').classList.toggle('hidden', !text);
  $('progress').textContent = text || '';
}
function setError(text) {
  $('error').classList.toggle('hidden', !text);
  $('error').textContent = text || '';
}
function setBusy(busy) {
  for (const id of ['btnAnalyze', 'btnApply', 'btnApplySave', 'btnApplyNext']) $(id).disabled = busy;
  $('btnAuto').disabled = busy && !autoRunning;
}

async function getEditorTab() {
  const isEditor = (t) => /mypickebook\.org\/making\/make_book\.html/.test(t?.url || '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isEditor(tab)) return tab;
  const all = (await chrome.tabs.query({})).filter(isEditor);
  if (all.length === 1) return all[0];
  throw new Error(all.length > 1
    ? '편집 화면이 여러 개 열려 있어요. 작업할 편집 화면 탭을 선택한 상태에서 눌러 주세요.'
    : '마이픽 편집 화면(make_book.html)을 열고 눌러 주세요.');
}
async function runInPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return r?.result;
}
function fmtTime(sec) {
  if (sec == null) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

// ---------- 책별 기록 ----------
async function getBook(bookIdx) {
  const key = `book:${bookIdx}`;
  const s = await chrome.storage.local.get(key);
  const book = s[key] || { pages: {}, toc: null };
  // 첫 버전이 저장한 엉뚱한 목차(단계 표시 없음)는 버린다
  if (book.toc && (book.tocVersion !== TOC_VERSION || !/@@/.test(book.toc))) {
    book.toc = null;
    book.tocNotes = '';
  }
  return book;
}
async function putBook(bookIdx, book) {
  await chrome.storage.local.set({ [`book:${bookIdx}`]: book });
}
function headingsSoFar(book, currPage) {
  const lines = [];
  for (const p of Object.keys(book.pages).map(Number).filter((p) => p < currPage).sort((a, b) => a - b)) {
    for (const line of book.pages[p].text.split('\n')) {
      if (/^@@(\[|\{|\(|H4\(|H5\()/.test(line)) lines.push(`${p}쪽: ${line}`);
    }
  }
  return lines.slice(-30).join('\n');
}

// ---------- 화면 상태 ----------
async function refreshStatus() {
  try {
    const tab = await getEditorTab();
    const info = await runInPage(tab.id, pageRead);
    const range = isNaN(info.minPage) ? '' : ` (배정 ${info.minPage}~${info.maxPage}쪽)`;
    $('pageStatus').textContent = `작업 쪽 ${info.currPage}${range} · 쪽 번호 칸 ${info.nonePage ? '없음' : (info.pageField || '비어 있음')} · 남은 시간 ${info.timeText || '?'}`;
    $('pageStatus').classList.remove('muted');
    const low = info.remainingSec != null && settings.timeWarnMin > 0 && info.remainingSec < settings.timeWarnMin * 60;
    $('timeWarn').classList.toggle('hidden', !low);
    if (low) $('timeWarn').textContent = `남은 시간이 ${fmtTime(info.remainingSec)}이에요. 시간 안에 모든 쪽을 저장하고 직접 “제출하기”를 눌러야 봉사가 인정돼요.`;
    const book = await getBook(info.bookIdx);
    showTocState(book);
    return { tab, info };
  } catch (e) {
    $('pageStatus').textContent = e.message;
    $('pageStatus').classList.add('muted');
    return null;
  }
}

function showTocState(book) {
  const failed = settings.useToc && !book.toc && book.tocError;
  $('tocAlert').classList.toggle('hidden', !failed);
  if (failed) $('tocAlertText').textContent = `목차를 읽지 못했어요(${book.tocError}). 지금은 목차 없이 제목 단계를 판단해요.`;
  $('tocStatus').textContent = book.toc ? '' : (book.tocError ? `목차 읽기 실패: ${book.tocError}` : '');
  if (!$('tocText').matches(':focus')) $('tocText').value = book.toc || '';
  $('tocNotes').textContent = book.tocNotes || '';
}

// ---------- 목차 ----------
async function ensureToc(tab, info, book, signal) {
  if (!settings.useToc || book.toc || book.tocError) return; // 실패했으면 “다시 읽기” 전까지 다시 시도하지 않음
  setProgress('목차 이미지를 가져오는 중… (책마다 처음 한 번)');
  try {
    const toc = await runInPage(tab.id, pageFetchToc, [info.bookIdx]);
    if (!toc?.ok) throw new Error(toc?.error || '목차 페이지를 열지 못함');
    if (!toc.images?.length) throw new Error('목차 이미지가 없음');
    setProgress(`Claude가 목차 ${toc.images.length}쪽을 읽고 단계를 정리하는 중…`);
    const imgs = [];
    for (const u of toc.images) imgs.push((await downscaleImage(u, 1800)).dataUrl);
    const rt = await callClaude({
      apiKey: activeKey(), model: settings.model, effort: settings.effort,
      images: imgs, userText: buildTocMessage(info.bookInfo, toc.text), signal,
      system: TOC_SYSTEM_PROMPT, schema: TOC_SCHEMA,
    });
    sessionCost += estimateCostUsd(settings.model, rt.usage);
    if (!/@@/.test(rt.result.toc || '')) throw new Error('정리 결과에 단계 표시가 없음');
    book.toc = rt.result.toc.trim();
    book.tocNotes = rt.result.notes || '';
    book.tocVersion = TOC_VERSION;
    book.tocError = '';
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    book.tocError = e.message || String(e);
  }
  await putBook(info.bookIdx, book);
  showTocState(book);
}

// ---------- 교정 ----------
async function analyze() {
  setError('');
  const tab = await getEditorTab();
  if (!activeKey()) throw new Error('API 키가 없어요. 설정 탭에서 Claude API 키를 추가해 주세요.');
  abort = new AbortController();
  editing = false;

  setProgress('편집 화면을 읽는 중…');
  const info = await runInPage(tab.id, pageRead);
  if (!info.editorFound) throw new Error('편집기를 찾지 못했어요. 페이지가 다 열렸는지 확인해 주세요.');
  if (!info.imgSrc) throw new Error('원본 이미지(#book_img)를 찾지 못했어요.');
  const ocrText = editorHtmlToText(info.ocrHtml);

  setProgress('원본 이미지를 가져오는 중…');
  const img = await runInPage(tab.id, pageFetchImage, [info.imgSrc]);
  if (!img?.ok) throw new Error('원본 이미지를 가져오지 못했어요: ' + (img?.error || ''));
  const sent = await downscaleImage(img.dataUrl, settings.imageMax);

  const book = await getBook(info.bookIdx);
  await ensureToc(tab, info, book, abort.signal);

  const prev = book.pages[info.currPage - 1];
  const ctx = {
    bookInfo: info.bookInfo,
    tip: info.tipText + (info.tipImages?.length ? '\n(제작 Tip에 이미지가 있어요. 이미지 내용은 볼 수 없으니 관련 판단이 필요하면 flags에 적으세요.)' : ''),
    toc: settings.useToc ? book.toc : '',
    headingsSoFar: headingsSoFar(book, info.currPage),
    prevTail: prev ? prev.text.slice(-600) : '',
    currPage: info.currPage,
    pageField: info.nonePage ? '페이지번호 없음' : info.pageField,
    pageTotal: isNaN(info.minPage) ? '' : `${info.minPage}~${info.maxPage}쪽`,
    ocrText,
    dashSpacing: settings.dashSpacing,
    imageWidth: sent.width,
    imageHeight: sent.height,
  };
  const call = (extra) => callClaude({
    apiKey: activeKey(), model: settings.model, effort: settings.effort,
    imageDataUrl: sent.dataUrl, signal: abort.signal, ...extra,
  });

  let cost = 0;
  setProgress('Claude가 원본을 보고 작성하는 중… (30초~2분)');
  const r1 = await call({ userText: buildWriteMessage(ctx) });
  cost += estimateCostUsd(settings.model, r1.usage);
  const result = r1.result;
  const ruleOpts = { dashSpacing: settings.dashSpacing, unitSymbols: settings.unitSymbols, allowBlankLines: !!result.has_poem_or_quote };
  let checked = applyRules(result.text, ruleOpts);
  const extraFlags = [];
  let verifyNote = '';

  if (settings.verify) {
    const diffs = disagreements(ocrText, checked.text);
    if (diffs.length) {
      setProgress(`OCR과 다른 ${diffs.length}곳을 원본으로 다시 확인하는 중…`);
      const r2 = await call({ userText: buildVerifyMessage(ctx, checked.text, diffs), schema: VERIFY_SCHEMA });
      cost += estimateCostUsd(settings.model, r2.usage);
      const fx = applyFixes(checked.text, r2.result.fixes);
      for (const f of fx.failed) {
        extraFlags.push({ kind: 'uncertain_text', needs_review: true, quote: f.fix.find,
          message: `2차 검증 수정을 적용하지 못했어요(${f.why}): “${f.fix.find}” → “${f.fix.replace}” (${f.fix.reason})` });
      }
      for (const f of r2.result.flags || []) extraFlags.push(f);
      verifyNote = fx.applied.length
        ? `2차 검증에서 ${fx.applied.length}곳 고침:\n${fx.applied.map((f) => `· ${f.find} → ${f.replace} (${f.reason})`).join('\n')}`
        : '2차 검증: 고칠 곳 없음';
      checked = applyRules(fx.text, ruleOpts);
    } else {
      verifyNote = '2차 검증: OCR과 다른 곳이 없어 건너뜀';
    }
  }
  sessionCost += cost;

  // 시각자료
  const visuals = await prepareVisuals(tab, info, checked.text, result.visuals || [], sent);

  current = {
    tabId: tab.id, info, ocrText, result, cost, sentImage: sent,
    text: checked.text, ruleChanges: checked.changes, ruleWarnings: checked.warnings,
    flags: [...(result.flags || []), ...extraFlags], notes: [result.notes, verifyNote].filter(Boolean).join('\n'),
    visuals, book,
  };
  current.page = decidePageNumber(info, result, book);
  render();
  setProgress('');
  return current;
}

async function prepareVisuals(tab, info, text, aiVisuals, sent) {
  const blocks = parseVisualBlocks(text);
  if (!blocks.length) return [];
  const existing = existingFigureSrcs(info.ocrHtml);
  let original = null;
  const list = [];
  for (let i = 0; i < blocks.length; i++) {
    const v = aiVisuals[i];
    const item = { kind: blocks[i].kind, include: settings.autoVisuals, crop: null, src: existing[i] || '', reused: !!existing[i], box: null, error: '' };
    if (v?.box && sent.width) {
      item.box = {
        x: clamp01(v.box.x / sent.width), y: clamp01(v.box.y / sent.height),
        w: clamp01(v.box.width / sent.width), h: clamp01(v.box.height / sent.height),
      };
    }
    list.push(item);
  }
  if (!settings.autoVisuals) return list;
  setProgress('시각자료를 자르는 중…');
  try {
    const o = await runInPage(tab.id, pageFetchOriginal, [info.bookIdx, info.currPage]);
    original = o?.ok ? o.dataUrl : sent.dataUrl;
  } catch {
    original = sent.dataUrl;
  }
  for (const item of list) {
    item.original = original;
    if (item.reused) continue;
    if (!item.box) { item.error = '영역 정보가 없어요. “영역 고치기”로 지정하세요.'; continue; }
    try {
      item.crop = await cropImage(original, item.box);
    } catch (e) {
      item.error = e.message;
    }
  }
  return list;
}
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function decidePageNumber(info, result, book) {
  const printed = String(result.page_number || '').trim();
  const prevNum = Number(book.pages[info.currPage - 1]?.pageNumber);
  if (printed && /^\d{1,4}$/.test(printed)) {
    const note = info.pageField && info.pageField !== printed ? `쪽 번호 칸은 ${info.pageField}이었는데 원본에는 ${printed}로 인쇄돼 있어요.` : '';
    return { value: printed, none: false, note, guessed: !!note };
  }
  if (printed) return { value: info.pageField || '', none: false, note: `원본 쪽 번호가 “${printed}”(숫자가 아님)이에요. 직접 넣어 주세요.`, guessed: true };
  // 인쇄된 번호가 없으면 앞쪽 번호로 추정 (페이지번호 없음은 체크하지 않음)
  const guess = Number.isFinite(prevNum) && prevNum > 0 ? String(prevNum + 1) : (info.pageField || String(info.currPage));
  return { value: guess, none: false, note: `원본에 쪽 번호가 없어 ${guess}로 추정했어요. 앞뒤 쪽과 맞는지 확인해 주세요.`, guessed: true };
}

// ---------- 화면 그리기 ----------
const KIND_LABEL = { visual: '[시각자료]', footnote: '[주석]', heading: '[제목 단계]', uncertain_text: '[불확실한 글자]', layout: '[배치]', other: '[기타]' };
const PAGE_KIND = { chapter_cover: '장 표지', visual_only: '사진·그림만 있는 쪽', blank: '빈 면', toc: '차례', endnotes: '미주 설명', index_ad: '색인·광고' };

function allIssues() {
  const items = [];
  const c = current;
  if (c.page.note) items.push({ cls: 'review', text: `[쪽 번호] ${c.page.note}`, quote: '' });
  if (PAGE_KIND[c.result.page_kind]) {
    items.push({ cls: 'review', text: `[특수한 쪽] ${PAGE_KIND[c.result.page_kind]}이에요. 처음에는 확인 후 넣어 주세요.`, quote: '' });
  }
  for (const f of c.flags) items.push({ cls: f.needs_review ? 'review' : 'warn', text: `${KIND_LABEL[f.kind] || '[확인]'} ${f.message}`, quote: f.quote || '' });
  for (const w of c.ruleWarnings) items.push({ cls: 'warn', text: `[규칙] ${w.message}`, quote: w.quote || '' });
  c.visuals.forEach((v, i) => { if (v.include && v.error) items.push({ cls: 'review', text: `[시각자료 ${i + 1}] ${v.error}`, quote: '' }); });
  return items;
}

function render() {
  const c = current;
  $('result').classList.remove('hidden');
  $('pageNum').value = c.page.value;
  $('nonePage').checked = c.page.none;
  $('pageNumNote').textContent = c.page.note;

  const flags = $('flags');
  flags.innerHTML = '';
  const items = allIssues();
  if (!items.length) items.push({ cls: 'ok', text: '확인할 것이 없어요.' });
  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.cls;
    li.textContent = it.text;
    flags.appendChild(li);
  }

  $('output').value = c.text;
  renderOutputView();
  setEditMode(editing);
  renderVisuals();

  $('notes').textContent = c.notes || '';
  const ch = $('changes');
  ch.innerHTML = '';
  for (const r of c.ruleChanges) {
    const li = document.createElement('li');
    li.textContent = `[규칙] ${r.rule} ${r.count}곳${r.examples.length ? ` (예: ${r.examples.slice(0, 2).join(', ')})` : ''}`;
    ch.appendChild(li);
  }
  renderDiff(c.ocrText, c.text);
  updateLiveWarn();
  $('cost').classList.toggle('hidden', !settings.showCost);
  $('cost').textContent = `이 쪽 비용 약 $${c.cost.toFixed(3)} (약 ${Math.round(c.cost * 1450)}원) · 이번 세션 합계 약 $${sessionCost.toFixed(2)} (목차 정리 포함)`;
}

/** 작성 결과에 확인할 곳을 빨간색으로 표시 (마우스를 올리면 이유) */
function renderOutputView() {
  const text = current.text;
  const ranges = [];
  for (const it of allIssues()) {
    if (!it.quote) continue;
    const at = text.indexOf(it.quote);
    if (at === -1) continue;
    ranges.push({ start: at, end: at + it.quote.length, title: it.text, cls: it.cls });
  }
  ranges.sort((a, b) => a.start - b.start);
  const view = $('outputView');
  view.innerHTML = '';
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) { // 겹치면 앞 표시에 이유를 더한다
      const last = view.lastElementChild;
      if (last && last.tagName === 'MARK') last.title += `\n${r.title}`;
      continue;
    }
    view.append(document.createTextNode(text.slice(pos, r.start)));
    const m = document.createElement('mark');
    if (r.cls !== 'review') m.className = 'warn';
    m.title = r.title;
    m.textContent = text.slice(r.start, r.end);
    view.append(m);
    pos = r.end;
  }
  view.append(document.createTextNode(text.slice(pos)));
}

function setEditMode(on) {
  editing = on;
  $('output').classList.toggle('hidden', !on);
  $('outputView').classList.toggle('hidden', on);
  $('viewHint').classList.toggle('hidden', on);
  $('btnToggleEdit').textContent = on ? '표시 보기' : '직접 고치기';
}

function renderVisuals() {
  const box = $('visuals');
  box.innerHTML = '';
  const blocks = parseVisualBlocks(current.text);
  $('visualsBox').classList.toggle('hidden', !current.visuals.length);
  current.visuals.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'visual';
    const im = document.createElement('img');
    im.alt = `시각자료 ${i + 1}`;
    if (v.crop) im.src = v.crop.dataUrl;
    else if (v.src) im.src = new URL(v.src, 'https://www.mypickebook.org/').href;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const head = document.createElement('div');
    head.className = 'small';
    head.textContent = blocks[i] ? blocks[i].headLine : `[${v.kind}]`;
    const line = document.createElement('div');
    line.className = 'row';
    const inc = document.createElement('label');
    inc.className = 'inline small';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = v.include;
    cb.addEventListener('change', () => { v.include = cb.checked; });
    inc.append(cb, document.createTextNode(' 이미지 넣기'));
    const kind = document.createElement('select');
    for (const k of IMAGE_KINDS) kind.add(new Option(k, k));
    kind.value = v.kind;
    kind.addEventListener('change', () => changeKind(i, kind.value));
    line.append(inc, kind);
    const line2 = document.createElement('div');
    line2.className = 'row';
    if (!v.reused) {
      const fixBtn = document.createElement('button');
      fixBtn.className = 'small-btn';
      fixBtn.textContent = '영역 고치기';
      fixBtn.addEventListener('click', () => openCropEditor(i));
      line2.append(fixBtn);
    }
    const st = document.createElement('span');
    st.className = 'small muted';
    st.textContent = v.reused ? '편집기에 이미 있는 그림을 그대로 써요' : (v.uploadedSrc ? '올림 완료' : (v.error || (v.crop ? `${v.crop.width}×${v.crop.height}px` : '')));
    line2.append(st);
    meta.append(head, line, line2);
    row.append(im, meta);
    box.appendChild(row);
  });
}

function changeKind(i, kind) {
  const blocks = parseVisualBlocks(current.text);
  const b = blocks[i];
  if (!b) return;
  const lines = current.text.split('\n');
  lines[b.start] = lines[b.start].replace(/^\[(그림|사진|그래프|도표|지도)/, `[${kind}`);
  lines[b.end] = `[${kind} 끝]`;
  current.text = lines.join('\n');
  current.visuals[i].kind = kind;
  $('output').value = current.text;
  renderOutputView();
  renderVisuals();
}

function renderDiff(a, b) {
  const box = $('diff');
  box.innerHTML = '';
  for (const part of diffWords(a, b)) {
    const el = part.type === 'same' ? document.createElement('span') : document.createElement(part.type === 'add' ? 'ins' : 'del');
    el.textContent = part.text + (part.text.endsWith('\n') ? '' : ' ');
    box.appendChild(el);
  }
}

function updateLiveWarn() {
  const text = current ? current.text : '';
  const msgs = [];
  if (/[<>]/.test(text)) msgs.push('자판 < > 가 있어요. 사이트가 저장을 막아요(〈 〉 또는 ＜ ＞ 사용).');
  if (/chrome-extension|<script/i.test(text)) msgs.push('사이트가 막는 문자열이 있어요.');
  if (/^\s*\n|\n\s*$/.test(text)) msgs.push('첫 줄이나 마지막 줄이 빈 줄이에요.');
  $('liveWarn').textContent = msgs.join(' ');
  return msgs;
}

// ---------- 영역 고치기 ----------
let cropIndex = -1;
let cropBoxFrac = null;
function openCropEditor(i) {
  const v = current.visuals[i];
  cropIndex = i;
  cropBoxFrac = { ...(v.box || { x: 0.1, y: 0.1, w: 0.8, h: 0.3 }) };
  const img = $('cropPage');
  img.onload = () => requestAnimationFrame(placeCropBox);
  $('cropModal').classList.remove('hidden');
  if (img.src === current.sentImage.dataUrl && img.complete) requestAnimationFrame(placeCropBox);
  else img.src = current.sentImage.dataUrl;
}
function placeCropBox() {
  const st = $('cropStage');
  const W = st.clientWidth;
  const H = st.clientHeight;
  const b = $('cropBox');
  b.style.left = `${cropBoxFrac.x * W}px`;
  b.style.top = `${cropBoxFrac.y * H}px`;
  b.style.width = `${cropBoxFrac.w * W}px`;
  b.style.height = `${cropBoxFrac.h * H}px`;
}
(function setupCropDrag() {
  let drag = null;
  const stage = () => $('cropStage');
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#cropBox')) return;
    const handle = e.target.classList.contains('h') ? [...e.target.classList].find((c) => c !== 'h') : 'move';
    drag = { handle, x: e.clientX, y: e.clientY, start: { ...cropBoxFrac } };
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const W = stage().clientWidth;
    const H = stage().clientHeight;
    const dx = (e.clientX - drag.x) / W;
    const dy = (e.clientY - drag.y) / H;
    const s = drag.start;
    let { x, y, w, h } = s;
    if (drag.handle === 'move') { x = s.x + dx; y = s.y + dy; }
    if (drag.handle.includes('w')) { x = s.x + dx; w = s.w - dx; }
    if (drag.handle.includes('e')) { w = s.w + dx; }
    if (drag.handle.includes('n')) { y = s.y + dy; h = s.h - dy; }
    if (drag.handle.includes('s') && drag.handle !== 'move') { h = s.h + dy; }
    w = Math.max(0.02, Math.min(1, w));
    h = Math.max(0.02, Math.min(1, h));
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    cropBoxFrac = { x, y, w, h };
    placeCropBox();
  });
  document.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('resize', () => { if (cropBoxFrac && !$('cropModal').classList.contains('hidden')) placeCropBox(); });
}());
$('btnCropClose').addEventListener('click', () => $('cropModal').classList.add('hidden'));
$('btnCropApply').addEventListener('click', async () => {
  const v = current.visuals[cropIndex];
  try {
    v.box = { ...cropBoxFrac };
    v.crop = await cropImage(v.original || current.sentImage.dataUrl, v.box, { pad: 0, trim: true });
    v.uploadedSrc = '';
    v.error = '';
    v.include = true;
  } catch (e) {
    v.error = e.message;
  }
  $('cropModal').classList.add('hidden');
  renderVisuals();
  render();
});

// ---------- 넣기 / 저장 ----------
async function applyToEditor() {
  if (!current) throw new Error('먼저 “이 쪽 교정하기”를 눌러 주세요.');
  if (editing) current.text = $('output').value;
  const text = current.text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (updateLiveWarn().some((m) => m.includes('< >') || m.includes('막는'))) {
    throw new Error('사이트가 막는 문자가 있어 넣지 않았어요. 결과를 고친 뒤 다시 눌러 주세요.');
  }
  const tab = await getEditorTab();
  if (tab.id !== current.tabId) throw new Error('교정한 탭과 지금 탭이 달라요.');
  const info = await runInPage(tab.id, pageRead);
  if (info.currPage !== current.info.currPage) throw new Error(`교정한 쪽(${current.info.currPage})과 지금 쪽(${info.currPage})이 달라요. 다시 교정해 주세요.`);
  const nonePage = $('nonePage').checked;
  const pageNum = $('pageNum').value.trim();
  if (!nonePage && !/^\d{1,4}$/.test(pageNum)) throw new Error('쪽 번호는 숫자 1~4자리로 넣어 주세요(로마숫자 쪽은 직접 입력).');

  // 시각자료: 넣을 그림을 올린다 (이미 올렸거나 편집기에 있던 그림은 다시 올리지 않음)
  const blocks = parseVisualBlocks(text);
  const figures = [];
  for (let i = 0; i < blocks.length; i++) {
    const v = current.visuals[i];
    if (!v || !v.include) { figures.push(null); continue; }
    if (v.reused && v.src) { figures.push({ src: v.src, width: 0 }); continue; }
    if (!v.crop) { figures.push(null); continue; }
    if (!v.uploadedSrc) {
      setProgress(`시각자료 ${i + 1}을 올리는 중…`);
      const up = await runInPage(tab.id, pageUploadCrop, [v.crop.dataUrl, info.bookIdx, info.currPage]);
      if (!up?.ok) throw new Error(`시각자료 ${i + 1} 올리기 실패: ${up?.error || ''}`);
      v.uploadedSrc = up.src;
    }
    figures.push({ src: v.uploadedSrc, width: v.crop.width });
  }
  const data = buildEditorData(text, figures);
  const expectFig = figures.filter(Boolean).length;
  const r = await runInPage(tab.id, pageApply, [data, pageNum, nonePage]);
  if (!r?.ok) throw new Error('편집기에 넣지 못했어요: ' + (r?.error || ''));
  const gotFig = (String(r.data).match(/<figure/gi) || []).length;
  if (gotFig < expectFig) throw new Error(`그림 ${expectFig}개 중 ${gotFig}개만 편집기에 들어갔어요. 편집기를 확인해 주세요.`);
  renderVisuals();

  const book = await getBook(info.bookIdx);
  book.pages[info.currPage] = { text, pageNumber: nonePage ? '' : pageNum, at: Date.now() };
  await putBook(info.bookIdx, book);
  setProgress('');
  return { tab, info };
}

function waitForPageLoad(tabId, expectedPage, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('다음 쪽이 열리지 않았어요.')); }, timeoutMs);
    function listener(id, change, tab) {
      if (id !== tabId || change.status !== 'complete') return;
      if (expectedPage && !new RegExp(`book_page=${expectedPage}(\\D|$)`).test(tab.url || '')) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function waitForEditor(tabId, expectedPage) {
  for (let i = 0; i < 40; i++) {
    try {
      const info = await runInPage(tabId, pageRead);
      if (info.editorFound && info.currPage === expectedPage && info.imgSrc) return info;
    } catch { /* 로딩 중 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('다음 쪽 편집기가 준비되지 않았어요.');
}

async function save(mode) {
  const { tab, info } = await applyToEditor();
  if (mode === 'next' && info.currPage >= info.maxPage) mode = 'temp';
  if (mode === 'temp') {
    const r = await runInPage(tab.id, pageSave, ['temp']);
    if (!r?.ok) throw new Error('임시저장 실패: ' + (r?.error || ''));
    return { moved: false, info, last: info.currPage >= info.maxPage };
  }
  const expected = info.currPage + 1;
  const loaded = waitForPageLoad(tab.id, expected);
  let r;
  try {
    r = await runInPage(tab.id, pageSave, ['next']);
  } catch {
    r = { ok: true, navigating: true };
  }
  if (r && r.ok === false) throw new Error('저장 실패: ' + (r.error || ''));
  await loaded;
  await waitForEditor(tab.id, expected);
  current = null;
  return { moved: true, info };
}

// ---------- 자동 모드 ----------
function needsStop() {
  const c = current;
  const reasons = [];
  if (c.flags.some((f) => f.needs_review)) reasons.push('확인할 항목이 있어요');
  if (c.visuals.some((v) => v.include && v.error)) reasons.push('잘라내지 못한 시각자료가 있어요');
  if (settings.stopOnPageGuess && c.page.guessed) reasons.push('쪽 번호를 추정했어요');
  if (settings.stopOnSpecial && PAGE_KIND[c.result.page_kind]) reasons.push(`특수한 쪽(${PAGE_KIND[c.result.page_kind]})이에요`);
  if (settings.stopOnVisuals && c.visuals.length) reasons.push('시각자료가 있어요');
  if (settings.stopOnWarnings && c.ruleWarnings.length) reasons.push('규칙 경고가 있어요');
  return reasons.join(', ');
}

async function autoLoop() {
  autoRunning = true;
  $('btnAuto').textContent = '자동 모드 멈추기';
  $('btnAuto').classList.add('danger');
  try {
    while (autoRunning) {
      const st = await refreshStatus();
      if (!st) throw new Error('편집 화면을 찾지 못했어요.');
      if (st.info.remainingSec != null && settings.timeWarnMin > 0 && st.info.remainingSec < settings.timeWarnMin * 60) {
        throw new Error(`남은 시간이 ${fmtTime(st.info.remainingSec)}이라 자동 모드를 멈췄어요. 남은 쪽을 확인하고 직접 제출해 주세요.`);
      }
      await analyze();
      if (!autoRunning) break;
      const stop = needsStop();
      if (stop) {
        setProgress(`${current.info.currPage}쪽에서 멈췄어요: ${stop}. 확인 후 “넣고 저장 후 다음 쪽”을 누르고 자동 모드를 다시 시작하세요.`);
        break;
      }
      setProgress(`${current.info.currPage}쪽 저장 후 다음 쪽으로…`);
      const r = await save('next');
      if (!r.moved) {
        setProgress(`마지막 쪽(${r.info.currPage}쪽)까지 저장했어요. 모든 쪽을 확인한 뒤 “제출하기”를 직접 눌러 주세요.`);
        break;
      }
      $('result').classList.add('hidden');
    }
  } finally {
    autoRunning = false;
    $('btnAuto').textContent = '자동 모드 시작';
    $('btnAuto').classList.remove('danger');
    await refreshStatus();
  }
}

// ---------- 이벤트 ----------
function guard(fn) {
  return async () => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || String(e));
      setProgress('');
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
}));

$('btnAnalyze').addEventListener('click', guard(analyze));
$('btnApply').addEventListener('click', guard(async () => { await applyToEditor(); setProgress('편집기에 넣었어요. 저장은 아직 안 했어요.'); }));
$('btnApplySave').addEventListener('click', guard(async () => {
  const r = await save('temp');
  setProgress(r.last ? '임시저장했어요. 마지막 쪽이에요. 모든 쪽 확인 후 “제출하기”를 직접 눌러 주세요.' : '임시저장했어요.');
}));
$('btnApplyNext').addEventListener('click', guard(async () => {
  const r = await save('next');
  $('result').classList.add('hidden');
  setProgress(r.moved ? `${r.info.currPage}쪽을 저장하고 다음 쪽으로 넘어갔어요.` : '마지막 쪽이라 임시저장만 했어요. 직접 “제출하기”를 눌러 주세요.');
}));
$('btnAuto').addEventListener('click', async () => {
  if (autoRunning) {
    autoRunning = false;
    abort?.abort();
    setProgress('자동 모드를 멈췄어요.');
    return;
  }
  setError('');
  setBusy(true);
  try {
    await autoLoop();
  } catch (e) {
    if (e.name !== 'AbortError') setError(e.message || String(e));
  } finally {
    setBusy(false);
  }
});
$('btnToggleEdit').addEventListener('click', () => {
  if (!current) return;
  if (editing) {
    current.text = $('output').value;
    renderOutputView();
    renderVisuals();
  }
  setEditMode(!editing);
});
$('output').addEventListener('input', () => { if (current) { current.text = $('output').value; updateLiveWarn(); } });

$('btnAddKey').addEventListener('click', addKey);
$('newKeyValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(); });
$('model').addEventListener('change', async () => { settings.model = $('model').value; await persist(); msg('settingsMsg', '모델을 바꿨어요.'); });
$('btnSaveAdvanced').addEventListener('click', saveAdvanced);
$('btnClearBook').addEventListener('click', guard(async () => {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  await chrome.storage.local.remove(`book:${info.bookIdx}`);
  msg('advancedMsg', '이 책의 작업 기록(이전 쪽 내용, 목차)을 지웠어요.');
}));

async function editorBook() {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  return { info, book: await getBook(info.bookIdx) };
}
$('btnSaveToc').addEventListener('click', guard(async () => {
  const { info, book } = await editorBook();
  book.toc = $('tocText').value.trim() || null;
  book.tocVersion = TOC_VERSION;
  book.tocError = '';
  await putBook(info.bookIdx, book);
  setProgress('목차를 저장했어요.');
}));
async function rebuildToc() {
  const { info, book } = await editorBook();
  book.toc = null;
  book.tocNotes = '';
  book.tocError = '';
  await putBook(info.bookIdx, book);
  $('tocText').value = '';
  showTocState(book);
  if (!activeKey()) throw new Error('API 키가 없어요. 설정 탭에서 추가해 주세요.');
  abort = new AbortController();
  const tab = await getEditorTab();
  await ensureToc(tab, info, book, abort.signal);
  setProgress(book.toc ? '목차를 다시 읽었어요. “이 책 목차”에서 확인하세요.' : '');
  if (!book.toc && book.tocError) throw new Error(`목차를 읽지 못했어요: ${book.tocError}`);
}
$('btnRebuildToc').addEventListener('click', guard(rebuildToc));
$('btnTocRetry').addEventListener('click', guard(rebuildToc));

chrome.tabs.onActivated.addListener(() => refreshStatus());
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'complete' && !autoRunning) refreshStatus(); });
setInterval(() => { if (!autoRunning) refreshStatus(); }, 15000);

(async () => {
  await loadSettings();
  fillForms();
  if (!activeKey()) {
    document.querySelector('.tab[data-tab="settings"]').click();
    msg('settingsMsg', '처음이시면 API 키를 추가해 주세요.');
  }
  refreshStatus();
})();

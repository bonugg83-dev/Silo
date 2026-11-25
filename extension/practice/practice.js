// 연습 페이지: 마이픽 편집 화면(make_book.html)을 흉내 낸다.
// 사이트로는 아무것도 보내지 않는다. 저장·그림 올리기·목차는 이 컴퓨터 안에서 흉내 낸다.
// 도우미 패널은 실제 사이트에서 쓰는 함수(lib/page.js)를 이 페이지 안에서 그대로 실행한다.
import {
  pageRead, pageFetchImage, pageFetchToc, pageFetchOriginal, pageUploadCrop, pageApply, pageSave, pageGoto,
} from '../lib/page.js';

const $ = (id) => document.getElementById(id);
const FNS = { pageRead, pageFetchImage, pageFetchToc, pageFetchOriginal, pageUploadCrop, pageApply, pageSave, pageGoto };
const BOOK_IDX = '0';
const K_SAVED = 'practice:saved';
const K_CUSTOM = 'practice:custom';
const K_DEADLINE = 'practice:deadline';

async function loadSamples() {
  try {
    const m = await import('./samples/samples.js');
    return m.SAMPLES.map((s) => ({ ...s, src: chrome.runtime.getURL(`practice/samples/${s.file}`) }));
  } catch {
    return []; // 예시 쪽이 없는 설치본
  }
}

const store = {
  async get(key, def) { const r = await chrome.storage.local.get(key); return r[key] ?? def; },
  async set(key, val) { await chrome.storage.local.set({ [key]: val }); },
};

const params = new URLSearchParams(location.search);
let pages = [];
let pageNo = 1;
let page = null;

// ---------- 편집기 흉내 (CKEditor 4의 content 인스턴스) ----------
window.CKEDITOR = {
  instances: {
    content: {
      _data: '',
      getData() { return this._data; },
      setData(d, opt) {
        this._data = String(d);
        showPreview();
        setTimeout(() => opt && opt.callback && opt.callback(), 30);
      },
      updateElement() { $('content').value = this._data; },
    },
  },
};
function showPreview() {
  const html = window.CKEDITOR.instances.content._data;
  // 연습 화면 보기용: 편집기 데이터를 그대로 그린다 (스크립트는 확장 프로그램 보안 정책상 실행되지 않음)
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script, iframe, object').forEach((n) => n.remove());
  $('preview').replaceChildren(...doc.body.firstChild.childNodes);
  $('content').value = html;
}
$('content').addEventListener('input', () => { window.CKEDITOR.instances.content._data = $('content').value; showPreview(); });

// ---------- 사이트 주소 흉내 ----------
const realFetch = window.fetch.bind(window);
let tocImage = '';
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin === location.origin) {
    if (url.pathname === '/upload/book/file.php') return realFetch(page.src);
    if (url.pathname === '/module/book/cropbox_upload_proc.php') {
      // 실제로 올리지 않고, 잘린 그림을 그대로 그림 주소로 쓴다
      const crop = init.body && init.body.get ? init.body.get('crop_file') : '';
      if (!/^data:image\//.test(crop || '')) return json({ result: 400, message: '그림이 없어요' });
      return json({ result: 200, img_path: crop });
    }
    if (url.pathname === '/module/book/table_of_content.php') {
      return new Response(`<html><body><div class="feed_wrap"><h1>목차</h1><div><img src="${tocImage}"></div></div></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }
  return realFetch(input, init);
};
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

function makeTocImage() {
  const lines = ['차례 (연습용)', '', '06. 대지와 민중을 사랑한 국민시인 휘트먼 ········ 140', '07. 미국적 기독교 신앙의 구현자 호손 ············ 154'];
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 80 + lines.length * 48;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111';
  lines.forEach((t, i) => {
    g.font = i === 0 ? 'bold 34px "Malgun Gothic", sans-serif' : '26px "Malgun Gothic", sans-serif';
    g.fillText(t, 40, 60 + i * 48);
  });
  return c.toDataURL('image/png');
}

// ---------- 저장 흉내 ----------
window.saveGo = function saveGo(gubun) {
  if (gubun !== 'temp' && gubun !== 'next') { alert('연습 페이지에는 제출하기가 없어요.'); return false; }
  window.CKEDITOR.instances.content.updateElement();
  const v = $('content').value;
  if (v.indexOf('&gt;') > -1 || v.indexOf('&lt;') > -1) { alert('산괄호(</>), 부등호 기호는 유니코드를 사용해 주세요.'); return false; }
  if (!$('none_page').checked && !$('page_num').value.trim()) { alert('페이지번호를 입력해 주세요.'); return false; }
  if (gubun === 'next' && pageNo >= pages.length) { alert('다음 페이지가 없습니다.'); return false; }
  setTimeout(async () => {
    const saved = await store.get(K_SAVED, {});
    saved[pageNo] = { content: v, pageNum: $('page_num').value, none: $('none_page').checked, at: Date.now() };
    await store.set(K_SAVED, saved);
    if (gubun === 'next') goTo(pageNo + 1);
    else alert('저장 되었습니다.');
  }, 300);
  return undefined;
};
function goTo(n) {
  location.href = `practice.html?idx=${BOOK_IDX}&book_page=${n}`;
}
$('btnTemp').addEventListener('click', () => window.saveGo('temp'));
$('btnNext').addEventListener('click', () => window.saveGo('next'));
$('btnPrev').addEventListener('click', () => { if (pageNo > 1) goTo(pageNo - 1); });

// ---------- 남은 시간 ----------
async function startTimer() {
  let deadline = await store.get(K_DEADLINE, 0);
  if (!deadline || deadline < Date.now()) {
    deadline = Date.now() + 3 * 3600 * 1000;
    await store.set(K_DEADLINE, deadline);
  }
  const tick = () => {
    const s = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    const p = (n) => String(n).padStart(2, '0');
    document.querySelector('.time').textContent = `${p(Math.floor(s / 3600))}시간 ${p(Math.floor((s % 3600) / 60))}분 ${p(s % 60)}초`;
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- 내 원본 넣기 ----------
async function fileToJpeg(file, maxSide = 2000) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
$('btnAddCustom').addEventListener('click', async () => {
  const files = Array.from($('customFile').files || []);
  if (!files.length) { $('customMsg').textContent = '이미지를 먼저 골라 주세요.'; return; }
  $('customMsg').textContent = '넣는 중…';
  const custom = await store.get(K_CUSTOM, []);
  const ocr = $('customOcr').value.replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
  for (const [i, f] of files.entries()) {
    try {
      custom.push({ src: await fileToJpeg(f), ocr: i === 0 ? ocr : '', pageNum: i === 0 ? $('customPageNum').value.trim() : '', label: `내 쪽: ${f.name}` });
    } catch (e) {
      $('customMsg').textContent = `${f.name}을 읽지 못했어요: ${e.message}`;
      return;
    }
  }
  await store.set(K_CUSTOM, custom);
  $('customMsg').textContent = `${files.length}장을 넣었어요.`;
  $('customFile').value = '';
  $('customOcr').value = '';
  $('customPageNum').value = '';
  await init(false);
});
function renderCustomList(samplesCount, custom) {
  const ul = $('customList');
  ul.innerHTML = '';
  custom.forEach((c, i) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `practice.html?idx=${BOOK_IDX}&book_page=${samplesCount + i + 1}`;
    a.textContent = `${samplesCount + i + 1}번째 쪽 · ${c.label}`;
    const del = document.createElement('button');
    del.textContent = '지우기';
    del.addEventListener('click', async () => {
      const list = await store.get(K_CUSTOM, []);
      list.splice(i, 1);
      await store.set(K_CUSTOM, list);
      const saved = await store.get(K_SAVED, {});
      delete saved[samplesCount + i + 1];
      await store.set(K_SAVED, saved);
      await init(false);
    });
    li.append(a, ' ', del);
    ul.appendChild(li);
  });
}
$('btnReset').addEventListener('click', async () => {
  if (!confirm('연습으로 저장한 내용과 남은 시간, 도우미가 기억한 연습 책 기록을 지울까요? (넣은 내 쪽 이미지는 남아요)')) return;
  // 도우미의 책 기록은 계정마다 book:<계정 id>:<책 번호>
  const books = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('book:') && k.endsWith(`:${BOOK_IDX}`));
  await chrome.storage.local.remove([K_SAVED, K_DEADLINE, `book:${BOOK_IDX}`, ...books]);
  goTo(1);
});

// ---------- 쪽 열기 ----------
async function init(first = true) {
  const samples = await loadSamples();
  const custom = await store.get(K_CUSTOM, []);
  pages = [...samples, ...custom];
  renderCustomList(samples.length, custom);
  $('pageCount').textContent = String(Math.max(1, pages.length));
  if (!first) return;
  if (!pages.length) {
    $('pageLabel').textContent = '예시 쪽이 없어요. 아래에서 내 원본 이미지를 넣어 주세요.';
    return;
  }
  pageNo = Math.min(Math.max(1, parseInt(params.get('book_page') || '1', 10) || 1), pages.length);
  page = pages[pageNo - 1];
  $('curr_page').value = String(pageNo);
  $('curr_page').setAttribute('curr-page', String(pageNo));
  $('pageLabel').textContent = page.label || '';
  $('book_img').src = page.src;
  const saved = (await store.get(K_SAVED, {}))[pageNo];
  $('page_num').value = saved ? saved.pageNum : (page.pageNum || '');
  $('none_page').checked = !!(saved && saved.none);
  window.CKEDITOR.instances.content._data = saved ? saved.content : (page.ocr || '');
  showPreview();
  document.title = `연습 ${pageNo}쪽 - 마이픽 교정 도우미`;
}

// ---------- 도우미 패널과 연결 ----------
const me = await chrome.tabs.getCurrent();
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.practiceCall !== true || msg.tabId !== me?.id) return undefined;
  const fn = FNS[msg.fn];
  if (!fn) { sendResponse({ ok: false, error: `알 수 없는 함수: ${msg.fn}` }); return undefined; }
  Promise.resolve()
    .then(() => fn(...(msg.args || [])))
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

tocImage = makeTocImage();
await init(true);
await startTimer();

// 마이픽 편집 화면(make_book.html)에서 실행되는 함수들.
// chrome.scripting.executeScript({ world: 'MAIN', func }) 로 주입되므로
// 각 함수는 바깥 변수를 쓰지 않는 독립 함수여야 한다.
// 절대 saveGo('complete')(최종 제출)를 호출하지 않는다.

/** 현재 쪽의 정보를 읽는다. */
export function pageRead() {
  const $q = (s) => document.querySelector(s);
  const out = { ok: true, errors: [] };
  out.url = location.href;
  const m = location.search.match(/[?&]idx=(\d+)/);
  out.bookIdx = m ? m[1] : '';

  try {
    const ed = window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances.content;
    out.ocrHtml = ed ? ed.getData() : ($q('#content') ? $q('#content').value : '');
    out.editorFound = !!ed;
  } catch (e) {
    out.errors.push('편집기 읽기 실패: ' + e.message);
    out.ocrHtml = '';
  }

  const img = $q('#book_img');
  out.imgSrc = img ? img.src : '';
  out.imgNatural = img ? { w: img.naturalWidth, h: img.naturalHeight } : null;

  const curr = $q('#curr_page');
  out.currPage = curr ? parseInt(curr.getAttribute('curr-page') || curr.value, 10) : NaN;
  out.minPage = NaN;
  out.maxPage = NaN;
  try {
    const $ = window.jQuery;
    if ($ && $('#slider-range-min').slider) {
      out.minPage = $('#slider-range-min').slider('option', 'min');
      out.maxPage = $('#slider-range-min').slider('option', 'max');
    }
  } catch (e) { /* 슬라이더가 없으면 아래 방법 사용 */ }
  if (isNaN(out.maxPage)) {
    const pg = $q('.paging');
    const mm = pg && pg.textContent.match(/\/\s*(\d+)/);
    if (mm) out.maxPage = parseInt(mm[1], 10);
  }

  const pn = $q('#page_num');
  out.pageField = pn ? pn.value : '';
  out.nonePage = !!($q('#none_page') && $q('#none_page').checked);

  const t = $q('.time');
  out.timeText = t ? t.textContent.trim() : '';
  const tm = out.timeText.match(/(\d+)\s*시간\s*(\d+)\s*분\s*(\d+)\s*초/);
  out.remainingSec = tm ? (+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3]) : null;

  const tip = $q('.makeTip');
  if (tip) {
    const c = tip.cloneNode(true);
    c.querySelectorAll('.tipTit, .tipMore, script, style').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    c.querySelectorAll('p, div, li').forEach((n) => n.append('\n'));
    out.tipText = c.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (out.tipText === '-') out.tipText = '';
    out.tipImages = Array.from(c.querySelectorAll('img')).map((i) => i.src).slice(0, 3);
  } else {
    out.tipText = '';
    out.tipImages = [];
  }

  const info = $q('.makeInfor');
  out.bookInfo = info
    ? [info.querySelector('h2')?.textContent?.trim(), ...Array.from(info.querySelectorAll('li')).map((l) => l.textContent.trim())]
      .filter(Boolean).join('\n')
    : '';
  return out;
}

/** 이미지 URL(같은 사이트, 로그인 쿠키 포함)을 data URL로 가져온다. */
export async function pageFetchImage(src) {
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return { ok: true, dataUrl, type: blob.type, size: blob.size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** [목차보기] 팝업 페이지를 가져와 텍스트로 만든다. */
export async function pageFetchToc(bookIdx) {
  try {
    const res = await fetch('/module/book/table_of_content.php?book_idx=' + encodeURIComponent(bookIdx), { credentials: 'include' });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, head').forEach((n) => n.remove());
    doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((n) => n.append('\n'));
    // 들여쓰기/단계 정보가 class에 있으면 남긴다
    const text = (doc.body ? doc.body.textContent : '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return { ok: true, text: text.slice(0, 20000) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 편집기에 내용과 쪽 번호를 넣는다. data는 "줄<br>\n줄" 형식. */
export function pageApply(data, pageNum, nonePage) {
  return new Promise((resolve) => {
    const ed = window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances.content;
    if (!ed) { resolve({ ok: false, error: 'CKEditor(content)를 찾지 못했어요.' }); return; }
    if (/&lt;|&gt;|chrome-extension|<script/i.test(data)) {
      resolve({ ok: false, error: '사이트가 막는 문자(< >, script 등)가 들어 있어요.' });
      return;
    }
    const nb = document.querySelector('#none_page');
    const pn = document.querySelector('#page_num');
    if (nb && nb.checked !== !!nonePage) nb.click();
    if (pn && !nonePage && pageNum !== null && pageNum !== undefined && String(pageNum) !== '') {
      pn.value = String(pageNum);
      pn.dispatchEvent(new Event('input', { bubbles: true }));
      pn.dispatchEvent(new Event('change', { bubbles: true }));
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ed.updateElement(); } catch (e) { /* ignore */ }
      resolve({ ok: true, data: ed.getData() });
    };
    ed.setData(data, { callback: finish });
    setTimeout(finish, 3000);
  });
}

/**
 * 저장. mode는 'temp'(임시저장) 또는 'next'(저장 후 다음 쪽)만 허용.
 * 저장 결과 알림창(alert)은 잠시 가로채서 내용을 돌려준다.
 */
export function pageSave(mode) {
  return new Promise((resolve) => {
    if (mode !== 'temp' && mode !== 'next') { resolve({ ok: false, error: '허용되지 않은 저장 방식' }); return; }
    if (typeof window.saveGo !== 'function') { resolve({ ok: false, error: 'saveGo 함수를 찾지 못했어요.' }); return; }
    const messages = [];
    const origAlert = window.alert;
    let restored = false;
    const restore = () => { if (!restored) { window.alert = origAlert; restored = true; } };
    window.alert = (msg) => { messages.push(String(msg)); };
    let ret;
    try {
      ret = window.saveGo(mode);
    } catch (e) {
      restore();
      resolve({ ok: false, error: e.message, messages });
      return;
    }
    if (ret === false) {
      // 폼 검사에서 막힘 (쪽 번호 비었음, 산괄호 등)
      restore();
      resolve({ ok: false, error: messages.join(' / ') || '저장이 거부됐어요.', messages });
      return;
    }
    const started = Date.now();
    const poll = () => {
      if (messages.length || Date.now() - started > 15000) {
        restore();
        const ok = mode === 'next' ? !messages.length : messages.some((m) => m.includes('저장 되었습니다'));
        resolve({ ok, messages, error: ok ? '' : (messages.join(' / ') || '저장 응답이 없어요.') });
        return;
      }
      setTimeout(poll, 150);
    };
    if (mode === 'next') {
      // 성공하면 페이지가 이동한다. 이동 전에 알림이 오면 실패.
      window.addEventListener('pagehide', () => { restore(); resolve({ ok: true, navigating: true, messages }); }, { once: true });
    }
    poll();
  });
}

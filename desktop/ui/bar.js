const $ = (id) => document.getElementById(id);
// 위쪽 막대 로고의 화면 위치: 시작 모션이 이 자리로 들어가 멈추도록 앱 본체에 알려 줌
const reportBrand = () => {
  const r = document.querySelector('.bar .brand').getBoundingClientRect();
  silo.brandRect({ left: r.left, top: r.top, width: r.width, height: r.height });
};
reportBrand();
window.addEventListener('resize', reportBrand);
for (const id of ['back', 'forward', 'reload', 'home', 'practice', 'togglePanel', 'diagnostics']) $(id).addEventListener('click', () => silo.cmd(id));

function describe(url, title) {
  let u;
  try { u = new URL(url); } catch { return ['', title || '']; }
  if (!/mypickebook\.org$/.test(u.hostname)) return [u.hostname, title || ''];
  if (/make_book\.html$/.test(u.pathname)) {
    const p = u.searchParams.get('book_page');
    return ['마이픽 · 전자도서 제작', p ? `편집 화면 ${p}쪽` : '편집 화면'];
  }
  return ['마이픽', title && !/^https?:/.test(title) ? title : ''];
}
silo.onState((s) => {
  const [place, detail] = describe(s.url, s.title);
  const where = $('where');
  where.textContent = place;
  if (detail) { where.append(' › '); const b = document.createElement('b'); b.textContent = detail; where.append(b); }
  $('back').disabled = !s.canBack;
  $('forward').disabled = !s.canForward;
  $('togglePanel').setAttribute('aria-pressed', String(!!s.panelHidden));
  $('togglePanel').setAttribute('aria-label', s.panelHidden ? '패널 펴기' : '패널 접기');
  document.body.classList.toggle('locked', !!s.authOpen);
  $('practice').hidden = !!s.reviewOpen;
  const link = $('link');
  const eds = s.editors || [];
  link.classList.toggle('on', eds.length > 0);
  link.textContent = eds.length === 1 ? `편집 화면 연결됨${eds[0] ? ' · ' + eds[0] + '쪽' : ''}`
    : eds.length > 1 ? `편집 화면 ${eds.length}개` : '편집 화면 없음';
  link.title = link.textContent; // 말줄임으로 잘려도 전체 문구는 마우스를 올리면 보임
  renderUpdate(s.update);
  renderStrip(s);
});
// 새 버전을 다 받으면 "다시 시작해서 업데이트" 버튼
function renderUpdate(u) {
  const b = $('update');
  const ready = u?.status === 'ready';
  b.hidden = !ready;
  if (ready) $('updateText').textContent = `새 버전${u.version ? ' ' + u.version : ''} · 다시 시작`;
}
$('update').addEventListener('click', () => silo.cmd('installUpdate'));
// 열린 창 목록 줄
const ICON = {
  min: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18h12"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
function el(tag, cls, attrs = {}) { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e, attrs); return e; }
function renderStrip(s) {
  const strip = $('strip');
  const list = s.popups || [];
  strip.hidden = !list.length || !!s.authOpen;
  strip.replaceChildren();
  if (strip.hidden) return;
  const home = el('div', 'tab home' + (list.some((p) => p.shown) ? '' : ' on'));
  const hb = el('button', 't', { type: 'button', title: '마이픽 화면' });
  hb.append(el('span', '', { textContent: '마이픽' }));
  hb.addEventListener('click', () => silo.cmd('showSite'));
  home.append(hb);
  strip.append(home);
  for (const p of list) {
    const tab = el('div', 'tab' + (p.shown ? ' on' : '') + (/^편집 화면/.test(p.title) ? ' editor' : ''));
    const t = el('button', 't', { type: 'button', title: p.title });
    t.append(el('span', '', { textContent: p.title }));
    t.addEventListener('click', () => silo.cmd('showPopup', p.id));
    tab.append(t);
    if (p.shown) {
      const min = el('button', 'b', { type: 'button', innerHTML: ICON.min, title: '내리기 (마이픽 화면 보기)' });
      min.setAttribute('aria-label', p.title + ' 내리기');
      min.addEventListener('click', () => silo.cmd('showSite'));
      tab.append(min);
    }
    const x = el('button', 'b', { type: 'button', innerHTML: ICON.close, title: '닫기' });
    x.setAttribute('aria-label', p.title + ' 닫기');
    x.addEventListener('click', () => silo.cmd('closePopup', p.id));
    tab.append(x);
    strip.append(tab);
  }
}
let toastTimer;
silo.onToast((text) => {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
});

// 마이픽 관리자 피드백 가져오기
// 마이페이지(/mypage/book.html)의 봉사실적 표에서 피드백 버튼(pop_feed.html?idx=…)을 찾고,
// 피드백 팝업 표(작업페이지·피드백 유형·피드백 내용·검수날짜)를 읽는다.
// 같은 피드백은 모든 사용자 것을 모아(클라우드) 자주 받은 순으로 Claude에게 알려 준다.

const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'" };

/** 표 칸 HTML → 글자 (<br>은 줄바꿈) */
export function cellText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|#039);/g, (m) => ENT[m])
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

function rows(html) {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(String(html ?? ''));
  if (!body) return [];
  return [...body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]));
}

/** 마이페이지 봉사실적 표 → 피드백이 있는 책 [{idx, title, range, count}] */
export function parseBookList(html) {
  const out = [];
  for (const tds of rows(html)) {
    const all = tds.join(' ');
    const m = /pop_feed\.html\?idx=(\d+)/.exec(all);
    if (!m) continue;
    const count = Number((/feed_btn[^>]*>\s*(\d+)\s*건/.exec(all) || [])[1]) || 0;
    out.push({ idx: m[1], title: cellText(tds[2] || ''), range: cellText(tds[6] || ''), count });
  }
  return out;
}

/** 피드백 팝업 표 → [{page, type, text, date}] */
export function parseFeedPopup(html) {
  const out = [];
  for (const tds of rows(html)) {
    if (tds.length < 4) continue;
    const text = cellText(tds[3]);
    if (!text) continue;
    out.push({ page: cellText(tds[1]).replace(/\s*P$/i, ''), type: cellText(tds[2]) || '기타', text, date: cellText(tds[4] || '') });
  }
  return out;
}

/** 같은 피드백인지 볼 때 쓰는 글자 (공백·부호 차이 무시) */
export function feedbackKey(text) {
  return String(text ?? '').normalize('NFC').replace(/[\s.,!?·…'"“”‘’()\[\]]/g, '').toLowerCase();
}

/** 새로 읽은 피드백을 기록에 더한다. 같은 책·쪽·내용은 한 번만. @returns {{list, added}} */
export function mergeFeedback(list, items) {
  const have = new Set((list || []).map((f) => `${f.idx}:${f.page}:${feedbackKey(f.text)}`));
  const added = [];
  for (const f of items || []) {
    const k = `${f.idx}:${f.page}:${feedbackKey(f.text)}`;
    if (have.has(k)) continue;
    have.add(k);
    added.push(f);
  }
  return { list: [...(list || []), ...added], added };
}

/**
 * Claude에게 줄 피드백 목록: 내 것과 모두의 것(shared: [{text, type, count}])을 합쳐
 * 같은 내용은 하나로, 자주 받은 순. 너무 길면 자른다.
 */
export function feedbackDigest(mine = [], shared = [], { max = 40, maxLen = 300 } = {}) {
  const by = new Map();
  const add = (text, type, n) => {
    const k = feedbackKey(text);
    if (!k) return;
    const cur = by.get(k) || { text: String(text).trim(), type: type || '기타', count: 0 };
    cur.count += n;
    by.set(k, cur);
  };
  for (const s of shared) add(s.text, s.type, Number(s.count) || 1);
  const sharedKeys = new Set(shared.map((s) => feedbackKey(s.text)));
  for (const f of mine) if (!sharedKeys.has(feedbackKey(f.text))) add(f.text, f.type, 1);
  return [...by.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((f) => {
      const t = f.text.replace(/\n+/g, ' ');
      return `- [${f.type}${f.count > 1 ? ` ${f.count}회` : ''}] ${t.length > maxLen ? `${t.slice(0, maxLen)}…` : t}`;
    })
    .join('\n');
}

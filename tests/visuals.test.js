import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVisualBlocks, buildEditorData, existingFigureSrcs } from '../app/lib/visuals.js';
import { applyFixes } from '../app/lib/fixes.js';
import { editorHtmlToText } from '../app/lib/convert.js';

test('시각자료 블록: 제목 위치가 달라도 찾고, @@i 없는 블록(도표 글자만)은 건너뜀', () => {
  const t = '본문\n[그림] 제목 A\n@@i\n설명\n[그림 끝]\n[표 1]\n가|나\n[표 끝]\n[사진 2-4]\n@@i\n[사진 끝]\n[지도 서울 지도(Seoul)]\n@@i\n[지도 끝]\n[도표]\n글자만\n[도표 끝]';
  const b = parseVisualBlocks(t);
  assert.deepEqual(b.map((x) => x.kind), ['그림', '사진', '지도']);
  assert.equal(b[0].headLine, '[그림] 제목 A');
  assert.deepEqual(b[0].captionLines, ['설명']);
  assert.deepEqual(b[1].captionLines, []);
});

test('편집기 데이터: 그림이 준비된 블록만 figure로, 나머지는 줄마다 <br>', () => {
  const t = '첫 줄 <A&B>\n[그림] 제목\n@@i\n설명1\n설명2\n[그림 끝]\n[사진]\n@@i\n[사진 끝]\n끝 줄';
  const d = buildEditorData(t, [{ src: '/upload/a.png', width: 300 }, null]);
  assert.equal(d, '첫 줄 &lt;A&amp;B&gt;\n<p>[그림] 제목</p><p>@@i</p><figure class="image"><img src="/upload/a.png"><figcaption>설명1<br>설명2</figcaption></figure><p>[그림 끝]</p>\n[사진]<br>\n@@i<br>\n[사진 끝]<br>\n끝 줄');
  assert.deepEqual(existingFigureSrcs(d), ['/upload/a.png']);
  // 다시 읽으면 같은 줄들로 돌아옴
  assert.equal(editorHtmlToText(d), t.replace('<A&B>', '<A&B>'));
});

test('2차 검증 수정: 한 곳에만 있는 구절만 고침', () => {
  const r = applyFixes('가나다 라마 가나', [
    { find: '라마', replace: '라마바', reason: '' },
    { find: '가나', replace: 'X', reason: '' },
    { find: '없음', replace: 'Y', reason: '' },
    { find: '$&', replace: 'Z', reason: '' },
  ]);
  assert.equal(r.text, '가나다 라마바 가나');
  assert.equal(r.applied.length, 1);
  assert.deepEqual(r.failed.map((f) => f.why), ['같은 구절이 2곳에 있음', '고칠 구절을 찾지 못함', '고칠 구절을 찾지 못함']);
});

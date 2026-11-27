// 브라우저 테스트용: Silo 앱(app/)을 임시 폴더에 복사하고 테스트 전용 매니페스트를 붙여
// 크롬에 "압축 해제 확장"으로 올릴 수 있게 한다. 이때 앱은 크롬 API를 플랫폼 창구로 쓴다(app/lib/platform.js).
// 크롬 확장으로 배포하지는 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '../app');

export function appForChrome() {
  const out = fs.mkdtempSync('/tmp/claude-0/silo-app-');
  fs.cpSync(APP_DIR, out, { recursive: true });
  for (const f of ['manifest.json', 'harness-sw.js']) fs.copyFileSync(path.join(here, 'harness', f), path.join(out, f));
  return out;
}

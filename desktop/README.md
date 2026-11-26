# Silo 데스크톱 앱

크롬 확장(`../extension`)을 **고치지 않고 그대로** Electron 창 안에서 돌리는 윈도·맥 앱입니다.
확장과 앱이 같은 코드를 쓰므로, 확장을 고치면 앱도 같이 바뀝니다.

## 화면 (시안 A "나란히")

- **위쪽 막대**: Silo 로고, 뒤로·앞으로·새로고침, 지금 위치(“마이픽 · 전자도서 제작 › 편집 화면 151쪽”), 연습 페이지, 패널 접기
- **왼쪽**: 마이픽 사이트. 로그인이 앱에 저장되어 다음에 켜도 유지됩니다.
- **오른쪽**: Silo 패널(확장의 `sidepanel.html`). 가운데 막대를 끌어 폭을 바꿀 수 있고(360~900px), 폭은 기억됩니다.
- **편집하기와 사이트 팝업**: 사이트가 여는 창(편집 화면, 검수 확인, 기록 확인 등)은 따로 뜨지 않고 앱 안 왼쪽 칸에 겹쳐 열립니다. 위쪽 창 목록 줄(마이픽 / 편집 화면 151쪽 / 기록 …)에서 창을 골라 보고, —로 내리고(마이픽 화면 보기), ×로 닫습니다. 사이트가 스스로 창을 닫으면 목록에서도 빠집니다. 같은 로그인으로 열리며, 빈 창을 먼저 열고 주소를 넣거나 폼을 보내는 방식도 됩니다. 패널은 편집 화면 창을 알아서 찾고, 위쪽 막대에 “편집 화면 연결됨 · 151쪽”이 보입니다.
- **Claude 호출**: 크롬 확장은 host_permissions로 CORS 없이 Claude API를 부르는데, 앱 화면(silo://)에서 바로 부르면 컴퓨터에 따라 "Failed to fetch"로 막힐 수 있습니다. 그래서 패널의 Claude API 호출은 앱 본체가 대신 보냅니다(`preload-shim.js`의 fetch, `main.js`의 `api:fetch`). 연결이 안 되면 진짜 이유(net::ERR_…)를 오류 글에 붙입니다.
- **문제 찾기**: 위쪽 막대의 ? 버튼은 앱이 아는 창과 주소, 최근 연결 오류를 클립보드에 복사합니다. 사이트 창에서 F12를 누르면 개발자 도구가 열립니다.
- **검수**: 패널에서 검수를 열면 패널이 창 전체로 넓어지고(시안 C), 돌아가기를 누르면 원래 배치로 돌아옵니다.
- **시작 모션**: 앱을 켤 때마다 확장의 시작 모션이 창 전체에서 재생되고(누르면 건너뜀, 확장은 하루 한 번), 끝나면 Silo가 왼쪽 위에 자리 잡습니다.
- **로그인**: 확장의 로그인·회원가입 화면이 떠 있는 동안(`body.auth-open`) 패널이 창 전체가 되고 사이트와 위쪽 막대는 숨겨집니다. 로그인해야 사이트가 보입니다.
- **사람마다 마이픽 로그인 따로**: 확장이 `chrome.storage.local`의 `activeProfileId`에 지금 로그인한 사람을 적으면, 사이트 쿠키도 그 사람 것으로 바뀝니다(`persist:mypick-<id>`). 앞사람이 열어 둔 편집 화면 창은 닫습니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `main.js` | 창 배치, 사이트 화면·팝업 관리, 확장이 부르는 크롬 기능의 실제 처리 |
| `preload-shim.js` | 패널·연습 페이지에만 들어가 `chrome.*`를 같은 이름으로 흉내 냄 (사이트 페이지에는 안 들어감) |
| `preload-ui.js`, `ui/` | 위쪽 막대, 가운데 막대 |
| `test/` | 가짜 마이픽 화면(`../tests/fixtures`)과 가짜 Claude 응답으로 하는 전체 흐름 테스트(`e2e.mjs`), 회원가입·로그인·사람마다 마이픽 로그인 테스트(`e2e-accounts.mjs`) |

| 확장에서 | 앱에서 |
|---|---|
| `chrome.scripting.executeScript({world:'MAIN', func, args})` | `webContents.executeJavaScript('(func)(...args)')` |
| `chrome.storage.local` | 앱 데이터 폴더의 `storage.json` |
| `chrome.storage.session` | 메모리 (앱을 닫으면 사라짐) |
| `chrome.storage.onChanged` | 같은 모양으로 알림 (`local`/`session`) |
| `chrome.tabs.*`, `chrome.windows.update` | 사이트 화면, 사이트가 연 창, 연습 페이지 창 |
| `chrome.runtime.sendMessage/onMessage` | 패널 ↔ 연습 페이지 |
| `chrome-extension://…` | `silo://ext/…` |

사이트로 보내는 브라우저 정보(UA)에서는 `Electron` 표시를 빼서 평범한 크롬처럼 보입니다. 최종 제출(`saveGo('complete')`)은 확장과 마찬가지로 부르지 않습니다.

확장이 새 크롬 기능을 쓰기 시작하면 `preload-shim.js`와 `main.js`에 같은 이름으로 추가해야 합니다.

## 개발

```
cd desktop
npm install
npm start               # 저장소의 ../extension 을 불러 실행
npm test                # 전체 흐름 + 계정 테스트 (Playwright 필요, 리눅스 서버에서는 xvfb-run -a npm test)
npm run dist:win        # dist/Silo-win32-x64 (Silo.exe), 확장 폴더는 resources/extension 으로 들어감
```

서명하지 않은 빌드라 처음 실행할 때 윈도가 “Windows의 PC 보호” 경고를 띄웁니다. **추가 정보 → 실행**을 누르면 열립니다.

## 아직 남은 것

- 실제 마이픽 사이트에서 로그인·편집하기 팝업 확인 (가짜 화면으로만 시험함)
- 설치 프로그램(NSIS)과 자동 업데이트, 코드 서명, 앱 아이콘(.ico)
- 안드로이드 태블릿 앱 (같은 구조로 WebView에 올리기)

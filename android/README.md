# Silo 태블릿 앱 (안드로이드)

모든 플랫폼이 같이 쓰는 앱 코드(`../app`)를 안드로이드 웹뷰 안에서 돌리는 태블릿 앱입니다. 데스크톱 앱과 같은 버전 번호(`desktop/package.json`의 version)를 쓰고, 같은 릴리스에 `Silo-<버전>.apk`로 올라갑니다.

## 화면

- **가로 고정**. 위쪽 줄: 뒤로, 새로고침, 열린 창 목록(마이픽 / 편집 화면 151쪽 ×), 패널 접기·펴기.
- **왼쪽**: 마이픽 사이트(PC 크롬처럼 접속). 사이트가 여는 창(편집 화면 등)은 따로 뜨지 않고 왼쪽 칸에 겹쳐 열립니다.
- **오른쪽**: Silo 패널(`app/sidepanel.html`). 화면 폭의 약 34%(360~520dp).
- 로그인 화면과 시작 모션 동안은 패널이 화면 전체입니다. 켤 때부터 바탕은 검정입니다.
- 손가락으로 쓰는 화면에서는 버튼·입력칸이 조금 커집니다(`app/sidepanel.css`의 `pointer: coarse`). 화면 키보드가 올라오면 화면이 줄어 입력칸이 가려지지 않습니다.
- 다른 사람이 이 태블릿에서 자기 Silo 계정으로 로그인하면, 앞사람의 마이픽 로그인(쿠키)을 지우고 마이픽 첫 화면을 다시 엽니다. 책 진행 기록은 Silo 계정마다 따로 저장됩니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `app/src/main/java/org/silo/tablet/MainActivity.kt` | 화면 배치, 사이트·팝업 웹뷰, 패널 웹뷰, 플랫폼 창구의 실제 처리 |
| `app/src/main/java/org/silo/tablet/Store.kt` | 창구 `storage.local`(앱 데이터 폴더의 `storage.json`) / `storage.session`(메모리) |
| `app/src/main/res/raw/silo_platform.js` | 패널 페이지가 시작되기 전에 넣는 `window.siloPlatform` (모양은 `app/lib/platform.js`) |

- 앱 코드는 APK의 assets로 들어가 `https://appassets.androidplatform.net/assets/`에서 열립니다(테스트 예시 쪽 이미지는 뺌).
- 편집 화면에서 함수 실행(`scripting.executeScript`): 바로 끝나는 함수는 곧바로 답하고, 기다려야 하는 함수는 결과를 그 페이지에 적어 두게 한 뒤 0.1초마다 확인합니다(안드로이드 웹뷰는 Promise를 기다려 주지 않음).
- 사이트 페이지에는 다리(`SiloNative`)도 창구도 들어가지 않습니다.

## 아직 없는 것 (다음 버전)

- 테스트 화면 (누르면 안내만 나옴)
- 앱 안 자동 업데이트: 지금은 새 버전이 나오면 [Releases](https://github.com/bonugg83-dev/Silo/releases/latest)에서 APK를 받아 설치합니다. 같은 서명 키라 덮어 설치되고 기록은 남습니다.

## 설치 (처음 한 번)

1. 태블릿에서 [Releases](https://github.com/bonugg83-dev/Silo/releases/latest)를 열고 `Silo-<버전>.apk`를 받습니다.
2. 받은 파일을 누르면 "출처를 알 수 없는 앱" 허용을 묻습니다. 브라우저(또는 내 파일)에 허용하고 설치합니다.

## 개발

```
cd android
echo "sdk.dir=/경로/android-sdk" > local.properties
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk (시험용 키)
./gradlew assembleRelease    # SILO_KEYSTORE_FILE·SILO_KEYSTORE_PASSWORD·SILO_KEY_ALIAS·SILO_KEY_PASSWORD 가 있으면 그 키로 서명
```

서명 키는 저장소에 두지 않습니다. GitHub Actions는 저장소 Secrets(`SILO_KEYSTORE_B64` 등)로 서명하고, 비밀 값이 없으면 시험용 키로 만들어 Releases에는 올리지 않습니다. **키를 잃으면 이후 업데이트를 덮어 설치할 수 없으니 따로 보관하세요.**

창구 다리(`silo_platform.js`)는 `npm test`의 `tests/android-platform.test.js`가 가짜 안드로이드 쪽으로 시험합니다.

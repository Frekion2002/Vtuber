# Ubuntu Setup Checklist

> 작성일: 2026-04-22
> 대상: Ubuntu 24.04 LTS (현재 사용자 환경)
> `DESKTOP_SETUP.md`(Windows)와 짝을 이루는 Linux 버전. 위→아래 순서 유지.

---

## 0. 현재 환경 선조사 결과 (2026-04-22 스냅샷)

| 도구 | 상태 |
|---|---|
| `git` | ✅ 2.43.0 |
| `node` | ✅ v22.22.2 |
| `pnpm` | ✅ 10.33.0 |
| `curl` | ✅ 8.5.0 |
| `bun` | ❌ 미설치 |
| `GEMINI_API_KEY` | ❌ 미설정 |
| Ubuntu | 24.04.4 LTS |

→ 실제로 해야 할 것은 **Bun 설치** + **API 키 등록** + **airi clone/실행**. Node/pnpm/git은 건너뜀.

---

## 1. Bun 설치 (프록시 런타임)

### 1.1 설치
```bash
curl -fsSL https://bun.sh/install | bash
```

설치 스크립트가 `~/.bun/bin`에 바이너리를 놓고 `~/.bashrc`에 PATH 라인을 추가함.

### 1.2 현재 쉘에 PATH 반영
```bash
source ~/.bashrc
```
(또는 터미널 재시작)

### 1.3 검증
```bash
bun --version
```

**기대 출력** — 버전 번호 한 줄 (예: `1.1.38`)

---

## 2. Gemini API 키 발급 + 환경변수

### 2.1 키 발급
1. https://aistudio.google.com/apikey 접속 (Google 계정 로그인)
2. **Create API key** → 새 프로젝트 or 기존 프로젝트 선택
3. 키 복사 (`AIza...` 형태, 39자)

> **Tier 1 승급 (권장)**: 무료 Tier 0은 10 RPM → 금방 429 터짐. Google Cloud 프로젝트에 Billing 연결하면 자동 Tier 1(150 RPM) 승급. 10분 내 완료.

### 2.2 영구 환경변수 등록 (`~/.bashrc`)
```bash
echo 'export GEMINI_API_KEY="AIza...여기에_붙여넣기..."' >> ~/.bashrc
source ~/.bashrc
```

### 2.3 검증
```bash
echo "key length: ${#GEMINI_API_KEY}"
```

**기대 출력** — `key length: 39` (Gemini 키는 통상 39자)

---

## 3. airi 저장소 clone

```bash
cd ~/Airi
git clone https://github.com/moeru-ai/airi.git
```

**기대 결과** — `~/Airi/airi/` 폴더 생성. 최종 디렉터리 구조:
```
~/Airi/
├── airi/                    ← 새로 clone됨
├── proxy/
├── PROJECT_SPEC.md
├── DESKTOP_SETUP.md
├── LINUX_SETUP.md (이 파일)
└── CHARACTER_BIBLE_TEMPLATE.md
```

검증:
```bash
ls ~/Airi/airi/package.json && echo OK
```

---

## 4. 프록시 단독 기동 · 헬스체크

### 4.1 의존성 설치 + 기동 (**터미널 A**)
```bash
cd ~/Airi/proxy
bun install
bun run start
```

**기대 출력**
```
Priority proxy listening on http://localhost:3100
```

→ 이 터미널은 프록시가 떠있는 동안 계속 열어둘 것.

### 4.2 헬스체크 (**터미널 B — 새 창**)
```bash
curl http://localhost:3100/health
```

**기대 응답**
```json
{"ok":true,"queues":{"P0":0,"P1":0,"P2":0,"P3":0}}
```

### 4.3 프록시 직접 호출 테스트 (airi 없이)
```bash
curl -X POST http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Priority: P1" \
  -d '{"messages":[{"role":"user","content":"안녕"}]}'
```

**기대**: 200 OK + assistant 메시지 JSON. 400/401이면 → Section 8 참조.

---

## 5. airi 빌드 · 실행

> **권장**: 처음엔 **브라우저 버전(`pnpm dev`)** 부터. Tauri 데스크톱(`pnpm dev:tamagotchi`)은 Linux에서 추가 시스템 라이브러리(webkit2gtk 등) 필요해서 뒤로 미룸.

### 5.1 의존성 설치 (**터미널 C**)
```bash
cd ~/Airi/airi
pnpm i
```

첫 설치 몇 분 소요. 경고 메시지는 무시 가능. 에러로 중단되면 Section 9 참조.

### 5.2 웹 버전 실행
```bash
pnpm dev
```

**기대 출력** — `http://localhost:XXXX` (보통 5173 또는 3000) 로컬 URL 표시.
브라우저에서 해당 URL 열기.

### 5.3 (선택) Tauri 데스크톱 실행 — Linux 의존성 필요
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

cd ~/Airi/airi
pnpm dev:tamagotchi
```

---

## 6. airi Settings 연결

airi 앱(브라우저 or Tauri 창) → **Settings** → **Providers** → **Chat** → **Google Gemini** 선택

| 필드 | 값 |
|---|---|
| baseURL | `http://localhost:3100/v1` |
| API Key | 빈 칸 또는 아무 문자열 (프록시가 Bearer 주입하므로 실제 키는 `GEMINI_API_KEY` 환경변수에서 읽힘) |
| Model | `gemini-2.5-flash` |

저장 후 채팅창으로 이동.

---

## 7. 검증 시나리오

### 7.1 정상 경로
airi 채팅에 "안녕, 자기소개 해봐" 입력 → 응답 수신.
**터미널 A**(프록시)에 요청 로그가 찍히는지 확인.

### 7.2 429 폴백 테스트 (Tier 0 상태에서)
10~15초 내에 메시지 10회 연타:
- Flash 429 발생 → 프록시가 자동으로 Flash-Lite로 재시도
- 응답 JSON의 `model` 필드에서 `gemini-2.5-flash-lite` 확인

### 7.3 우선순위 헤더 (선택)
`X-Priority: P0` 붙여 curl 호출 → 큐에서 먼저 처리되는지 확인.

---

## 8. 남은 TODO (이동 후 실제 호출하면서 검증)

| TODO | 확인 방법 | 실패 시 조치 |
|---|---|---|
| **Gemini OpenAI-compat 인증 방식** | Section 4.3 curl에서 200 OK 나는지 | 401/400이면 `priority-proxy.ts`에서 `Authorization: Bearer` → query param `?key=` 방식으로 교체 |
| **SSE 스트리밍 중계** | airi 응답이 토큰 단위로 흘러나오는지 | 한 번에 나오면 `new Response(upstream.body, ...)` 부분을 `ReadableStream` 수동 중계로 변경 |
| **5xx 지수 백오프** | 재현 어려움 (Gemini 서버 오류 시) | 우선순위 낮음 |

---

## 9. 빠른 실패 진단 (Ubuntu)

| 증상 | 확인 |
|---|---|
| `bun: command not found` (설치 직후) | `source ~/.bashrc` 또는 터미널 재시작 |
| `bun install` 네트워크 오류 | `curl https://registry.npmjs.org` 로 프록시/방화벽 확인 |
| `pnpm i` 에서 `EACCES` | `~/.pnpm-store` 권한 확인. `sudo` 쓰지 말 것 |
| Tauri 빌드 실패 (`webkit2gtk`) | Section 5.3 의존성 설치 필요. Ubuntu 24.04는 `4.1` (`4.0`이 아님) |
| airi 연결 시 무한 로딩 | 프록시 헬스체크(Section 4.2)부터. 프록시 안 떠 있으면 그게 원인 |
| `401 Unauthorized` | `echo $GEMINI_API_KEY` 비어있거나 Tier 1 미승급 |
| `429 Too Many Requests` (Tier 1인데도) | Section 4.3 curl로 쿼터 직접 확인, 없어지면 RPM 한계 도달 |

---

## 10. 다음 작업 (셋업 완료 후)

- airi에서 `X-Priority` 헤더를 어떻게 주입할지 경로 조사 (`onBeforeSend` 훅 or provider 설정)
- Filler wav 10~20개 생성 (ElevenLabs 무료/Pro) → `~/Airi/fillers/`
- `CHARACTER_BIBLE_TEMPLATE.md` 채워서 페르소나 Card 변환
- OBS 캡처 세팅 (airi 창 → 윈도우 캡처)

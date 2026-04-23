# Desktop Migration Setup Checklist

> 작성일: 2026-04-22
> 노트북 → 데스크톱 이동 후 수행 순서. 위→아래 순서 유지 권장.

---

## 0. 폴더 이동

USB / OneDrive / 구글드라이브 중 하나로 `Desktop/Airi/` 전체 복사 (현재 ~50KB).

**복사 대상**
- `CHARACTER_BIBLE_TEMPLATE.md`
- `PROJECT_SPEC.md`
- `DESKTOP_SETUP.md` (이 문서)
- `proxy/priority-proxy.ts`
- `proxy/package.json`

`node_modules/`는 복사 불필요 (데스크톱에서 `bun install` 시 생성됨).

---

## 1. 런타임 설치

### 1.1 Git
```powershell
git --version   # 없으면 아래
winget install Git.Git
```

### 1.2 Bun (프록시 런타임)
```powershell
# 방법 A — 공식 스크립트
irm bun.sh/install.ps1 | iex

# 방법 B — winget
winget install Oven-sh.Bun

bun --version
```

### 1.3 Node.js + pnpm (airi 빌드용)
```powershell
winget install OpenJS.NodeJS.LTS
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

---

## 2. airi 소스 clone

```powershell
cd $env:USERPROFILE\Desktop\Airi
git clone https://github.com/moeru-ai/airi.git
```

→ 최종 구조: `Desktop/Airi/airi/`

---

## 3. Gemini API 키 환경변수

**영구 설정 (권장)**
Windows 시스템 환경변수 GUI → 사용자 변수 → 새로 만들기
- 이름: `GEMINI_API_KEY`
- 값: `AIza...` (발급받은 키)

**또는 세션용 (PowerShell 창 닫으면 사라짐)**
```powershell
$env:GEMINI_API_KEY = "AIza..."
```

**Gemini Tier 1 미승급 상태라면 이 시점에 함께 진행** — Cloud Billing 연결, 10분 내. 안 하면 무료 티어 10 RPM 제한에 걸려 429가 금방 터짐.

---

## 4. 프록시 단독 기동 · 헬스체크

```powershell
cd $env:USERPROFILE\Desktop\Airi\proxy
bun install
bun run start
# → "Priority proxy listening on http://localhost:3100"
```

**별도 PowerShell 창**에서 헬스체크:
```powershell
curl http://localhost:3100/health
```

기대 응답:
```json
{"ok":true,"queues":{"P0":0,"P1":0,"P2":0,"P3":0}}
```

**프록시 직접 호출 테스트** (airi 없이):
```powershell
curl -X POST http://localhost:3100/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Priority: P1" `
  -d '{"messages":[{"role":"user","content":"안녕"}]}'
```

200 OK + assistant 메시지가 오면 정상. 400/401이면 → Section 8 참조.

---

## 5. airi 빌드 · 실행

```powershell
cd ..\airi
pnpm i
pnpm dev:tamagotchi   # 데스크톱 Tauri 앱
# 또는 pnpm dev (브라우저)
```

초기 `pnpm i`는 몇 분 소요. 성공하면 Tauri 창이 뜸.

---

## 6. airi Settings 연결

airi 앱 → Settings → Providers → Chat → Google Gemini (UI 명칭은 airi 버전에 따라 다를 수 있음)

- **baseURL**: `http://localhost:3100/v1`
- **API Key**: 빈 칸 또는 아무 값 (프록시가 Bearer 주입하므로 실제 키는 환경변수만 사용)
- **Model**: `gemini-2.5-flash`

저장 후 채팅 창으로 이동.

---

## 7. 검증 시나리오

### 7.1 정상 경로
airi에서 "안녕, 자기소개 해봐" 한 줄 → 응답 수신.
프록시 로그에 요청 표시되는지 확인.

### 7.2 429 폴백 테스트
Gemini Tier 0(10 RPM) 상태라면 10~15초 내에 10회 연타:
- Flash 429 발생 → 프록시가 자동으로 Flash-Lite로 재시도
- 프록시 로그/응답에서 `model=gemini-2.5-flash-lite` 확인

### 7.3 우선순위 주입 (선택)
curl로 `X-Priority: P0` 헤더 붙여 직접 호출 → 큐에서 먼저 처리되는지 확인.

---

## 8. 남은 TODO (이동 후 실제 호출하면서 검증)

| TODO | 확인 방법 | 실패 시 조치 |
|---|---|---|
| **Gemini OpenAI-compat 인증 방식** | 4번 curl 테스트에서 200 OK 나는지 | 401/400이면 `priority-proxy.ts`에서 `Authorization: Bearer` → query param `?key=` 방식으로 교체 |
| **SSE 스트리밍 중계** | airi 응답이 토큰 단위로 흘러나오는지 | 한 번에 나오면 `new Response(upstream.body, ...)` 부분을 `ReadableStream` 수동 중계로 변경 |
| **5xx 지수 백오프** | 재현 어려움 (Gemini 서버 오류 시) | 우선순위 낮음. optional |

---

## 9. 다음 작업 (실행 검증 완료 후)

- airi에서 `X-Priority` 헤더를 어떻게 주입할지 경로 조사 (훅 또는 provider 설정 커스터마이징)
- Filler wav 10~20개 생성 (ElevenLabs 무료/Pro로) → `Desktop/Airi/fillers/` 저장
- CHARACTER_BIBLE 도착 시 페르소나 Card 작성 (moeru-ai/deck 포맷)
- OBS 캡처 세팅 테스트 (airi Tauri 창 → 크로마키 또는 윈도우 캡처)

---

## 참고 — 빠른 실패 진단

| 증상 | 확인 |
|---|---|
| `bun install` 실패 | Node 버전 18+ 확인, 네트워크 프록시 여부 |
| 프록시 기동 시 `Bun is not defined` | Bun이 아닌 Node로 실행된 것. `bun run` 사용 |
| airi `pnpm i` 실패 | pnpm-workspace 인식 실패 — airi 루트에서 실행했는지 확인 |
| airi 연결 시 무한 로딩 | 프록시 헬스체크부터. 프록시 안 떠 있으면 그게 원인 |
| 401 Unauthorized | `$env:GEMINI_API_KEY` 비어있거나 Bearer 포맷 불일치 (Section 8 1번 조치) |

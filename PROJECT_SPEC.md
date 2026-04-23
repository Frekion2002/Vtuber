# AI 버튜버 프로젝트 설계 문서

> 작성일: 2026-04-18
> 설계 과정 전체 기록 (Claude와의 대화 정리)

---

## 1. 프로젝트 개요

- **목표**: AI 버튜버 제작 및 데뷔
- **프레임워크**: [moeru-ai/airi](https://github.com/moeru-ai/airi) (오픈소스, MIT)
- **기본 전략**: 2단계 단계적 투자 — API 기반 MVP → 로컬 하이브리드
- **전략 근거**: 초기부터 로컬 GPU·커스텀 파인튜닝·자체 에셋 전부 투자하면 데뷔 반응 검증 전 회수 불가 리스크. API로 먼저 돌려 컨셉·대화 톤·캐릭터 반응을 검증한 뒤, 수요가 붙으면 비용 절감·개성 확보·프라이버시 순으로 로컬 전환.

---

## 2. airi 프레임워크 조사 결과

### 2.1 내장 기능 (README 체크박스 기준)

**Brain (두뇌)**
- [x] Minecraft 플레이
- [x] Factorio 플레이 (PoC 단계)
- [x] Kerbal Space Program
- [ ] Helldivers 2 협동 (WIP)
- [x] Telegram / Discord 채팅
- [x] 브라우저 내장 DB (DuckDB WASM / pglite)
- [ ] Memory Alaya 장기기억 (WIP)
- [ ] 완전 브라우저 내장 WebGPU 로컬 추론 (WIP)

**Ears (귀)** — 브라우저/Discord 오디오 입력, 클라이언트 STT, 발화 감지(VAD) 구현됨

**Mouth (입)** — ElevenLabs TTS만 공식 지원

**Body (몸)** — VRM / Live2D + 자동 눈 깜빡임·시선 추적·idle 움직임 구현됨

### 2.2 지원 LLM 프로바이더 (xsai 경유, 28종+)

OpenAI, Azure OpenAI, Anthropic Claude, Google Gemini, DeepSeek, xAI, Groq, Mistral, Ollama(로컬), vLLM, SGLang, AIHubMix, OpenRouter, 302.AI, Cloudflare Workers AI, Together.ai, Fireworks.ai, Novita, Qwen, Zhipu, SiliconFlow, Stepfun, Baichuan, Minimax, Moonshot AI, ModelScope, Player2, Tencent Cloud 등

### 2.3 설치 & 실행

**Windows (Scoop):**
```powershell
scoop bucket add airi https://github.com/moeru-ai/airi
scoop install airi/airi
```

**개발/소스 빌드:**
```bash
pnpm i
pnpm dev              # 웹 (브라우저)
pnpm dev:tamagotchi   # 데스크톱 앱 (Tauri)
pnpm dev:pocket:ios   # 모바일
```

**Nix 한 줄 실행:** `nix run github:moeru-ai/airi`

### 2.4 기본 제공 캐릭터 모델

- **Live2D 2종 + VRM 2종** 번들 (공식 매뉴얼 기준)
- 확인된 Live2D 기본 모델: **Hiyori Free (zh)** — Live2D Inc. 공개 샘플
- VRM idle 애니메이션(`idle_loop.vrma`) 직접 번들
- 소스 repo엔 모델 본체 파일은 `.gitignore`로 제외 (`**/assets/live2d/models/*`, `**/assets/vrm/models/*`). 배포 바이너리에는 포함됨
- **⚠ 중요**: 기본 Hiyori는 Live2D Inc. 라이선스상 **상업 스트리밍 부적합** → 데뷔엔 반드시 자체/허가 모델 사용

### 2.5 시스템 요구사항

공식 문서에 **명시된 최소 사양 없음**. 실제 부담은 선택한 백엔드에 따라 갈림:

| 구성 | 부담 원천 |
|---|---|
| LLM = API (OpenAI/Claude/Gemini) | 거의 없음. 일반 노트북으로 충분 |
| LLM = Ollama 로컬 (7B~14B) | VRAM 8~16GB GPU, RAM 16~32GB |
| TTS/STT 로컬 | 모델 몇 GB 디스크, GPU 여유분 |
| 3D 렌더링 | WebGPU 지원 GPU (최근 5년 내 거의 모든 GPU) |

**실전 기준선 추정** (airi 공식 수치 아님): RTX 3060 12GB 이상 + RAM 32GB + SSD 50GB

---

## 3. 인프라 전략

### 3.1 왜 학교 A100 MIG 서버가 MVP엔 불필요한가

airi는 구조상 다음처럼 쪼개짐:

| 구성요소 | 어디서 돌아야 하나 |
|---|---|
| Stage UI (Live2D/VRM 렌더, 눈 깜빡임, 립싱크) | **로컬 PC** — WebGPU 클라이언트 렌더 |
| STT / VAD (마이크) | **로컬 PC** (마이크가 물린 곳) |
| TTS 재생 (스피커) | **로컬 PC** (OBS 캡처용) |
| LLM 추론 | 어디든 OK — 여기만 서버 활용 가능 |

데뷔는 **로컬 PC → OBS → 방송 플랫폼** 경로 필수. MVP 단계에선 LLM도 API로 쓰니 서버 전혀 불필요.

### 3.2 2단계(하이브리드) 시 권장 구성

```
[로컬 PC]                                  [학교 A100 MIG 서버]
 airi Tamagotchi / stage-web                Ollama or vLLM
 ├─ Live2D/VRM 렌더                         └─ OpenAI-compatible
 ├─ 마이크 → STT                                endpoint 노출
 ├─ TTS → OBS 캡처       ── LAN/VPN ──►      (LLM 추론만)
 └─ LLM 호출
```

**확인 필요:**
- MIG 슬라이스 프로필 (`nvidia-smi`) — 1g.10gb면 7B 양자화, 3g.40gb면 32B~70B 여유
- 학내 AUP가 연구 외 24/7 서빙 허용하는지
- egress 제약은 서버가 서빙하는 방향(ingress)엔 무관

---

## 4. LLM 선택

### 4.1 최종 선택: Gemini 2.5 Flash (MVP)

**2026-04 기준 Gemini 무료 티어:**

| 모델 | RPM | 일일 RPD | 비고 |
|---|---|---|---|
| Gemini 2.5 Pro | — | — | 2026-04-01부터 무료 티어 제외 |
| **Gemini 2.5 Flash** | 10 | 250 | MVP 메인 |
| Gemini 2.5 Flash-Lite | 15 | 1,000 | 요청량 많을 때 |
| Gemini 3 / 3.1 Flash-Lite (preview) | 제한적 | 제한적 | 더 신형이지만 쿼터 빡빡 |

공통: 250K TPM, 1M 토큰 컨텍스트

### 4.2 왜 gemini-2.0-flash를 피하는가

- **2026-06-01 deprecation 예정**. 새 프로젝트 시작 시점에 2개월 뒤 죽는 모델 쓰면 마이그레이션 비용만 발생
- 공식 권장: 2.5 Flash 또는 3 Flash로 이전

### 4.3 방송 부하 시 단계별 전환

1. 개발·페르소나 튜닝: `gemini-2.5-flash` 무료
2. 테스트 방송: `gemini-2.5-flash-lite` 무료 (1000 RPD 여유) 또는 유료
3. 실제 데뷔: 유료 필수 (100만 토큰당 몇 달러 수준, 크지 않음)

### 4.4 주의사항

- **무료 티어는 데이터 학습에 사용될 가능성** → 페르소나 IP 민감하면 MVP 단계라도 유료
- xsai 경유라 나중에 Claude/OpenAI로 스왑 쉬움. 초반부터 여러 키 등록해두고 A/B 추천

### 4.5 쿼터 대응 & 429 핸들링 아키텍처 (2026-04-22 확정)

#### 4.5.1 조사 결과 (airi / xsai 소스 웹 리딩)

| 파일 | 발견 | 의미 |
|---|---|---|
| `airi/packages/stage-pages/src/pages/settings/providers/chat/[providerId].vue` | `ProviderBaseUrlInput` 컴포넌트, Pinia store `providers[providerId].baseUrl` | **사용자가 UI에서 baseURL 편집 가능** → airi 포크 불필요 |
| `xsai/packages/shared-chat/src/utils/chat.ts` | `POST {baseURL}/chat/completions` (OpenAI 표준 페이로드) | 프록시를 **OpenAI 호환 서버**로 만들면 airi 그대로 동작 |
| `xsai/packages/shared/src/error/index.ts` | `APICallError`에 `statusCode` / `responseHeaders` / `response` 노출 | 429 판별 · `Retry-After` 읽기 가능 |
| `airi/packages/core-agent/src/runtime/agent-hooks.ts` | 10개 훅 — `onBeforeSend` / `onAfterSend` / `onAssistantMessage` 등만 존재, **`onError` 없음** | airi 내부 훅으로 429 폴백 구현 불가 → 프록시 레이어에서 처리 |
| Gemini 공식 | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | OpenAI 호환 엔드포인트 제공 (upstream으로 활용) |

#### 4.5.2 판정: 미들웨어 프록시 (포크 불필요)

airi를 건드리지 않고 Gemini provider baseURL만 프록시 주소로 바꿔서 연결. 프록시가 OpenAI 호환 서버로 작동하며 내부에서 **우선순위 큐 · 429 폴백 · `Retry-After` 존중**을 처리.

#### 4.5.3 역할 분담

**airi 측 (수정 無)**
- Settings UI에서 Gemini baseURL = `http://localhost:3100/v1`
- `onBeforeSend` 훅: 우선순위 라벨을 `X-Priority` 헤더로 주입
- `onAssistantMessage` 훅: TTS 재생 트리거
- 클라이언트 타이머: 1.5초 지연 감지 시 filler wav 즉시 재생

**프록시 측 (Bun/Node 단일 파일, ~200줄)**
- `POST /v1/chat/completions` 엔드포인트
- 우선순위 큐 (P0 도네 / P1 멘션 / P2 일반 / P3 idle)
- Flash 호출 → 429 catch → Flash-Lite 폴백
- `Retry-After` 헤더 존중
- 5xx 지수 백오프

#### 4.5.4 데이터 플로우

```
[airi UI] ──(X-Priority 헤더)──> [프록시 localhost:3100]
                                    ├─ 우선순위 큐 삽입
                                    ├─ RPM 슬롯 관리 (Tier 1: 150 RPM)
                                    ├─ Flash 호출
                                    │   ├─ 200 → 중계
                                    │   ├─ 429 → Flash-Lite 재시도
                                    │   └─ 5xx → 지수 백오프
                                    └─> Gemini OpenAI-compat
```

#### 4.5.5 장점

- airi 원본 건드리지 않음 → 업데이트 수신 시 merge 충돌 無
- 프록시 프로세스 끄면 즉시 원복
- Phase 2에서 학교 A100 서버로 전환 시 baseURL만 다시 스왑

#### 4.5.6 스켈레톤 위치

`C:\Users\aqtg6\Desktop\Airi\proxy\priority-proxy.ts` (+ `package.json`) — 2026-04-22 노트북에서 작성. 데스크톱 이동 후 `bun install && bun run priority-proxy.ts`로 실행 검증.

---

## 5. TTS 전략

### 5.1 MVP: ElevenLabs (airi 네이티브)

- airi의 unspeech 프록시가 OpenAI, Azure, Deepgram, Alibaba CosyVoice, Volcano, ElevenLabs, Koemotion 지원
- ElevenLabs가 가장 매끄럽게 붙음. 무료 티어도 있음

### 5.2 본 데뷔: GPT-SoVITS v4 (성우 보이스 클론)

**평가 (2026-04 기준):**

| 항목 | 상태 |
|---|---|
| 최신 버전 | **v4** (48kHz 네이티브, v3 금속성 아티팩트 수정) |
| 한국어 | ✅ 네이티브 지원 (EN/JA/KO/ZH/Cantonese) |
| 필요 데이터 | 1분으로 zero-shot, 파인튜닝하면 훌륭 |
| 속도 | RTF 0.014 (RTX 4090), 0.028 (4060Ti) — 실시간 초과 여유 |
| 라이선스 | 모델 코드 MIT. 성우 음성 저작권은 별도 계약 |

### 5.3 airi 연동 방법 (공식 미지원)

airi의 unspeech는 GPT-SoVITS 네이티브 미지원 → 다음 중 택일:

1. **OpenAI 호환 래퍼** (추천) — `openedai-speech` 같은 래퍼로 SoVITS를 OpenAI `/v1/audio/speech` 엔드포인트로 노출 → airi에서 OpenAI TTS 선택하고 base_url만 교체
2. unspeech에 프로바이더 직접 추가 (Go 포크)
3. airi 포크해서 TTS 훅 직접 연결

### 5.4 사전 체크사항

1. **실시간 지연**: RTF는 배치 기준. 버튜버는 **첫 청크 지연**이 중요. 스트리밍 모드·1초 이하 체감 여부 테스트 필수
2. **성우 계약서**: "AI 음성합성 학습 및 상업 방송 이용" 명시 필수
3. **GPU 경합**: 로컬 PC에서 Live2D 렌더 + OBS 인코딩 + SoVITS 추론 경합 — 2단계에서 SoVITS만 학교 서버로 분리 고려
4. **Gemini 쿼터와 TTS는 독립** — 별개 계산

---

## 6. 페르소나 설계

### 6.1 4개 레버 (우선순위 순)

| 레벨 | 수단 | 난이도 | 효과 |
|---|---|---|---|
| 1 | 시스템 프롬프트 + Few-shot 예시 (15~20개) | ⭐ | 80% 해결 |
| 2 | airi Character Card 시스템 (GUI) | ⭐ | 구조화된 관리 |
| 3 | RAG / 장기기억 (airi DuckDB) | ⭐⭐ | 세계관·팬 상호작용 |
| 4 | 파인튜닝 (Vertex AI 또는 로컬 LoRA) | ⭐⭐⭐ | 말투·캐치프레이즈 일관성 |

**파인튜닝이 값어치 하는 시점**: 프롬프트로 95점까지 왔는데 캐치프레이즈·특유 어미·성우 이름 호출 등 일관성이 안 나올 때. MVP에선 과투자. Gemini 2.5 Flash는 Vertex AI에서 **몇 달러 수준**부터 가능하니 절대 안 어려움.

### 6.2 Live2D/VRM 제어는 파인튜닝 문제가 아님

**Structured output / function calling** 문제:
```json
{
  "reply": "헤헤 진짜? 고마워!",
  "emotion": "happy",
  "motion": "wave"
}
```
Gemini 2.5 Flash의 JSON mode로 강제 → airi가 파싱 → Live2D 파라미터 매핑

### 6.3 활용할 리소스 (이 순서로)

1. **[moeru-ai/deck](https://github.com/moeru-ai/deck)** — airi 제작사의 Character Card Deck (SillyTavern 호환). airi와 가장 매끄럽게 연동 ⭐
2. **[SillyTavern Character Card V3 스펙](https://github.com/kwaroran/character-card-spec-v3)** — 업계 표준
3. **[TavernQuill](https://github.com/hockey323/TavernQuill)** — V3 카드 GUI 편집기
4. **[sphiratrioth666/Character_Generation_Templates (HF)](https://huggingface.co/sphiratrioth666/Character_Generation_Templates)** — 페르소나 프롬프트 템플릿 모음
5. **[awesome-llm-role-playing-with-persona](https://github.com/Neph0s/awesome-llm-role-playing-with-persona)** — 롤플레이 연구 큐레이티드 리스트

### 6.4 핵심 논문

- **[PCL — Persona-Aware Contrastive Learning (ACL 2025 Findings)](https://aclanthology.org/2025.findings-acl.1344.pdf)** — 핵심 insight: *"역할 시켜놓기만 하면 캐릭터 유지 안 된다"*. self-questioning chain으로 보정. 파인튜닝 방법론이지만 프롬프팅에도 응용 가능 (응답 전 "이 응답이 캐릭터 X의 성격과 일치하는가?" self-check 체인 삽입)
- **[Two Tales of Persona in LLMs (EMNLP 2024 Findings)](https://aclanthology.org/2024.findings-emnlp.969.pdf)** — 서베이. persona의 두 의미(롤플레이 vs 자기표현) 구분

### 6.5 카드 내부 포맷 (참고)

- **W++**: `[name("Airi") age("17") personality("cheerful"+"curious")]` 속성-값
- **plist**: `[Airi's personality= shy, kind; Airi's likes= ...]`
- **자연어 bible**: 문장으로 기술

→ 최신 모델(Gemini 2.5+, Claude, GPT-4급)엔 **자연어 bible + 예시 대화 10~20개**가 실측 효과 가장 좋음

### 6.6 캐릭터 Bible 구성 요소

- 이름, 나이, 세계관
- 성격 특성 5~10개
- 말투 규칙 (어미, 호칭, 금지어)
- 예시 대화 15~20개 (인사/기쁨/당황/화남/팬 상호작용)
- Live2D 감정 태그 규칙 (happy/sad/angry/surprised)

### 6.7 출처 필터링

- Chub.ai / aicharactercards.com 같은 카드 허브는 NSFW 비중 높고 라이선스 애매 → 참고 시 주의
- 캐릭터 카드는 저작권 있음 — 유명 캐릭터 페르소나 카드 그대로 데뷔용 사용 시 IP 문제

---

## 7. 작업 로드맵

```
[Phase 0] 세팅 (1~2일)
 └─ airi Tamagotchi 또는 웹 버전 로컬 실행
 └─ Gemini 2.5 Flash API 키 발급 + airi에 연결
 └─ ElevenLabs 계정 + 기본 보이스 연결
 └─ 기본 번들 캐릭터로 동작 확인

[Phase 1] 페르소나 MVP (2~4주)
 └─ moeru-ai/deck 구조 학습
 └─ 캐릭터 Bible 초안 + 예시 대화 20개 작성
 └─ TavernQuill로 V3 카드 생성 → airi import
 └─ 20~30개 시나리오로 일관성 테스트
 └─ structured output으로 Live2D 감정 연동

[Phase 1.5] 자체 에셋 제작 (Phase 1과 병행 가능)
 └─ 성우 섭외·계약·녹음
 └─ VRM/Live2D 모델 제작 또는 외주
 └─ GPT-SoVITS v4 학습 (로컬 GPU 또는 학교 서버)

[Phase 2] 테스트 방송
 └─ OBS 세팅, 자체 모델 + SoVITS TTS 교체
 └─ 비공개 방송 테스트 → 지연·일관성·발화 품질 검증

[Phase 3] 데뷔 + 관찰
 └─ 시청자 반응 수집, API 비용·RPM 한도 모니터링

[Phase 4] 하이브리드 전환 (조건부)
 └─ 월 API 비용 > GPU 감가상각 OR 지연 이슈 OR 커스텀 파인튜닝 필요
 └─ 학교 A100 서버에 vLLM/Ollama 배치
 └─ airi endpoint 교체
```

---

## 8. 리스크 체크리스트

| 리스크 | 대응 |
|---|---|
| 번들 Hiyori 모델 Live2D Inc. 라이선스 (상업방송 불가) | 데뷔 본방엔 반드시 자체/허가 모델 |
| Gemini 무료 티어 데이터 학습 활용 | 페르소나 IP 민감 시 유료 전환 |
| GPT-SoVITS 실시간 지연 (첫 청크) | 사전 테스트 필수 (1초 이하 목표) |
| 성우 음성 AI 학습·상업방송 권한 | 계약서 명시 |
| airi가 early stage → 브레이킹 체인지 | 포크 브랜치에서 작업 |
| 로컬 PC GPU 경합 (렌더+OBS+SoVITS) | 2단계에서 SoVITS는 학교 서버로 분리 |
| 학교 서버 AUP — 연구 외 24/7 서빙 | 투입 전 허용 여부 확인 |

---

## 9. 오픈 이슈 / 다음 작업

- [ ] airi를 어디에 clone 할지 결정 (현재 `Desktop/Airi/` 폴더는 이 문서만 있음)
- [ ] Desktop에 있는 `Open-LLM-VTuber` 폴더 — 대안 프레임워크 비교 검토 필요 여부 결정
- [ ] Gemini API 키 발급
- [ ] 캐릭터 컨셉 초안 (이름·세계관·성격 방향)
- [ ] 성우 섭외 계획 (Phase 1.5 진입 전 확정)

---

## 10. 참고 링크

### 프레임워크 & 도구
- [moeru-ai/airi](https://github.com/moeru-ai/airi)
- [airi 공식 문서](https://airi.moeru.ai)
- [moeru-ai/unspeech](https://github.com/moeru-ai/unspeech) (TTS 프록시)
- [moeru-ai/deck](https://github.com/moeru-ai/deck) (Character Card)
- [xsai](https://github.com/moeru-ai/xsai) (LLM SDK)

### TTS
- [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
- [GPT-SoVITS v3/v4 features wiki](https://github.com/RVC-Boss/GPT-SoVITS/wiki/GPT%E2%80%90SoVITS%E2%80%90v3v4%E2%80%90features-(%E6%96%B0%E7%89%B9%E6%80%A7))

### 페르소나 & 캐릭터 카드
- [character-card-spec-v3](https://github.com/kwaroran/character-card-spec-v3)
- [TavernQuill](https://github.com/hockey323/TavernQuill)
- [awesome-llm-role-playing-with-persona](https://github.com/Neph0s/awesome-llm-role-playing-with-persona)

### LLM API
- [Gemini API 공식 문서](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing)
- [Vertex AI 파인튜닝](https://cloud.google.com/vertex-ai/generative-ai/pricing)

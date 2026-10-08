# 축제 실시간 단답형 퀴즈 — 시험 버전 (문제 3개)

학교 축제에서 학생·교사 약 500명이 각자 휴대폰(LTE·5G)으로 QR/URL 접속해 참여하는 실시간 단답형 퀴즈입니다.
문제는 무대 전광판에만 나오고, 휴대폰에는 문제 번호·남은 시간·입력 칸·제출 버튼·접수 상태만 나옵니다.
채점과 집계는 서버에서만 하며, 정답·정답자·전체 집계는 학생에게 보내지 않습니다.

- **스택**: React + TypeScript + Vite / Cloudflare Workers(Static Assets) / Durable Objects(SQLite·WebSocket Hibernation·Alarm) / Wrangler / Vitest
- 외부 DB·Redis·Firebase·D1·R2 없음. 상시 실행 Node 서버·Socket.IO 없음.

| 화면 | 주소 | 권한 |
|---|---|---|
| 참가자(휴대폰) | `/` (QR: `/?e=행사코드`) | 행사 코드 + 개인 참가 코드 |
| 진행자 | `/host` | 진행자 비밀번호 (Wrangler secret) |
| 전광판(16:9) | `/board` | 진행자가 발급한 전광판 링크(읽기 전용) |

## 빠른 시작 (로컬)

```bash
npm install
```
```bash
cp .dev.vars.example .dev.vars
```
`.dev.vars` 의 `HOST_PASSWORD`·`SESSION_SECRET` 을 바꾼 뒤:
```bash
npm run dev
```
→ http://127.0.0.1:8787/host 로그인 → 새 행사 → 참가 코드 생성·CSV → 전광판 링크 발급 → 휴대폰 화면은 `http://127.0.0.1:8787/?e=행사코드`.
같은 와이파이의 휴대폰으로 보려면 `npx wrangler dev --ip 0.0.0.0` 후 PC 의 IP 로 접속하고, 그 주소를 `.dev.vars` 의 `ALLOWED_ORIGINS` 에 넣지 않아도 같은 출처라 동작합니다.

화면만 고칠 때는 `npm run dev` 를 켜 둔 채 다른 터미널에서 `npm run dev:ui`(Vite 5173, API 는 8787 로 프록시).

## 명령

| 명령 | 내용 |
|---|---|
| `npm run build` | 화면 빌드(`dist/`) |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 단위 + E2E(실제 wrangler dev 를 띄워 HTTP·WebSocket 으로 시험) |
| `node tools/codes.mjs --students 480 --teachers 20` | 새 행사 + 참가 코드 500개 생성 → `private/codes-*.csv` |
| `node tools/codes.mjs --load 1000 --title 부하시험` | 부하 시험용 참가자 1,000명 준비 |
| `node loadtest/run.mjs --n 500` | 부하 시험 (실제 입장·WebSocket·답안 API 사용) |
| `npm run deploy:test` | 시험용 Worker(`nobrain-festival-quiz-test`) 배포 |

## 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 구조, 공식 문서 근거, **마감 경계 정의**, 중복·순서 처리, 인증·권한, 분산 대안
- [docs/TESTING.md](docs/TESTING.md) — 자동 테스트·부하 시험 방법, **실제 측정 결과와 미실행 항목**
- [docs/DEPLOY.md](docs/DEPLOY.md) — Cloudflare 배포, 비밀값, 진행자·전광판 접근, 정리
- [docs/COSTS.md](docs/COSTS.md) — 비용 가정과 사용량 확인
- [docs/ADD_QUESTIONS.md](docs/ADD_QUESTIONS.md) — 문제 추가
- [docs/REHEARSAL.md](docs/REHEARSAL.md) — 강당 리허설 체크리스트

## 폴더

```
worker/            서버 (Worker + Durable Object)
  index.ts         인증·Origin/CSRF·라우팅
  event-do.ts      행사 Object: SQLite 스키마·접수·마감·채점·방송
  auth.ts          세션 토큰·코드 해시·암호화
  quiz/bank.ts     문제·정답 (서버 전용)
  quiz/grading.ts  정규화·채점 규칙
shared/protocol.ts 화면↔서버 메시지 형식 (정답 없음)
src/               React 화면 (참가자·진행자·전광판)
public/media/      문제 이미지 (직접 만든 SVG)
loadtest/          부하 시험 도구 (client.mjs 는 E2E 와 공용)
tools/codes.mjs    참가 코드 생성·내보내기
test/unit, test/e2e
```

## 보안 메모
- `.dev.vars`, `private/`(참가 코드 CSV), `loadtest/results/` 는 git 에서 제외됩니다. 참가 코드 파일을 공개 폴더·저장소에 올리지 마세요.
- **이 저장소가 공개(Public)라면 `worker/quiz/bank.ts` 의 정답도 공개됩니다.** 본행사 문제를 넣기 전에 저장소를 비공개로 바꾸세요.
- 참가 코드는 1인 1참여를 완벽히 보장하지 않습니다(코드를 남에게 주는 것은 막을 수 없음). 같은 코드는 마지막으로 입장한 기기 하나만 유효합니다.

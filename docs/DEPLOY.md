# Cloudflare 배포 (시험용 Worker)

- 배포 대상: `wrangler.jsonc` 의 `env.test` → Worker 이름 **`nobrain-festival-quiz-test`**, Durable Object 클래스 `EventDO` (이 Worker 전용 네임스페이스).
- 최상위 설정(`nobrain-quiz-local`)은 로컬 개발 전용이며 배포하지 않습니다.
- 기존 운영 Worker 와 이름이 겹치지 않으므로 다른 Worker·데이터를 덮어쓰지 않습니다. 새 유료 구독은 필요 없습니다(Workers Paid 사용 중 전제).

## 1. 계정 확인
```bash
npx wrangler whoami
```
여러 계정이 보이면 `wrangler.jsonc` 에 `"account_id"` 를 넣거나 `CLOUDFLARE_ACCOUNT_ID` 환경변수로 대상 계정을 정하세요.

## 2. 빌드·배포
```bash
npm run deploy:test
```
(`vite build` 후 `wrangler deploy --env test`. 첫 배포 때 마이그레이션 `v1` 으로 SQLite 기반 `EventDO` 가 만들어집니다.)

## 3. 비밀값 넣기 (프런트엔드·저장소에 넣지 않음)
```bash
npx wrangler secret put HOST_PASSWORD --env test
```
```bash
npx wrangler secret put SESSION_SECRET --env test
```
- `HOST_PASSWORD`: 진행자 비밀번호. 16자 이상 무작위 권장(12자 미만이면 서버가 로그인을 거부합니다).
- `SESSION_SECRET`: 32자 이상 무작위. 바꾸면 **기존 세션과 참가 코드가 모두 무효**가 됩니다(코드 해시·암호화 키가 여기서 파생됨). 행사 도중 바꾸지 마세요.
- `DEV_MODE` 는 넣지 않습니다. (넣어도 `APP_ENV=cloud-test` 라 개발용 기능은 동작하지 않습니다.)

무작위 값 만들기 예:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. 진행자·전광판 접근
1. `https://nobrain-festival-quiz-test.sirlma.workers.dev/host` (현재 배포 주소) 에서 진행자 비밀번호로 로그인
2. **새 행사 만들기** → 행사 코드 6자리 확인
3. **참가 코드** 칸에서 학생·교사 코드 생성 → **코드 CSV 내려받기** (또는 `node tools/codes.mjs --base <주소> --students 480 --teachers 20`, 비밀번호는 `HOST_PASSWORD` 환경변수)
4. **전광판 링크 발급** → 무대 PC 에서 그 링크를 열고 **전체화면**. 링크는 학생에게 보이지 않게 하세요(새로 발급하면 이전 링크는 끊김)
5. 학생은 전광판의 QR 코드(주소 `…/?e=행사코드`) 로 들어와 개인 참가 코드를 입력

사용자 지정 도메인을 쓰려면 대시보드에서 Worker 에 Custom Domain 을 연결하세요. 같은 출처에서만 동작하므로 추가 설정은 필요 없습니다.

## 5. 배포 후 확인
```bash
npx wrangler tail --env test
```
- 진행자 로그인 → 행사 생성 → 코드 3개 → 휴대폰으로 입장 → 문제 1개 진행 → 결과 CSV 까지 손으로 한 번 확인
- 클라우드 부하 시험은 [TESTING.md](TESTING.md) 의 "클라우드 부하 시험" 절차와 승인 후에만

## 6. 정리 (데이터는 자동 삭제하지 않음)
1. 진행자 화면에서 **결과 CSV** 와 **코드 CSV** 를 내려받아 보관
2. 시험 데이터만 지우려면 진행자 화면의 **시험 행사 초기화**(행사 코드 입력 확인)
3. 시험용 Worker 자체를 없애려면 대시보드(Workers & Pages → `nobrain-festival-quiz-test` → Settings → Delete) 또는
   `npx wrangler delete --env test`. **Worker 와 함께 Durable Object 에 저장된 데이터가 삭제될 수 있으니** 1번을 먼저 하고, 실행 전 표시되는 경고를 확인하세요.
4. 로컬의 `private/`(참가 코드·비밀번호 메모)와 `loadtest/results/` 는 git 에서 제외되어 있습니다. 필요 없으면 직접 지우세요.

## (선택) GitHub 연동 자동 배포
대시보드의 Workers Builds 로 저장소를 연결하면 push 때 자동 배포할 수 있습니다. 다만 **행사 중 push = 재배포 = 모든 WebSocket 끊김** 이므로,
행사 기간에는 자동 배포를 끄거나 브랜치를 분리하세요. 이 저장소는 `wrangler deploy --env test` 수동 배포를 기준으로 합니다.

# 문제 추가 방법

문제는 `worker/quiz/bank.ts` 의 `QUESTIONS` 배열에 있습니다. 이 파일은 **서버(Worker) 전용**이라 정답이 학생·전광판 번들에 들어가지 않습니다.
(`test/unit/bundle-leak.test.ts` 가 빌드 결과에 해설·정답이 없는지 검사합니다.)

## 1. 이미지 넣기
- `public/media/` 에 SVG·PNG·WebP 로 넣습니다. **파일 이름에 정답을 쓰지 마세요** (예: `apple3.svg` ✕ → `k3m9q.svg` ○).
- SVG 안의 주석·`aria-label`·`<title>` 에도 정답을 쓰지 마세요. 정적 파일은 누구나 받을 수 있습니다.
- 가로 16:9 전광판 기준으로 가로가 긴 그림이 잘 보입니다. 큰 사진은 WebP 로 줄여 주세요.

## 2. 문제 데이터 추가

```ts
{
  id: 'q-flag-01',            // 고유 ID. 바꾸지 말고, 내용을 크게 고치면 새 ID 를 쓰세요
  prompt: '어느 나라 국기일까요?',
  image: '/media/p8x2k.webp',
  imageAlt: '가로 줄무늬 깃발',  // 정답을 드러내지 않는 설명
  timeLimitSec: 20,
  answerDisplay: '대한민국',     // 전광판에 공개할 대표 정답 (accepted 에도 포함)
  accepted: ['대한민국', '한국', '남한'],
  explanation: '태극 문양과 네 개의 괘가 있어요.',
  rules: { ignoreSpaces: true, caseInsensitive: true },
},
```

- **채점 규칙**: 서버가 NFKC 정규화(전각→반각, 조합형 한글→완성형), 공백 정리, 제로폭 문자 제거 후,
  `ignoreSpaces`(띄어쓰기 무시)·`caseInsensitive`(영문 대소문자 무시) 를 적용해 `accepted` 와 **정확히 일치**하는지만 봅니다.
  유사도·AI 판정은 없습니다. 오타까지 인정하려면 그 오타를 `accepted` 에 넣거나, 행사 중 진행자 화면의 "정답 인정"을 쓰세요.
- 문제 순서 = 배열 순서. 행사를 **만들 때** 문제 목록이 고정되므로, 문제를 바꾼 뒤에는 새 행사를 만드세요.

## 3. 확인
```bash
npm run test:unit
```
```bash
npm run build
```
그다음 로컬에서 진행자 화면으로 새 행사를 만들어 전광판에서 그림이 잘 보이는지 확인합니다.

## 4. 공개 저장소 주의
현재 GitHub 저장소는 **공개(Public)** 입니다. `bank.ts` 를 커밋하면 정답이 GitHub 에서 보입니다.
본행사 문제를 넣기 전에 다음 중 하나를 하세요.
- 저장소를 비공개(Private)로 바꾸기 (권장), 또는
- 본행사 문제는 커밋하지 않은 로컬 파일로 두고 그 컴퓨터에서만 `npm run deploy:test` 로 배포하기

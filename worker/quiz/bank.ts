// 문제 은행 — 서버(Worker) 전용 데이터.
// 이 파일은 worker/ 에서만 import 한다. src/(학생·전광판 화면)에서 import 하면 정답이 번들에 들어간다.
// test/unit/bundle-leak.test.ts 가 빌드 결과에 정답이 없는지 검사한다.
//
// 문제 추가 방법은 docs/ADD_QUESTIONS.md 참고.
// 이미지는 public/media/ 에 두되 파일 이름에 정답을 드러내지 않는다.

import type { GradingRules } from './grading';

export interface Question {
  /** 고유 ID. 한 번 쓴 ID 는 내용을 바꿀 때도 새 ID 로 바꾸는 것을 권장 */
  id: string;
  prompt: string;
  /** 정적 이미지 경로 (public/ 기준) */
  image: string;
  imageAlt: string;
  timeLimitSec: number;
  /** 전광판에 공개할 대표 정답 */
  answerDisplay: string;
  /** 인정 답안 목록 (대표 정답 포함) */
  accepted: string[];
  explanation: string;
  rules: GradingRules;
  /** (선택) 연습용 봇이 낼 흔한 오답. 채점에는 쓰지 않는다 */
  decoys?: string[];
}

export const QUESTIONS: Question[] = [
  {
    id: 'q-clock-01',
    prompt: '몇 시일까요?',
    image: '/media/m7k2p.svg',
    imageAlt: '바늘이 있는 둥근 시계',
    timeLimitSec: 20,
    answerDisplay: '3시',
    accepted: ['3시', '세시', '세 시', '3:00'],
    explanation: '짧은 바늘이 3을, 긴 바늘이 12를 가리키면 정각 3시예요.',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['9시', '4시', '12시', '3시 15분'],
  },
  {
    id: 'q-shape-01',
    prompt: '가운데 도형은?',
    image: '/media/x4n8d.svg',
    imageAlt: '도형 세 개가 나란히 놓인 그림',
    timeLimitSec: 20,
    answerDisplay: '원',
    accepted: ['원', '동그라미', '원형'],
    explanation: '왼쪽부터 삼각형 · 원 · 사각형 순서예요. 가운데는 원!',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['삼각형', '네모', '공', '세모'],
  },
  {
    id: 'q-apple-01',
    prompt: '사과는 몇 개일까요?',
    image: '/media/c9v3w.svg',
    imageAlt: '빨간 과일이 놓인 그림',
    timeLimitSec: 20,
    answerDisplay: '3개',
    accepted: ['3', '3개', '세개', '세 개'],
    explanation: '사과가 하나, 둘, 셋 — 모두 3개예요.',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['4개', '2개', '토마토', '5개'],
  },
];

export const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

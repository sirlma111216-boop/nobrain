// 문제 은행 — 서버(Worker) 전용 데이터.
// 이 파일은 worker/ 에서만 import 한다. src/(학생·전광판 화면)에서 import 하면 정답이 번들에 들어간다.
// test/unit/bundle-leak.test.ts 가 빌드 결과에 정답이 없는지 검사한다.
//
// 문제 추가 방법은 docs/ADD_QUESTIONS.md 참고.
// 이미지는 public/media/ 에 두되 파일 이름에 정답을 드러내지 않는다.

import type { GradingRules } from './grading';
import type { Choice, QuestionType } from '../../shared/protocol';

export interface Question {
  /** 고유 ID. 한 번 쓴 ID 는 내용을 바꿀 때도 새 ID 로 바꾸는 것을 권장 */
  id: string;
  /** 문제 유형. 없으면 단답형(short). 객관식(choice)은 보기 번호 '1'~'4', OX 는 'O'|'X' 가 답이다 */
  type?: QuestionType;
  /** 객관식 보기(2~4개). 글·사진 중 하나 이상 */
  choices?: Choice[];
  prompt: string;
  /** 이미지 경로 (public/ 기준 또는 /api/media/…). '' 이면 사진 없음(질문 글만) */
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

export interface QuestionSet {
  /** 세트 ID (행사를 만들 때 고른다) */
  id: string;
  title: string;
  questions: Question[];
}

/** 문제 유형별 예시: 사진 객관식 · 글 객관식 · 글 단답형 · OX. 진행자가 유형을 둘러보고 리허설하는 용도 */
export const TYPE_DEMO_QUESTIONS: Question[] = [
  {
    id: 'q-type-choice-img',
    type: 'choice',
    prompt: '가운데 도형은 무엇일까요?',
    image: '/media/x4n8d.svg',
    imageAlt: '도형 세 개가 나란히 놓인 그림',
    timeLimitSec: 20,
    choices: [
      { text: '삼각형', image: '' },
      { text: '원', image: '' },
      { text: '사각형', image: '' },
      { text: '별', image: '' },
    ],
    answerDisplay: '② 원',
    accepted: ['2'],
    explanation: '왼쪽부터 삼각형 · 원 · 사각형이에요. 가운데는 원!',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['1', '3', '4'],
  },
  {
    id: 'q-type-choice-text',
    type: 'choice',
    prompt: '1년은 모두 몇 달일까요?',
    image: '',
    imageAlt: '',
    timeLimitSec: 20,
    choices: [
      { text: '10달', image: '' },
      { text: '11달', image: '' },
      { text: '12달', image: '' },
      { text: '13달', image: '' },
    ],
    answerDisplay: '③ 12달',
    accepted: ['3'],
    explanation: '1월부터 12월까지, 1년은 12달이에요.',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['1', '2', '4'],
  },
  {
    id: 'q-type-short-text',
    type: 'short',
    prompt: '무지개는 모두 몇 가지 색일까요? (숫자로)',
    image: '',
    imageAlt: '',
    timeLimitSec: 20,
    answerDisplay: '7',
    accepted: ['7', '7가지', '일곱', '일곱가지', '일곱 가지'],
    explanation: '빨주노초파남보, 일곱 가지 색이에요.',
    rules: { ignoreSpaces: true, caseInsensitive: true },
    decoys: ['6', '5', '8'],
  },
  {
    id: 'q-type-ox',
    type: 'ox',
    prompt: '그림의 사과는 모두 3개다. 맞으면 O, 틀리면 X',
    image: '/media/c9v3w.svg',
    imageAlt: '빨간 과일이 놓인 그림',
    timeLimitSec: 15,
    answerDisplay: 'O',
    accepted: ['O'],
    explanation: '사과가 하나, 둘, 셋 — 모두 3개예요.',
    rules: { ignoreSpaces: true, caseInsensitive: false },
    decoys: ['X'],
  },
];

/** 코드에 들어 있는 기본 세트(수정 불가). 진행자가 화면에서 만드는 세트는 LibraryDO 에 저장된다(worker/library-do.ts). */
export const QUESTION_SETS: QuestionSet[] = [
  { id: 'basic', title: '시험 문제 3개 (기본 예시)', questions: QUESTIONS },
  { id: 'types', title: '문제 유형 예시 4개 (객관식·단답·OX)', questions: TYPE_DEMO_QUESTIONS },
];

export const ALL_QUESTIONS: Question[] = QUESTION_SETS.flatMap((s) => s.questions);
export const QUESTION_BY_ID = new Map(ALL_QUESTIONS.map((q) => [q.id, q]));
export const SET_BY_ID = new Map(QUESTION_SETS.map((s) => [s.id, s]));

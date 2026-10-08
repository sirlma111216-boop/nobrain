// 서버 ↔ 클라이언트 메시지 형식. 정답·채점 규칙은 여기에 두지 않는다(학생 번들에 포함되므로).

/** 행사 진행 단계 */
export type Phase = 'lobby' | 'ready' | 'open' | 'closed' | 'ended';

/**
 * 공개 단계 (closed 이후)
 * 1 문제 공개(=open) · 2 접수 마감 · 3 대표 답안 · 4 정답·해설 · 5 정답자 수·명단
 */
export type Stage = 1 | 2 | 3 | 4 | 5;

/** 참가자 본인의 서버 접수 답안 */
export interface MyAnswer {
  qid: string;
  run: number;
  text: string;
  seq: number;
  at: number;
}

/** 참가자 화면용 상태. 정오답·정답·집계·타인 정보 없음 */
export interface PlayerView {
  t: 'state';
  ev: string;
  title: string;
  phase: Phase;
  qNo: number; // 1부터. lobby 이면 0
  qTotal: number;
  qid: string | null;
  run: number; // 진행 버전(문제를 시작할 때마다 증가). 0이면 진행 중인 문제 없음
  endsAt: number | null;
  now: number; // 서버 시각(기기 시계 보정용)
  me?: MyAnswer | null; // 연결 직후·재동기화 때만 포함
}

export interface BoardView {
  t: 'board';
  ev: string;
  title: string;
  phase: Phase;
  stage: Stage | 0;
  qNo: number;
  qTotal: number;
  run: number;
  endsAt: number | null;
  now: number;
  question?: { prompt: string; image: string; imageAlt: string };
  featured?: { text: string; count: number }[];
  answer?: { display: string; explanation: string };
  voided?: boolean;
  winners?: { count: number; names: string[]; page: number; pages: number };
}

export interface TopAnswer {
  norm: string;
  count: number;
  correct: boolean;
}

export interface RunSummary {
  run: number;
  qNo: number;
  qid: string;
  status: 'open' | 'closed';
  total: number;
  correct: number;
  voided: boolean;
}

export interface HostView {
  t: 'host';
  ev: string;
  title: string;
  sv: number; // 상태 버전(진행자 명령의 중복 클릭 방지용)
  phase: Phase;
  stage: Stage | 0;
  page: number;
  qNo: number;
  qTotal: number;
  run: number;
  endsAt: number | null;
  now: number;
  boot: string; // Object 인스턴스 식별값(재시작·Hibernation 관찰용)
  registered: number;
  connected: number; // 참고치(네트워크 상태에 따라 지연)
  boards: number;
  submitted: number; // 현재 문제 제출 인원
  question?: {
    id: string;
    prompt: string;
    image: string;
    answerDisplay: string;
    accepted: string[];
    extra: string[];
    explanation: string;
    rules: { ignoreSpaces: boolean; caseInsensitive: boolean };
    timeLimitSec: number;
  };
  nextQuestion?: { qNo: number; prompt: string } | null;
  top?: TopAnswer[];
  featured?: string[];
  correct?: number;
  voided?: boolean;
  winnerPages?: number;
  runs: RunSummary[];
}

export type ServerMessage =
  | PlayerView
  | BoardView
  | HostView
  | { t: 'kicked' }
  | { t: 'reset' };

/** 답안 접수 결과 */
export type SubmitStatus =
  | 'accepted' // 저장 완료
  | 'duplicate' // 같은 요청의 재시도. 이미 저장되어 있음
  | 'superseded' // 더 새 버전이 이미 저장되어 있음. 덮어쓰지 않음
  | 'closed' // 서버 마감 후 도착
  | 'stale' // 이전 문제·이전 진행 버전 요청
  | 'not_open' // 진행 중인 문제 없음
  | 'invalid' // 빈 답·너무 긴 답·형식 오류
  | 'rate_limited'
  | 'kicked'; // 다른 기기에서 같은 코드로 입장

export interface SubmitResult {
  status: SubmitStatus;
  latest?: MyAnswer | null;
  message?: string;
}

export const LIMITS = {
  answerMaxChars: 30,
  answerMaxRawChars: 100,
  winnersPageSize: 30,
} as const;

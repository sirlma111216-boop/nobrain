// 진행자가 화면에서 만드는 문제의 입력 검증(서버 전용).
import { cleanAnswer, isCorrect, type GradingRules } from './grading';

export interface QuestionInput {
  imageId: string;
  prompt: string;
  answerDisplay: string;
  accepted: string[];
  explanation: string;
  timeLimitSec: number;
  rules: GradingRules;
  decoys: string[];
}

const MAX = { answer: 30, accepted: 30, prompt: 80, explanation: 300, decoys: 10 };
export const MEDIA_ID = /^[a-f0-9]{32}$/;

function cleanList(v: unknown, max: number): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('|') : [];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== 'string') continue;
    const c = cleanAnswer(x);
    if (c && [...c].length <= MAX.answer && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

export function validateQuestion(b: Record<string, unknown>): { ok: true; q: QuestionInput } | { ok: false; message: string } {
  const imageId = typeof b.imageId === 'string' ? b.imageId : '';
  if (!MEDIA_ID.test(imageId)) return { ok: false, message: '사진을 올려 주세요.' };
  const answerDisplay = cleanAnswer(typeof b.answerDisplay === 'string' ? b.answerDisplay : '');
  if (!answerDisplay) return { ok: false, message: '정답을 입력하세요.' };
  if ([...answerDisplay].length > MAX.answer) return { ok: false, message: `정답은 ${MAX.answer}자 이내로 입력하세요.` };
  const rules: GradingRules = {
    ignoreSpaces: (b.rules as GradingRules | undefined)?.ignoreSpaces !== false,
    caseInsensitive: (b.rules as GradingRules | undefined)?.caseInsensitive !== false,
  };
  // 대표 정답이 항상 맨 앞
  const accepted = [answerDisplay, ...cleanList(b.accepted, MAX.accepted).filter((a) => a !== answerDisplay)];
  const prompt = (typeof b.prompt === 'string' ? b.prompt : '').replace(/[\p{Cc}]/gu, ' ').trim().slice(0, MAX.prompt);
  const explanation = (typeof b.explanation === 'string' ? b.explanation : '').replace(/[\p{Cc}]/gu, ' ').trim().slice(0, MAX.explanation);
  const t = Number(b.timeLimitSec ?? 20);
  if (!Number.isInteger(t) || t < 5 || t > 300) return { ok: false, message: '제한시간은 5~300초입니다.' };
  // 오답 예시가 정답으로 채점되면 봇 연습이 이상해지므로 뺀다
  const decoys = cleanList(b.decoys, MAX.decoys).filter((d) => !isCorrect(d, accepted, rules));
  return { ok: true, q: { imageId, prompt, answerDisplay, accepted: accepted.slice(0, MAX.accepted), explanation, timeLimitSec: t, rules, decoys } };
}

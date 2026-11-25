// 진행자가 화면에서 만드는 문제의 입력 검증(서버 전용).
import { cleanAnswer, isCorrect, type GradingRules } from './grading';
import { CIRCLED, MAX_CHOICES, type QuestionType } from '../../shared/protocol';

export interface ChoiceInput {
  text: string;
  imageId: string; // '' 이면 사진 없음
}

export interface QuestionInput {
  type: QuestionType;
  imageId: string; // '' 이면 사진 없음(질문 글만)
  prompt: string;
  answerDisplay: string;
  accepted: string[];
  explanation: string;
  timeLimitSec: number;
  rules: GradingRules;
  decoys: string[];
  /** 객관식만(2~4개). 그 밖의 유형은 빈 배열 */
  choices: ChoiceInput[];
}

const MAX = { answer: 30, accepted: 30, prompt: 80, explanation: 300, decoys: 10, choiceText: 40 };
export const MEDIA_ID = /^[a-f0-9]{32}$/;
const TYPES: QuestionType[] = ['short', 'choice', 'ox'];

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

const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/[\p{Cc}]/gu, ' ').trim().slice(0, max);

export function validateQuestion(b: Record<string, unknown>): { ok: true; q: QuestionInput } | { ok: false; message: string } {
  const type: QuestionType = TYPES.includes(b.type as QuestionType) ? (b.type as QuestionType) : 'short';
  const imageId = typeof b.imageId === 'string' ? b.imageId : '';
  if (imageId && !MEDIA_ID.test(imageId)) return { ok: false, message: '사진을 다시 올려 주세요.' };
  const prompt = cleanText(b.prompt, MAX.prompt);
  if (!imageId && !prompt) return { ok: false, message: '사진을 올리거나 질문 글을 입력하세요.' };
  const explanation = cleanText(b.explanation, MAX.explanation);
  const t = Number(b.timeLimitSec ?? 20);
  if (!Number.isInteger(t) || t < 5 || t > 300) return { ok: false, message: '제한시간은 5~300초입니다.' };
  const base = { type, imageId, prompt, explanation, timeLimitSec: t, choices: [] as ChoiceInput[] };

  if (type === 'choice') {
    // 보기: 글·사진 중 하나 이상 있는 것만 남기고 2~4개. 정답은 남은 보기 중 하나여야 한다
    const raw = Array.isArray(b.choices) ? b.choices.slice(0, MAX_CHOICES) : [];
    const kept: { c: ChoiceInput; origIndex: number }[] = [];
    raw.forEach((x, i) => {
      const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
      const text = cleanText(o.text, MAX.choiceText);
      const img = typeof o.imageId === 'string' && MEDIA_ID.test(o.imageId) ? o.imageId : '';
      if (text || img) kept.push({ c: { text, imageId: img }, origIndex: i });
    });
    if (kept.length < 2) return { ok: false, message: '보기를 2개 이상 넣으세요(글 또는 사진).' };
    const correctOrig = Number(b.correct);
    const correct = kept.findIndex((k) => k.origIndex === correctOrig);
    if (correct < 0) return { ok: false, message: '정답 보기를 고르세요.' };
    const choices = kept.map((k) => k.c);
    const no = String(correct + 1);
    const answerDisplay = choices[correct].text ? `${CIRCLED[correct]} ${choices[correct].text}` : CIRCLED[correct];
    return {
      ok: true,
      q: {
        ...base,
        choices,
        answerDisplay,
        accepted: [no],
        rules: { ignoreSpaces: true, caseInsensitive: true },
        decoys: choices.map((_, i) => String(i + 1)).filter((x) => x !== no),
      },
    };
  }

  if (type === 'ox') {
    const ans = typeof b.answer === 'string' ? b.answer.trim().toUpperCase() : '';
    if (ans !== 'O' && ans !== 'X') return { ok: false, message: '정답으로 O 또는 X 를 고르세요.' };
    return {
      ok: true,
      q: { ...base, answerDisplay: ans, accepted: [ans], rules: { ignoreSpaces: true, caseInsensitive: false }, decoys: [ans === 'O' ? 'X' : 'O'] },
    };
  }

  // 단답형
  const answerDisplay = cleanAnswer(typeof b.answerDisplay === 'string' ? b.answerDisplay : '');
  if (!answerDisplay) return { ok: false, message: '정답을 입력하세요.' };
  if ([...answerDisplay].length > MAX.answer) return { ok: false, message: `정답은 ${MAX.answer}자 이내로 입력하세요.` };
  const rules: GradingRules = {
    ignoreSpaces: (b.rules as GradingRules | undefined)?.ignoreSpaces !== false,
    caseInsensitive: (b.rules as GradingRules | undefined)?.caseInsensitive !== false,
  };
  // 대표 정답이 항상 맨 앞
  const accepted = [answerDisplay, ...cleanList(b.accepted, MAX.accepted).filter((a) => a !== answerDisplay)];
  // 오답 예시가 정답으로 채점되면 봇 연습이 이상해지므로 뺀다
  const decoys = cleanList(b.decoys, MAX.decoys).filter((d) => !isCorrect(d, accepted, rules));
  return { ok: true, q: { ...base, answerDisplay, accepted: accepted.slice(0, MAX.accepted), rules, decoys } };
}

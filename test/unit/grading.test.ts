import { describe, it, expect } from 'vitest';
import { cleanAnswer, isCorrect, normKey } from '../../worker/quiz/grading';
import { QUESTIONS } from '../../worker/quiz/bank';

const loose = { ignoreSpaces: true, caseInsensitive: true };
const strict = { ignoreSpaces: false, caseInsensitive: false };

describe('정규화', () => {
  it('NFKC·공백·제어 문자', () => {
    expect(cleanAnswer('  세   시 \n')).toBe('세 시');
    expect(cleanAnswer('３:００')).toBe('3:00');
    expect(cleanAnswer('원​')).toBe('원'); // 제로폭 공백 제거
    expect(cleanAnswer('세 시')).toBe('세 시'); // 조합형 한글 → 완성형
  });
  it('문제별 띄어쓰기·대소문자 규칙', () => {
    expect(normKey('세 시', loose)).toBe('세시');
    expect(normKey('세 시', strict)).toBe('세 시');
    expect(normKey('Circle', loose)).toBe('circle');
    expect(normKey('Circle', strict)).toBe('Circle');
  });
});

describe('시험 문제 채점', () => {
  const [q1, q2, q3] = QUESTIONS;
  const ok = (q: (typeof QUESTIONS)[number], a: string) => isCorrect(a, q.accepted, q.rules);
  it('1번: 3시 / 세시 / 세 시 / 3:00', () => {
    for (const a of ['3시', '세시', '세 시', '3:00', ' 3 시 ', '３시']) expect(ok(q1, a)).toBe(true);
    for (const a of ['3', '4시', '세시요', '15시', '', '3:01']) expect(ok(q1, a)).toBe(false);
  });
  it('2번: 원 / 동그라미 / 원형', () => {
    for (const a of ['원', '동그라미', '원형', '동 그라미']) expect(ok(q2, a)).toBe(true);
    for (const a of ['삼각형', '네모', '원원', '']) expect(ok(q2, a)).toBe(false);
  });
  it('3번: 3 / 3개 / 세개 / 세 개', () => {
    for (const a of ['3', '3개', '세개', '세 개', '３개']) expect(ok(q3, a)).toBe(true);
    for (const a of ['4개', '셋', '3개요', '']) expect(ok(q3, a)).toBe(false);
  });
  it('문제 데이터 형식', () => {
    const ids = new Set<string>();
    for (const q of QUESTIONS) {
      expect(ids.has(q.id)).toBe(false);
      ids.add(q.id);
      expect(q.timeLimitSec).toBe(20);
      expect(q.accepted).toContain(q.answerDisplay);
      expect(q.explanation.length).toBeGreaterThan(5);
      expect(q.image).toMatch(/^\/media\/[a-z0-9]+\.svg$/);
    }
  });
});

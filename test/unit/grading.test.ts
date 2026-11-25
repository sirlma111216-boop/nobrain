import { describe, it, expect } from 'vitest';
import { cleanAnswer, isCorrect, normKey } from '../../worker/quiz/grading';
import { existsSync } from 'node:fs';
import { QUESTIONS, QUESTION_SETS, ALL_QUESTIONS } from '../../worker/quiz/bank';
import { isCorrect as ok2 } from '../../worker/quiz/grading';
import { CIRCLED, answerLabel, choiceLabel } from '../../shared/protocol';

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

describe('문제세트', () => {
  it('세트 ID·문제 ID 가 겹치지 않고, 그림 파일이 있으며, 대표 정답·인정 답안이 채점된다', () => {
    expect(new Set(QUESTION_SETS.map((x) => x.id)).size).toBe(QUESTION_SETS.length);
    expect(new Set(ALL_QUESTIONS.map((q) => q.id)).size).toBe(ALL_QUESTIONS.length);
    for (const set of QUESTION_SETS) {
      expect(set.questions.length).toBeGreaterThan(0);
      for (const q of set.questions) {
        if (q.image) expect(existsSync('public' + q.image), q.id + ' 그림 없음 ' + q.image).toBe(true);
        else expect(q.prompt, q.id + ' 사진도 질문 글도 없음').not.toBe('');
        if (q.type === 'choice') {
          expect((q.choices ?? []).length).toBeGreaterThanOrEqual(2);
          expect(Number(q.accepted[0])).toBeLessThanOrEqual(q.choices!.length);
          expect(q.answerDisplay.startsWith(CIRCLED[Number(q.accepted[0]) - 1])).toBe(true);
        } else if (q.type === 'ox') expect(['O', 'X']).toContain(q.accepted[0]);
        else expect(q.accepted).toContain(q.answerDisplay);
        for (const a of q.accepted) expect(ok2(a, q.accepted, q.rules), q.id + ' ' + a).toBe(true);
        for (const d of q.decoys ?? []) expect(ok2(d, q.accepted, q.rules), q.id + ' 오답예시가 정답으로 채점됨: ' + d).toBe(false);
      }
    }
  });
});

import { validateQuestion } from '../../worker/quiz/validate';
describe('문제 입력 검증', () => {
  const base = { imageId: 'a'.repeat(32), answerDisplay: ' 엄마손파이 ', accepted: ['엄마 손 파이', '엄마손파이', ''], timeLimitSec: 20 };
  it('대표 정답을 인정 답안에 넣고, 정답으로 채점되는 오답 예시는 뺀다', () => {
    const v = validateQuestion({ ...base, decoys: ['엄마 손파이', '초코파이'] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.q.answerDisplay).toBe('엄마손파이');
    expect(v.q.accepted).toEqual(['엄마손파이', '엄마 손 파이']);
    expect(v.q.decoys).toEqual(['초코파이']);
    expect(v.q.prompt).toBe('');
    expect(v.q.rules).toEqual({ ignoreSpaces: true, caseInsensitive: true });
  });
  it('사진·정답·제한시간 오류를 거부한다', () => {
    expect(validateQuestion({ ...base, imageId: 'x' }).ok).toBe(false);
    expect(validateQuestion({ ...base, answerDisplay: '  ' }).ok).toBe(false);
    expect(validateQuestion({ ...base, answerDisplay: '가'.repeat(31) }).ok).toBe(false);
    expect(validateQuestion({ ...base, timeLimitSec: 3 }).ok).toBe(false);
  });
  it('사진 없이 질문 글만으로 단답형을 만들 수 있고, 둘 다 없으면 거부한다', () => {
    const v = validateQuestion({ ...base, imageId: '', prompt: '무지개 색은 몇 가지?' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.q).toMatchObject({ type: 'short', imageId: '', prompt: '무지개 색은 몇 가지?' });
    expect(validateQuestion({ ...base, imageId: '', prompt: ' ' }).ok).toBe(false);
  });
  it('객관식: 빈 보기를 빼고 번호를 다시 매기며, 정답 번호·오답 번호를 만든다', () => {
    const v = validateQuestion({
      type: 'choice',
      imageId: '',
      prompt: '1년은 몇 달?',
      choices: [{ text: '10달' }, { text: '' }, { text: '12달', imageId: 'c'.repeat(32) }, { text: '13달' }],
      correct: 2,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.q.type).toBe('choice');
    expect(v.q.choices).toEqual([
      { text: '10달', imageId: '' },
      { text: '12달', imageId: 'c'.repeat(32) },
      { text: '13달', imageId: '' },
    ]);
    expect(v.q.accepted).toEqual(['2']);
    expect(v.q.answerDisplay).toBe('② 12달');
    expect(v.q.decoys).toEqual(['1', '3']);
    // 사진만 있는 보기도 보기로 친다. 정답 표시는 번호만
    const img = validateQuestion({ type: 'choice', prompt: 'q', choices: [{ imageId: 'a'.repeat(32) }, { imageId: 'b'.repeat(32) }], correct: 1 });
    expect(img.ok && img.q.answerDisplay).toBe('②');
    // 보기 1개 · 정답이 빈 보기 · 정답 미선택은 거부
    expect(validateQuestion({ type: 'choice', prompt: 'q', choices: [{ text: '하나' }], correct: 0 }).ok).toBe(false);
    expect(validateQuestion({ type: 'choice', prompt: 'q', choices: [{ text: '하나' }, { text: '' }, { text: '셋' }], correct: 1 }).ok).toBe(false);
    expect(validateQuestion({ type: 'choice', prompt: 'q', choices: [{ text: '하나' }, { text: '둘' }] }).ok).toBe(false);
  });
  it('OX: 정답은 O 또는 X 만', () => {
    const v = validateQuestion({ type: 'ox', prompt: '지구는 둥글다', answer: 'o' });
    expect(v.ok && v.q).toMatchObject({ type: 'ox', answerDisplay: 'O', accepted: ['O'], decoys: ['X'] });
    expect(validateQuestion({ type: 'ox', prompt: '지구는 둥글다', answer: '네' }).ok).toBe(false);
    // 채점 규칙(대소문자 구분)으로 'O' 만 정답. 서버는 접수 때 대문자로 바꾼다
    if (v.ok) expect(ok2('X', v.q.accepted, v.q.rules)).toBe(false);
  });
});

describe('답 표기', () => {
  it('보기 번호 → "② 글", 글이 없으면 번호만, 단답형은 그대로', () => {
    const choices = [{ text: '사과' }, { text: '' }];
    expect(choiceLabel(choices, 1)).toBe('① 사과');
    expect(choiceLabel(choices, 2)).toBe('②');
    expect(answerLabel({ type: 'choice', choices }, '1')).toBe('① 사과');
    expect(answerLabel({ type: 'ox' }, 'x')).toBe('X');
    expect(answerLabel({ type: 'short' }, '3시')).toBe('3시');
    expect(answerLabel(undefined, '3시')).toBe('3시');
  });
});

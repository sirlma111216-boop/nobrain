// 서버 전용 채점 규칙. AI·유사도 판정 없이 등록된 인정 답안과 정확히 비교한다.

export interface GradingRules {
  /** 띄어쓰기를 무시할지 ("세 시" == "세시") */
  ignoreSpaces: boolean;
  /** 영문 대소문자를 무시할지 */
  caseInsensitive: boolean;
}

/**
 * 표시·저장용 정리: 유니코드 NFKC 정규화(전각 숫자 → 반각 등),
 * 모든 공백 문자를 한 칸으로, 제어·서식 문자(제로폭 등) 제거, 앞뒤 공백 제거.
 */
export function cleanAnswer(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
}

/** 비교용 키. 같은 키면 같은 답으로 본다. */
export function normKey(raw: string, rules: GradingRules): string {
  let t = cleanAnswer(raw);
  if (rules.ignoreSpaces) t = t.replace(/ /g, '');
  if (rules.caseInsensitive) t = t.toLowerCase();
  return t;
}

export function acceptedKeys(accepted: string[], rules: GradingRules): string[] {
  return [...new Set(accepted.map((a) => normKey(a, rules)).filter((k) => k.length > 0))];
}

export function isCorrect(raw: string, accepted: string[], rules: GradingRules): boolean {
  const k = normKey(raw, rules);
  return k.length > 0 && acceptedKeys(accepted, rules).includes(k);
}

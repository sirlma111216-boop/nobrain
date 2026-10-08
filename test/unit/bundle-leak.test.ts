// 학생·전광판이 받는 정적 파일(빌드 결과)에 정답·해설이 들어가지 않았는지 검사한다.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QUESTIONS } from '../../worker/quiz/bank';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('정적 파일 정답 유출 검사', () => {
  let all = '';
  beforeAll(() => {
    execSync('npx vite build', { stdio: 'ignore' });
    all = files('dist')
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
  }, 120_000);

  it('해설·두 글자 이상 인정 답안이 번들·이미지·HTML 에 없다', () => {
    for (const q of QUESTIONS) {
      expect(all).not.toContain(q.explanation);
      expect(all).not.toContain(q.id); // 문제 ID 도 서버가 공개 시점에만 보낸다
      for (const a of q.accepted) {
        // '원', '3' 처럼 한두 글자는 일반 코드에도 흔해 의미 있는 검사가 아니다
        if ([...a].length >= 3) expect(all, `정답 "${a}" 노출`).not.toContain(a);
      }
    }
    expect(all).not.toContain('동그라미');
  });

  it('서버 전용 모듈 이름이 번들에 없다', () => {
    expect(all).not.toContain('answerDisplay:');
    expect(all).not.toContain('QUESTION_BY_ID');
  });
});

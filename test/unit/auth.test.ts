import { describe, it, expect } from 'vitest';
import { CODE_ALPHABET, codeHash, decryptCode, encryptCode, normalizeCode, randomCode, signToken, verifyToken, safeEqual } from '../../worker/auth';

const S = 'unit-test-secret-unit-test-secret-0123456789';

describe('세션 토큰', () => {
  it('서명·검증', async () => {
    const t = await signToken(S, { r: 'p', e: 'ABCDEF', p: 3, g: 1, x: Math.floor(Date.now() / 1000) + 60 });
    expect(await verifyToken(S, t)).toMatchObject({ r: 'p', p: 3 });
  });
  it('변조·다른 비밀값·만료는 거부', async () => {
    const t = await signToken(S, { r: 'p', e: 'ABCDEF', p: 3, g: 1, x: Math.floor(Date.now() / 1000) + 60 });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ r: 'h', x: 9999999999 })).toString('base64url');
    expect(await verifyToken(S, forged + '.' + sig)).toBeNull();
    expect(await verifyToken(S + 'x', t)).toBeNull();
    expect(await verifyToken(S, body + '.' + sig.slice(0, -2) + 'AA')).toBeNull();
    const old = await signToken(S, { r: 'h', x: Math.floor(Date.now() / 1000) - 1 });
    expect(await verifyToken(S, old)).toBeNull();
    expect(await verifyToken(S, 'garbage')).toBeNull();
  });
  it('짧은 비밀값은 설정 오류', async () => {
    await expect(signToken('short', { r: 'h', x: 1 })).rejects.toThrow();
  });
});

describe('참가 코드', () => {
  it('헷갈리는 문자 없이 무작위로 만든다', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = randomCode(8);
      expect(c).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
    // 엔트로피: 31^8 ≈ 8.5e11 (약 39.6비트)
    expect(Math.log2(CODE_ALPHABET.length ** 8)).toBeGreaterThan(39);
  });
  it('입력 정리: 소문자·하이픈·전각 허용', () => {
    expect(normalizeCode('ab2c-d3ef')).toBe('AB2CD3EF');
    expect(normalizeCode('ＡＢ２Ｃ')).toBe('AB2C');
    expect(normalizeCode(123)).toBe('');
  });
  it('해시는 행사별로 다르고, 암호문은 복호화된다', async () => {
    expect(await codeHash(S, 'AAAAAA', 'X')).not.toBe(await codeHash(S, 'BBBBBB', 'X'));
    expect(await codeHash(S, 'AAAAAA', 'X')).toBe(await codeHash(S, 'AAAAAA', 'X'));
    const e1 = await encryptCode(S, 'ABCD2345');
    const e2 = await encryptCode(S, 'ABCD2345');
    expect(e1).not.toBe(e2); // 무작위 IV
    expect(await decryptCode(S, e1)).toBe('ABCD2345');
    await expect(decryptCode(S + 'x', e1)).rejects.toThrow();
  });
  it('비밀번호 비교', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
  });
});

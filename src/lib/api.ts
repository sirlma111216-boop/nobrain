export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** 같은 출처 API 호출. 상태 변경(POST)에는 CSRF 방어용 헤더를 붙인다. */
export async function api<T = unknown>(path: string, opts: { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  const post = opts.body !== undefined;
  try {
    const res = await fetch(path, {
      method: post ? 'POST' : 'GET',
      headers: post ? { 'content-type': 'application/json', 'x-quiz': '1' } : {},
      body: post ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* 본문 없음 */
    }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? 'HTTP', data?.message ?? `서버 오류 (${res.status})`, data);
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const timeout = (e as Error)?.name === 'AbortError';
    throw new ApiError(0, timeout ? 'TIMEOUT' : 'NETWORK', timeout ? '응답이 늦어요. 다시 시도합니다.' : '네트워크 연결을 확인하세요.');
  } finally {
    clearTimeout(timer);
  }
}

export function rid(): string {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('');
}

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 사생활 보호 모드 등 */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 무시 */
    }
  },
};

// Worker: 인증·Origin/CSRF 검사·요청 라우팅.
// 세션 서명 검증·코드 해시·암호화처럼 상태가 필요 없는 CPU 작업은 여기(여러 인스턴스로 분산)에서 하고,
// 행사 Durable Object 에는 검증된 참가자 ID 와 최소한의 일만 넘긴다.

import { QUESTIONS } from './quiz/bank';
import { EventDO, type SubmitBody } from './event-do';
import {
  COOKIE,
  ConfigError,
  SESSION_TTL_SEC,
  b64u,
  codeHash,
  cookieHeader,
  decryptCode,
  encryptCode,
  normalizeCode,
  parseCookies,
  randomCode,
  randomToken,
  safeEqual,
  signToken,
  verifyToken,
  type BoardToken,
  type HostToken,
  type PlayerToken,
} from './auth';

export { EventDO };

const EVENT_CODE_LEN = 6;
const PART_CODE_LEN = 8;
const MAX_BODY = 20_000;

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const baseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const h = new Headers({ ...baseHeaders, 'content-type': 'application/json; charset=utf-8' });
  if (extra) new Headers(extra).forEach((v, k) => h.append(k, v));
  return new Response(JSON.stringify(data), { status, headers: h });
}

function eventStub(env: Env, code: string): DurableObjectStub<EventDO> {
  return env.EVENTS.get(env.EVENTS.idFromName('ev:' + code)) as DurableObjectStub<EventDO>;
}
function sysStub(env: Env): DurableObjectStub<EventDO> {
  return env.EVENTS.get(env.EVENTS.idFromName('sys:auth')) as DurableObjectStub<EventDO>;
}

function allowedOrigins(req: Request, env: Env): Set<string> {
  const s = new Set<string>([new URL(req.url).origin]);
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) s.add(o.trim());
  return s;
}

/** 상태 변경 요청: 같은 출처 Origin + JSON + 사용자 정의 헤더(교차 출처면 사전 요청이 필요해 차단됨) */
function checkMutation(req: Request, env: Env) {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins(req, env).has(origin)) throw new HttpError(403, 'ORIGIN', '허용되지 않은 출처의 요청입니다.');
  if (req.headers.get('x-quiz') !== '1') throw new HttpError(403, 'CSRF', '잘못된 요청입니다.');
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) throw new HttpError(415, 'TYPE', '잘못된 요청 형식입니다.');
}

async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', '요청이 너무 큽니다.');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', '요청이 너무 큽니다.');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new HttpError(400, 'BAD_JSON', '잘못된 요청 형식입니다.');
  }
}

function isSecure(req: Request) {
  return new URL(req.url).protocol === 'https:';
}

async function session<T>(req: Request, env: Env, role: 'p' | 'h' | 'b'): Promise<T | null> {
  const t = await verifyToken(env.SESSION_SECRET, parseCookies(req.headers.get('Cookie'))[COOKIE[role]]);
  return t && t.r === role ? (t as T) : null;
}

async function requireHost(req: Request, env: Env): Promise<HostToken> {
  const t = await session<HostToken>(req, env, 'h');
  if (!t) throw new HttpError(401, 'NO_HOST', '진행자 로그인이 필요합니다.');
  return t;
}

function eventParam(v: unknown): string {
  const ev = normalizeCode(v);
  if (ev.length !== EVENT_CODE_LEN) throw new HttpError(400, 'BAD_EVENT', '행사 코드가 올바르지 않습니다.');
  return ev;
}

function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'local';
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 스프레드시트 수식 주입 방지
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csv(rows: unknown[][], filename: string): Response {
  const body = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new Response(body, {
    headers: {
      ...baseHeaders,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

async function sha(s: string): Promise<string> {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

const fmtCode = (c: string) => c.slice(0, 4) + '-' + c.slice(4);
const devOnly = (env: Env) => env.APP_ENV === 'local' && env.DEV_MODE === '1';

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // ───────── WebSocket ─────────
  if (path === '/ws') {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'UPGRADE' }, 426);
    const origin = req.headers.get('Origin');
    if (!origin || !allowedOrigins(req, env).has(origin)) return json({ error: 'ORIGIN' }, 403);
    const role = url.searchParams.get('role');
    const h = new Headers(req.headers);
    for (const k of [...h.keys()]) if (k.startsWith('x-quiz')) h.delete(k);
    h.delete('Cookie');
    let ev: string;
    if (role === 'p') {
      const t = await session<PlayerToken>(req, env, 'p');
      if (!t) return json({ error: 'NO_SESSION' }, 401);
      ev = t.e;
      h.set('x-quiz-role', 'p');
      h.set('x-quiz-pid', String(t.p));
      h.set('x-quiz-gen', String(t.g));
    } else if (role === 'b') {
      const t = await session<BoardToken>(req, env, 'b');
      if (!t) return json({ error: 'NO_SESSION' }, 401);
      ev = t.e;
      h.set('x-quiz-role', 'b');
      h.set('x-quiz-k', String(t.k));
    } else if (role === 'h') {
      await requireHost(req, env);
      ev = eventParam(url.searchParams.get('event'));
      h.set('x-quiz-role', 'h');
    } else return json({ error: 'ROLE' }, 400);
    return eventStub(env, ev).fetch(new Request(req.url, { method: 'GET', headers: h }));
  }

  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
  if (method === 'POST') checkMutation(req, env);

  // ───────── 참가자 ─────────
  if (path === '/api/join' && method === 'POST') {
    const b = await readJson(req);
    const ev = normalizeCode(b.event);
    const code = normalizeCode(b.code);
    if (ev.length !== EVENT_CODE_LEN) throw new HttpError(400, 'BAD_EVENT', '행사 코드를 확인하세요. (6자리)');
    if (code.length !== PART_CODE_LEN) throw new HttpError(400, 'BAD_CODE', '참가 코드를 확인하세요. (8자리)');
    const hash = await codeHash(env.SESSION_SECRET, ev, code);
    const t0 = Date.now();
    const r = await eventStub(env, ev).join(hash, clientIp(req));
    const timing = { 'server-timing': `do;dur=${Date.now() - t0}` };
    if (!r.ok) {
      if (r.error === 'NO_EVENT') throw new HttpError(404, 'NO_EVENT', '행사 코드를 찾을 수 없습니다.');
      if (r.error === 'RATE') throw new HttpError(429, 'RATE', '실패한 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
      throw new HttpError(401, 'BAD_CODE', '참가 코드가 올바르지 않습니다.');
    }
    const token = await signToken(env.SESSION_SECRET, { r: 'p', e: ev, p: r.pid, g: r.gen, x: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC.p });
    return json({ ok: true, name: r.name, event: ev, title: r.title }, 200, {
      ...timing,
      'set-cookie': cookieHeader(COOKIE.p, token, SESSION_TTL_SEC.p, isSecure(req)),
    });
  }

  if (path === '/api/me' && method === 'GET') {
    const t = await session<PlayerToken>(req, env, 'p');
    if (!t) throw new HttpError(401, 'NO_SESSION', '입장이 필요합니다.');
    const r = await eventStub(env, t.e).hello(t.p, t.g);
    if (!r.ok) {
      if (r.error === 'KICKED') throw new HttpError(409, 'KICKED', '다른 기기에서 같은 참가 코드로 입장해 이 기기의 연결이 끝났습니다.');
      throw new HttpError(401, 'NO_SESSION', '입장 정보가 없습니다. 다시 입장하세요.');
    }
    return json({ ok: true, name: r.name, title: r.title, event: r.ev });
  }

  if (path === '/api/answer' && method === 'POST') {
    const t = await session<PlayerToken>(req, env, 'p');
    if (!t) throw new HttpError(401, 'NO_SESSION', '입장이 필요합니다.');
    const b = await readJson<SubmitBody>(req);
    // 참가자 ID 는 서명된 쿠키에서만 가져온다(본문의 값은 믿지 않는다)
    const t0 = Date.now();
    const r = await eventStub(env, t.e).submit(t.p, t.g, { qid: b.qid, run: b.run, seq: b.seq, reqId: b.reqId, text: b.text });
    // Durable Object 왕복 시간(대기열 포함). 부하 시험에서 네트워크 지연과 구분하는 데 쓴다.
    return json(r, r.status === 'rate_limited' ? 429 : 200, { 'server-timing': `do;dur=${Date.now() - t0}` });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(COOKIE.p, '', 0, isSecure(req)) });
  }

  // ───────── 전광판 ─────────
  if (path === '/api/board/login' && method === 'POST') {
    const b = await readJson(req);
    const ev = eventParam(b.event);
    const key = typeof b.key === 'string' ? b.key : '';
    if (key.length < 20 || key.length > 100) throw new HttpError(401, 'BAD_KEY', '전광판 링크가 올바르지 않습니다.');
    const r = await eventStub(env, ev).boardLogin(await sha(key));
    if (!r.ok) throw new HttpError(401, 'BAD_KEY', '전광판 링크가 올바르지 않거나 교체되었습니다. 진행자 화면에서 새 링크를 받으세요.');
    const token = await signToken(env.SESSION_SECRET, { r: 'b', e: ev, k: r.k, x: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC.b });
    return json({ ok: true, event: ev }, 200, { 'set-cookie': cookieHeader(COOKIE.b, token, SESSION_TTL_SEC.b, isSecure(req)) });
  }
  if (path === '/api/board/session' && method === 'GET') {
    const t = await session<BoardToken>(req, env, 'b');
    if (!t) throw new HttpError(401, 'NO_SESSION', '전광판 링크로 다시 접속하세요.');
    return json({ ok: true, event: t.e });
  }

  // ───────── 진행자 ─────────
  if (path === '/api/host/login' && method === 'POST') {
    const b = await readJson(req);
    if (!env.HOST_PASSWORD || env.HOST_PASSWORD.length < 12) throw new HttpError(500, 'CONFIG', '서버에 진행자 비밀번호가 설정되지 않았습니다.');
    const ip = clientIp(req);
    const sys = sysStub(env);
    if (!(await sys.hostLoginAllowed(ip))) throw new HttpError(429, 'RATE', '로그인 실패가 많아 10분간 잠겼습니다.');
    const pw = typeof b.password === 'string' ? b.password : '';
    if (!(await safeEqual(pw, env.HOST_PASSWORD))) {
      await sys.hostLoginFailed(ip);
      throw new HttpError(401, 'BAD_PASSWORD', '비밀번호가 올바르지 않습니다.');
    }
    const token = await signToken(env.SESSION_SECRET, { r: 'h', x: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC.h });
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(COOKIE.h, token, SESSION_TTL_SEC.h, isSecure(req)) });
  }
  if (path === '/api/host/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(COOKIE.h, '', 0, isSecure(req)) });
  }
  if (path === '/api/host/session' && method === 'GET') {
    return json({ host: !!(await session<HostToken>(req, env, 'h')), devTools: devOnly(env) });
  }

  if (path.startsWith('/api/host/')) {
    await requireHost(req, env);

    if (path === '/api/host/events' && method === 'POST') {
      const b = await readJson(req);
      const title = (typeof b.title === 'string' ? b.title : '').replace(/[\p{Cc}<>]/gu, '').trim().slice(0, 40) || '축제 퀴즈';
      for (let i = 0; i < 5; i++) {
        const code = randomCode(EVENT_CODE_LEN);
        const r = await eventStub(env, code).init(code, title, QUESTIONS.map((q) => q.id));
        if (r.ok) return json({ ok: true, event: code });
      }
      throw new HttpError(500, 'CREATE', '행사를 만들지 못했습니다. 다시 시도하세요.');
    }

    if (path === '/api/host/view' && method === 'GET') {
      const ev = eventParam(url.searchParams.get('event'));
      const stub = eventStub(env, ev);
      if (!(await stub.exists()).exists) throw new HttpError(404, 'NO_EVENT', '행사를 찾을 수 없습니다.');
      return json(await stub.hostView());
    }

    if (path === '/api/host/cmd' && method === 'POST') {
      const b = await readJson(req);
      const ev = eventParam(b.event);
      const cmd = typeof b.cmd === 'string' ? b.cmd : '';
      const args = (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>;
      const cmdId = typeof b.cmdId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.cmdId) ? b.cmdId : '';
      const sv = Number(b.sv) || 0;
      if (cmd === 'restart' && !devOnly(env)) throw new HttpError(403, 'DEV_ONLY', '로컬 개발 환경에서만 쓸 수 있는 기능입니다.');
      const stub = eventStub(env, ev);
      if (cmd === 'boardKey') {
        const key = randomToken(24);
        const r = await stub.hostCmd('boardKey', { hash: await sha(key) }, cmdId, sv);
        return json(r.ok ? { ...r, link: `${url.origin}/board#k=${ev}.${key}` } : r, r.ok ? 200 : 409);
      }
      if (cmd === '') throw new HttpError(400, 'CMD', '잘못된 명령입니다.');
      const r = await stub.hostCmd(cmd, args, cmdId, sv);
      return json(r, r.ok ? 200 : 409);
    }

    if (path === '/api/host/codes' && method === 'POST') {
      const b = await readJson(req);
      const ev = eventParam(b.event);
      const count = Number(b.count);
      const kind = typeof b.kind === 'string' ? b.kind : '';
      if (!['student', 'teacher', 'load'].includes(kind)) throw new HttpError(400, 'KIND', '구분이 올바르지 않습니다.');
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, 'COUNT', '한 번에 1~1000개까지 만들 수 있습니다.');
      const stub = eventStub(env, ev);
      if (!(await stub.exists()).exists) throw new HttpError(404, 'NO_EVENT', '행사를 찾을 수 없습니다.');
      let pending = count;
      let inserted = 0;
      for (let attempt = 0; attempt < 4 && pending > 0; attempt++) {
        const items = [];
        for (let i = 0; i < pending; i++) {
          const c = randomCode(PART_CODE_LEN);
          items.push({ hash: await codeHash(env.SESSION_SECRET, ev, c), enc: await encryptCode(env.SESSION_SECRET, c), kind });
        }
        const r = await stub.addParticipants(items);
        inserted += r.inserted;
        pending = r.failed.length;
        if (r.inserted === 0) break; // 최대 인원 초과 등
      }
      return json({ ok: true, inserted, requested: count });
    }

    if (path === '/api/host/export/codes' && method === 'GET') {
      const ev = eventParam(url.searchParams.get('event'));
      const rows = await eventStub(env, ev).exportCodes();
      const kindKo: Record<string, string> = { student: '학생', teacher: '교사', load: '부하시험' };
      const out: unknown[][] = [['이름', '구분', '행사코드', '참가코드', '입장주소']];
      for (const r of rows) {
        const c = await decryptCode(env.SESSION_SECRET, r.enc);
        out.push([r.name, kindKo[r.kind] ?? r.kind, ev, fmtCode(c), `${url.origin}/?e=${ev}`]);
      }
      return csv(out, `codes-${ev}.csv`);
    }

    if (path === '/api/host/export/results' && method === 'GET') {
      const ev = eventParam(url.searchParams.get('event'));
      const data = await eventStub(env, ev).exportResults();
      if (!data) throw new HttpError(404, 'NO_EVENT', '행사를 찾을 수 없습니다.');
      if (url.searchParams.get('format') === 'json') return json(data);
      const head = ['이름', '구분'];
      for (const r of data.runs) head.push(`${r.qNo}번 답안${r.voided ? '(무효)' : ''}`, `${r.qNo}번 정답여부`);
      head.push('총점(무효 제외)');
      const out: unknown[][] = [head];
      for (const row of data.rows) {
        const line: unknown[] = [row.name, row.kind];
        for (const c of row.cells) line.push(c?.text ?? '', c ? (c.correct ? 'O' : 'X') : '');
        line.push(row.score);
        out.push(line);
      }
      return csv(out, `results-${ev}.csv`);
    }
  }

  return json({ error: 'NOT_FOUND', message: '없는 주소입니다.' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      if (e instanceof ConfigError) return json({ error: 'CONFIG', message: '서버 설정 오류입니다. 관리자에게 문의하세요.' }, 500);
      const msg = String((e as Error)?.message ?? e);
      const overloaded = /overloaded/i.test(msg);
      // 참가 코드·세션 값은 로그에 남기지 않는다. 오류 종류만 기록한다.
      console.error('요청 처리 오류', new URL(req.url).pathname, overloaded ? 'overloaded' : (e as Error)?.name);
      return json(
        { error: overloaded ? 'OVERLOADED' : 'INTERNAL', message: overloaded ? '서버가 바쁩니다. 잠시 후 자동으로 다시 시도합니다.' : '서버 오류가 발생했습니다.' },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;

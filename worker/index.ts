// Worker: 인증·Origin/CSRF 검사·요청 라우팅.
// 세션 서명 검증·코드 해시·암호화처럼 상태가 필요 없는 CPU 작업은 여기(여러 인스턴스로 분산)에서 하고,
// 행사 Durable Object 에는 검증된 참가자 ID 와 최소한의 일만 넘긴다.

import { QUESTION_SETS, SET_BY_ID } from './quiz/bank';
import { validateQuestion } from './quiz/validate';
import { LibraryDO, MAX_MEDIA_BYTES } from './library-do';
import { cleanAnswer, isCorrect, normKey } from './quiz/grading';
import { EventDO, type JoinResult, type SubmitBody } from './event-do';
import { JOIN_KINDS, cleanName } from '../shared/protocol';
import { BotsDO } from './bots-do';
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

export { EventDO, BotsDO, LibraryDO };

const MEDIA_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png', 'image/gif']);

function libraryStub(env: Env): DurableObjectStub<LibraryDO> {
  return env.LIBRARY.get(env.LIBRARY.idFromName('library')) as DurableObjectStub<LibraryDO>;
}

const MAX_BOTS = 200;

function botsStub(env: Env, ev: string): DurableObjectStub<BotsDO> {
  return env.BOTS.get(env.BOTS.idFromName('bots:' + ev)) as DurableObjectStub<BotsDO>;
}

/** 참가 코드를 만들어 행사에 등록하고, 등록된 코드(평문)와 이름을 돌려준다 */
async function createCodes(env: Env, stub: DurableObjectStub<EventDO>, ev: string, count: number, kind: string) {
  let pending = count;
  const made: { code: string; name: string }[] = [];
  for (let attempt = 0; attempt < 4 && pending > 0; attempt++) {
    const plain: string[] = [];
    const items = [];
    for (let i = 0; i < pending; i++) {
      const c = randomCode(PART_CODE_LEN);
      plain.push(c);
      items.push({ hash: await codeHash(env.SESSION_SECRET, ev, c), enc: await encryptCode(env.SESSION_SECRET, c), kind });
    }
    const r = await stub.addParticipants(items);
    r.names.forEach((n, i) => n && made.push({ code: plain[i], name: n }));
    pending = r.failed.length;
    if (r.inserted === 0) break; // 최대 인원 초과 등
  }
  return made;
}

const KIND_KO: Record<string, string> = { student: '학생', parent: '학부모', visitor: '관람객', teacher: '교사', load: '부하시험', bot: '연습봇' };

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
  // 사진 올리기만 이진 본문을 받는다(그 경로에서 형식을 따로 검사)
  if (new URL(req.url).pathname === '/api/host/media') return;
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

  // 문제 사진(진행자가 올린 것). ID 가 내용 해시라 바뀌지 않으므로 오래 캐시한다.
  const media = path.match(/^\/api\/media\/([a-f0-9]{32})$/);
  if (media && method === 'GET') {
    const m = await libraryStub(env).getMedia(media[1]);
    if (!m) return json({ error: 'NOT_FOUND', message: '사진을 찾을 수 없습니다.' }, 404);
    return new Response(m.data, {
      headers: { 'content-type': m.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
    });
  }
  if (method === 'POST') checkMutation(req, env);

  // ───────── 참가자 ─────────
  if (path === '/api/join' && method === 'POST') {
    const b = await readJson(req);
    const ev = normalizeCode(b.event);
    if (ev.length !== EVENT_CODE_LEN) throw new HttpError(400, 'BAD_EVENT', '행사 코드를 확인하세요. (6자리)');
    const t0 = Date.now();
    let r: JoinResult;
    if (b.code !== undefined) {
      // 진행자가 만든 참가 코드로 입장(부하 시험 도구·예전 행사)
      const code = normalizeCode(b.code);
      if (code.length !== PART_CODE_LEN) throw new HttpError(400, 'BAD_CODE', '참가 코드를 확인하세요. (8자리)');
      r = await eventStub(env, ev).join(await codeHash(env.SESSION_SECRET, ev, code), clientIp(req));
    } else {
      // 구분을 고르고 이름을 써서 입장. 연습용 봇은 진행자 토큰을 머리글로 보내 'bot' 구분이 된다.
      let kind = typeof b.kind === 'string' ? b.kind : '';
      if (kind === 'bot' || !JOIN_KINDS.some((k) => k.id === kind)) {
        const bot = await verifyToken(env.SESSION_SECRET, req.headers.get('x-quiz-bot'));
        if (kind !== 'bot' || bot?.r !== 'h') throw new HttpError(400, 'BAD_KIND', '학생·학부모·관람객 중 하나를 고르세요.');
      }
      const name = cleanName(b.name).trim();
      if (!name) throw new HttpError(400, 'BAD_NAME', '이름을 입력하세요. (한글·영문·숫자 10자까지)');
      r = await eventStub(env, ev).register(kind, name, clientIp(req));
    }
    const timing = { 'server-timing': `do;dur=${Date.now() - t0}` };
    if (!r.ok) {
      if (r.error === 'NO_EVENT') throw new HttpError(404, 'NO_EVENT', '행사 코드를 찾을 수 없습니다.');
      if (r.error === 'RATE') throw new HttpError(429, 'RATE', '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
      if (r.error === 'FULL') throw new HttpError(409, 'FULL', '참가 인원이 가득 찼습니다.');
      if (r.error === 'BAD_NAME') throw new HttpError(400, 'BAD_NAME', '이름을 확인하세요.');
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

    // ───── 문제세트: 코드의 기본 세트(수정 불가) + 진행자가 만든 세트(LibraryDO) ─────
    const lib = libraryStub(env);
    const findSet = async (id: string) => {
      const s = SET_BY_ID.get(id);
      if (s) return { id: s.id, title: s.title, questions: s.questions, editable: false };
      if (!/^lib-[a-z0-9]{1,20}$/.test(id)) return null;
      const l = await lib.getSet(id);
      return l ? { ...l, editable: true } : null;
    };
    const setTitle = (v: unknown) => (typeof v === 'string' ? v : '').replace(/[\p{Cc}<>]/gu, '').trim().slice(0, 40);

    // 목록(제목·문항 수만)
    if (path === '/api/host/sets' && method === 'GET') {
      const builtIn = QUESTION_SETS.map((s) => ({ id: s.id, title: s.title, count: s.questions.length, editable: false }));
      const mine = (await lib.listSets()).map((s) => ({ id: s.id, title: s.title, count: s.count, editable: true }));
      return json([...mine, ...builtIn]);
    }
    // 새 세트
    if (path === '/api/host/sets' && method === 'POST') {
      const b = await readJson(req);
      const title = setTitle(b.title);
      if (!title) throw new HttpError(400, 'TITLE', '세트 이름을 입력하세요.');
      const r = await lib.createSet(title);
      if (!r.ok) throw new HttpError(400, 'LIMIT', r.message);
      return json({ ok: true, id: r.id });
    }

    const setPath = path.match(/^\/api\/host\/sets\/([a-z0-9-]{1,40})(?:\/(delete|order|questions)(?:\/([a-z0-9-]{1,40})(?:\/(delete))?)?)?$/);
    if (setPath) {
      const [, sid, sub, qid, qsub] = setPath;
      // 상세(진행자 전용: 정답·인정 답안·해설 포함)
      if (!sub && method === 'GET') {
        const set = await findSet(sid);
        if (!set) throw new HttpError(404, 'SET', '없는 문제세트입니다.');
        return json(set);
      }
      if (method !== 'POST') throw new HttpError(405, 'METHOD', '잘못된 요청입니다.');
      if (!sid.startsWith('lib-')) throw new HttpError(403, 'READONLY', '기본 세트는 고칠 수 없습니다. 새 세트를 만드세요.');
      const b = await readJson(req);
      if (!sub) {
        const title = setTitle(b.title);
        if (!title) throw new HttpError(400, 'TITLE', '세트 이름을 입력하세요.');
        if (!(await lib.renameSet(sid, title))) throw new HttpError(404, 'SET', '없는 문제세트입니다.');
        return json({ ok: true });
      }
      if (sub === 'delete') {
        if (!(await lib.deleteSet(sid))) throw new HttpError(404, 'SET', '없는 문제세트입니다.');
        return json({ ok: true });
      }
      if (sub === 'order') {
        const qids = Array.isArray(b.qids) ? b.qids.filter((x): x is string => typeof x === 'string') : [];
        if (!(await lib.reorder(sid, qids))) throw new HttpError(404, 'SET', '없는 문제세트입니다.');
        return json({ ok: true });
      }
      if (sub === 'questions' && qsub === 'delete' && qid) {
        if (!(await lib.deleteQuestion(sid, qid))) throw new HttpError(404, 'QID', '문제를 찾을 수 없습니다.');
        return json({ ok: true });
      }
      if (sub === 'questions' && !qsub) {
        const v = validateQuestion(b);
        if (!v.ok) throw new HttpError(400, 'INVALID', v.message);
        const r = await lib.saveQuestion(sid, qid ?? null, v.q);
        if (!r.ok) throw new HttpError(400, 'SAVE', r.message);
        return json({ ok: true, question: r.question });
      }
      throw new HttpError(404, 'NOT_FOUND', '없는 주소입니다.');
    }

    // 사진 올리기(이진 본문). 화면에서 미리 줄인 WebP/JPEG/PNG/GIF
    if (path === '/api/host/media' && method === 'POST') {
      const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!MEDIA_TYPES.has(type)) throw new HttpError(415, 'TYPE', '사진 형식은 WebP·JPEG·PNG·GIF 만 됩니다.');
      if (Number(req.headers.get('content-length') ?? '0') > MAX_MEDIA_BYTES) throw new HttpError(413, 'TOO_LARGE', '사진이 너무 큽니다(1.9MB 이하).');
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_MEDIA_BYTES) throw new HttpError(413, 'TOO_LARGE', '사진이 너무 큽니다(1.9MB 이하).');
      const r = await lib.putMedia(buf, type);
      if (!r.ok) throw new HttpError(400, 'MEDIA', r.message);
      return json({ ok: true, id: r.id, url: `/api/media/${r.id}` });
    }

    // 혼자 풀기 채점: 행사와 같은 서버 채점 규칙(정규화 + 인정 답안 정확 일치). 저장하지 않는다.
    if (path === '/api/host/check' && method === 'POST') {
      const b = await readJson(req);
      const set = typeof b.set === 'string' ? await findSet(b.set) : null;
      const q = set?.questions.find((x) => x.id === b.qid);
      if (!q) throw new HttpError(404, 'QID', '없는 문제입니다.');
      const text = typeof b.text === 'string' ? b.text.slice(0, 100) : '';
      return json({
        correct: isCorrect(text, q.accepted, q.rules),
        text: cleanAnswer(text),
        norm: normKey(text, q.rules),
        answerDisplay: q.answerDisplay,
        explanation: q.explanation,
      });
    }

    if (path === '/api/host/events' && method === 'POST') {
      const b = await readJson(req);
      const set = await findSet(typeof b.set === 'string' ? b.set : 'basic');
      if (!set) throw new HttpError(400, 'SET', '없는 문제세트입니다.');
      if (!set.questions.length) throw new HttpError(400, 'EMPTY', '문제가 없는 세트입니다. 문제를 먼저 넣으세요.');
      const title = setTitle(b.title) || '축제 퀴즈';
      for (let i = 0; i < 5; i++) {
        const code = randomCode(EVENT_CODE_LEN);
        // 세트의 지금 내용을 행사에 복사한다(이후 세트를 고쳐도 이 행사는 그대로)
        const r = await eventStub(env, code).init(code, title, set.questions);
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
      // 'bot' 은 봇 실행 API 로만. 참가자는 코드 없이 직접 입장하므로 여기서 만드는 코드는 도구·예전 방식용이다.
      if (!['student', 'teacher', 'load'].includes(kind)) throw new HttpError(400, 'KIND', '구분이 올바르지 않습니다.');
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, 'COUNT', '한 번에 1~1000개까지 만들 수 있습니다.');
      const stub = eventStub(env, ev);
      if (!(await stub.exists()).exists) throw new HttpError(404, 'NO_EVENT', '행사를 찾을 수 없습니다.');
      const made = await createCodes(env, stub, ev, count, kind);
      return json({ ok: true, inserted: made.length, requested: count });
    }

    // 연습용 봇: 실제 참가 경로(입장·WebSocket·답안 API)로 움직이는 가짜 참가자
    if (path === '/api/host/bots' && method === 'GET') {
      const ev = eventParam(url.searchParams.get('event'));
      return json(await botsStub(env, ev).status());
    }
    if (path === '/api/host/bots' && method === 'POST') {
      const b = await readJson(req);
      const ev = eventParam(b.event);
      const stub = eventStub(env, ev);
      if (!(await stub.exists()).exists) throw new HttpError(404, 'NO_EVENT', '행사를 찾을 수 없습니다.');
      const bots = botsStub(env, ev);
      if (b.action === 'stop') {
        const r = await bots.stop();
        const r2 = await stub.removeBots(); // 실행기가 재시작돼 기억을 잃었어도 남은 봇 자료를 걷어낸다
        return json({ ok: true, removed: r.removed + r2.removed, status: await bots.status() });
      }
      if (b.action === 'start') {
        const count = Number(b.count);
        if (!Number.isInteger(count) || count < 1 || count > MAX_BOTS) throw new HttpError(400, 'COUNT', `봇은 1~${MAX_BOTS}명까지 부를 수 있습니다.`);
        await bots.stop(); // 이전 봇 정지
        await stub.removeBots(); // 남아 있던 봇 자료 정리
        const status = await bots.start(ev, url.origin, count, await stub.questionsForBots());
        return json({ ok: true, status });
      }
      throw new HttpError(400, 'ACTION', '잘못된 요청입니다.');
    }

    if (path === '/api/host/export/codes' && method === 'GET') {
      const ev = eventParam(url.searchParams.get('event'));
      const rows = await eventStub(env, ev).exportCodes();
      const out: unknown[][] = [['이름', '구분', '행사코드', '참가코드', '입장주소']];
      for (const r of rows) {
        const c = await decryptCode(env.SESSION_SECRET, r.enc);
        out.push([r.name, KIND_KO[r.kind] ?? r.kind, ev, fmtCode(c), `${url.origin}/?e=${ev}`]);
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
        const line: unknown[] = [row.name, KIND_KO[row.kind] ?? row.kind];
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

// 실제 참가자·진행자가 쓰는 경로(로그인 API·쿠키 세션·WebSocket·답안 API)를 그대로 쓰는 클라이언트.
// E2E 테스트와 부하 시험이 함께 쓴다. 우회 경로는 없다.

import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

export const rid = () => randomBytes(12).toString('base64url');

export class Http {
  constructor(base, opts = {}) {
    this.base = base.replace(/\/$/, '');
    this.origin = opts.origin ?? this.base;
    this.cookies = new Map();
    this.extraHeaders = opts.headers ?? {};
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  takeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  /** @returns {Promise<{status:number, data:any, ms:number, text?:string}>} */
  /** @param {string} method @param {string} path @param {unknown} [body] @param {{timeoutMs?: number, headers?: Record<string, string>}} [o] */
  async req(method, path, body, { timeoutMs = 15000, headers = {} } = {}) {
    const h = { ...this.extraHeaders, ...headers };
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      h['x-quiz'] = '1';
      h.origin = h.origin ?? this.origin;
    }
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      this.takeCookies(res);
      const st = res.headers.get('server-timing');
      const m = st && st.match(/do;dur=(\d+)/);
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* CSV 등 */
      }
      return { status: res.status, data, text, ms: performance.now() - t0, serverMs: m ? Number(m[1]) : null };
    } catch (e) {
      return { status: 0, data: null, error: e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code ?? e?.message ?? e), ms: performance.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
  get(path, o) {
    return this.req('GET', path, undefined, o);
  }
  post(path, body, o) {
    return this.req('POST', path, body ?? {}, o);
  }

  /** WebSocket 연결. onMessage 로 JSON 메시지를 받는다. */
  /** @param {string} path @param {(m: any) => void} onMessage @param {{origin?: string}} [o] */
  ws(path, onMessage, { origin } = {}) {
    const url = this.base.replace(/^http/, 'ws') + path;
    const sock = new WebSocket(url, {
      headers: { origin: origin ?? this.origin, cookie: this.cookieHeader(), ...this.extraHeaders },
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    });
    sock.on('message', (buf) => {
      const s = buf.toString();
      if (s === 'pong') return;
      try {
        onMessage(JSON.parse(s));
      } catch {
        /* 무시 */
      }
    });
    return sock;
  }
}

export async function hostLogin(base, password, opts) {
  const h = new Http(base, opts);
  const r = await h.post('/api/host/login', { password });
  if (r.status !== 200) throw new Error('진행자 로그인 실패: ' + r.status + ' ' + JSON.stringify(r.data));
  return h;
}

export class Host {
  constructor(http, event) {
    this.http = http;
    this.event = event;
    this.view = null;
  }
  static async create(http, title = '자동 시험') {
    const r = await http.post('/api/host/events', { title });
    if (r.status !== 200) throw new Error('행사 생성 실패 ' + r.status);
    return new Host(http, r.data.event);
  }
  async refresh() {
    const r = await this.http.get('/api/host/view?event=' + this.event);
    if (r.status === 200) this.view = r.data;
    return r;
  }
  /** @param {string} cmd @param {Record<string, unknown>} [args] @param {{cmdId?: string, sv?: number}} [o] */
  async cmd(cmd, args = {}, { cmdId = rid(), sv } = {}) {
    if (sv === undefined) {
      await this.refresh();
      sv = this.view.sv;
    }
    const r = await this.http.post('/api/host/cmd', { event: this.event, cmd, args, cmdId, sv });
    if (r.data?.view) this.view = r.data.view;
    return r;
  }
  async mustCmd(cmd, args = {}) {
    const r = await this.cmd(cmd, args);
    if (r.status !== 200 || !r.data?.ok) throw new Error(`명령 실패 ${cmd}: ${r.status} ${JSON.stringify(r.data?.message ?? r.data)}`);
    return r;
  }
  async genCodes(count, kind = 'student') {
    let left = count;
    while (left > 0) {
      const n = Math.min(1000, left);
      const r = await this.http.post('/api/host/codes', { event: this.event, count: n, kind }, { timeoutMs: 120000 });
      if (r.status !== 200) throw new Error('코드 생성 실패 ' + r.status + ' ' + JSON.stringify(r.data));
      left -= n;
    }
  }
  /** CSV 를 읽어 [{name, kind, code}] 로 돌려준다 */
  async codes() {
    const r = await this.http.get('/api/host/export/codes?event=' + this.event, { timeoutMs: 120000 });
    if (r.status !== 200) throw new Error('코드 내보내기 실패 ' + r.status);
    return parseCodesCsv(r.text);
  }
  async results() {
    const r = await this.http.get('/api/host/export/results?event=' + this.event + '&format=json', { timeoutMs: 60000 });
    if (r.status !== 200) throw new Error('결과 내보내기 실패 ' + r.status);
    return r.data;
  }
}

export function parseCodesCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1);
  return lines.map((l) => {
    const [name, kind, event, code] = l.split(',');
    return { name, kind, event, code };
  });
}

/** 참가자 한 명. 실제 휴대폰 화면과 같은 순서로 동작한다. */
export class Bot {
  constructor(base, opts = {}) {
    this.http = new Http(base, opts);
    this.sock = null;
    this.view = null;
    this.me = null;
    this.messages = [];
    this.kicked = false;
    this.closeCode = null;
    this.waiters = [];
    this.seqByRun = new Map();
    this.keepMessages = opts.keepMessages ?? false;
  }
  async join(event, code) {
    const r = await this.http.post('/api/join', { event, code });
    if (r.status === 200) this.name = r.data.name;
    return r;
  }
  connect() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (!done) {
          done = true;
          resolve(ok);
        }
      };
      this.closeCode = null;
      const s = this.http.ws('/ws?role=p', (m) => {
        if (this.keepMessages) this.messages.push(m);
        if (m.t === 'kicked') this.kicked = true;
        if (m.t === 'state') {
          this.view = m;
          if (m.me !== undefined) this.me = m.me;
          finish(true);
        }
        this.waiters = this.waiters.filter((w) => !w(this));
      });
      this.sock = s;
      s.on('close', (code) => {
        this.closeCode = code;
        if (code === 4001) this.kicked = true;
        finish(false);
      });
      s.on('error', () => finish(false));
      s.on('unexpected-response', () => finish(false));
    });
  }
  waitFor(pred, timeoutMs = 10000) {
    if (pred(this)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve(false);
      }, timeoutMs);
      const check = (b) => {
        if (pred(b)) {
          clearTimeout(t);
          resolve(true);
          return true;
        }
        return false;
      };
      this.waiters.push(check);
    });
  }
  nextSeq(run) {
    const n = (this.seqByRun.get(run) ?? 0) + 1;
    this.seqByRun.set(run, n);
    return n;
  }
  /** 현재 화면의 문제에 답을 보낸다. seq·reqId 를 지정하면 재시도·순서 뒤바뀜을 흉내 낼 수 있다. */
  /** @param {string} text @param {{seq?: number, reqId?: string, run?: number, qid?: string, timeoutMs?: number}} [o] */
  submit(text, { seq, reqId = rid(), run, qid, timeoutMs } = {}) {
    const v = this.view;
    const r = run ?? v?.run ?? 0;
    const body = { qid: qid ?? v?.qid ?? 'none', run: r, seq: seq ?? this.nextSeq(r), reqId, text };
    return this.http.post('/api/answer', body, { timeoutMs }).then((res) => ({ ...res, body }));
  }
  disconnect() {
    try {
      this.sock?.terminate();
    } catch {
      /* 무시 */
    }
    this.sock = null;
  }
}

export function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 동시 실행 개수 제한 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

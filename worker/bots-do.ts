// 연습용 봇 실행기 — 행사 하나에 Object 하나.
//
// ★ 봇은 진짜 참가자와 같은 경로로만 움직인다.
//   입장: POST /api/join (참가 코드 → 쿠키)  ·  상태: GET /ws?role=p (쿠키·Origin 검사)  ·  답안: POST /api/answer
//   모두 SELF 서비스 바인딩으로 이 Worker 의 fetch 핸들러를 거친다(인증·Origin·CSRF 검사 그대로).
//   진짜 휴대폰이 답을 보내는 시점 = WebSocket 으로 'open' 상태를 받은 뒤 사람이 입력·제출하는 시점.
//   그 시점이 바뀌면(예: 제출 방식 변경) 이 파일도 같이 고칠 것.
//
// 봇 데이터는 서버에서 지운다: 중지·자동 종료(60분) 때 EventDO.removeBots() 로 참가자·답안·결과를 지우고 다시 채점한다.

import { DurableObject } from 'cloudflare:workers';
import { QUESTION_BY_ID } from './quiz/bank';
import type { PlayerView, SubmitResult } from '../shared/protocol';
import type { EventDO } from './event-do';

const MAX_RUN_MS = 60 * 60_000;

interface Persona {
  silent: boolean; // 끝까지 답을 안 내는 사람
  accuracy: number; // 맞힐 확률
  paceMin: number; // 제출까지 최소 시간(ms)
  paceMax: number;
  revise: boolean; // 한 번 냈다가 고치는 사람
  late: boolean; // 마감 직전·직후에 누르는 사람
}

interface Bot {
  i: number;
  name: string;
  code: string;
  cookie: string;
  ws: WebSocket | null;
  view: PlayerView | null;
  run: number;
  seq: number;
  persona: Persona;
  timers: ReturnType<typeof setTimeout>[];
  retry: number;
  dead: boolean;
}

export interface BotStatus {
  running: boolean;
  event: string | null;
  total: number;
  joined: number;
  connected: number;
  submitted: number; // 접수 응답을 받은 제출(수정 포함)
  rejected: Record<string, number>;
  errors: number;
  startedAt: number | null;
  stopsAt: number | null;
  lastError: string | null;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

/** 사람마다 다른 실력·속도. 번호로 정해 매번 비슷한 분포가 나오게 한다. */
function personaFor(i: number): Persona {
  const k = i % 20;
  return {
    silent: k === 7 || k === 13, // 10%: 답을 안 냄
    accuracy: k < 3 ? 0.3 : k < 15 ? 0.8 : 0.95, // 15% 약함, 60% 보통, 25% 강함
    paceMin: k >= 15 ? 1500 : 3000,
    paceMax: k >= 15 ? 7000 : 15000,
    revise: k % 6 === 1, // 약 15%: 냈다가 고침
    late: k === 19, // 5%: 마감 직전·직후
  };
}

export class BotsDO extends DurableObject<Env> {
  private bots: Bot[] = [];
  private ev: string | null = null;
  private origin = '';
  private startedAt: number | null = null;
  private stopsAt: number | null = null;
  private stats = { submitted: 0, rejected: {} as Record<string, number>, errors: 0, lastError: null as string | null };
  private stopping = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  status(): BotStatus {
    return {
      running: this.bots.length > 0 && !this.stopping,
      event: this.ev,
      total: this.bots.length,
      joined: this.bots.filter((b) => b.cookie).length,
      connected: this.bots.filter((b) => b.ws && b.ws.readyState === WebSocket.OPEN).length,
      submitted: this.stats.submitted,
      rejected: this.stats.rejected,
      errors: this.stats.errors,
      startedAt: this.startedAt,
      stopsAt: this.stopsAt,
      lastError: this.stats.lastError,
    };
  }

  /** 봇 시작. codes 는 방금 만든 봇용 참가 코드(평문). 입장은 joinSpreadMs 동안 흩어서 한다. */
  async start(ev: string, origin: string, codes: { code: string; name: string }[], joinSpreadMs = 8000): Promise<BotStatus> {
    await this.halt();
    this.stopping = false;
    this.ev = ev;
    this.origin = origin;
    this.startedAt = Date.now();
    this.stopsAt = this.startedAt + MAX_RUN_MS;
    this.stats = { submitted: 0, rejected: {}, errors: 0, lastError: null };
    this.bots = codes.map((c, i) => ({
      i,
      name: c.name,
      code: c.code,
      cookie: '',
      ws: null,
      view: null,
      run: 0,
      seq: 0,
      persona: personaFor(i),
      timers: [],
      retry: 0,
      dead: false,
    }));
    for (const b of this.bots) b.timers.push(setTimeout(() => this.join(b), rnd(0, joinSpreadMs)));
    // 진짜 화면과 같은 25초 ping (서버 런타임이 Object 를 깨우지 않고 pong 으로 답함)
    this.pingTimer = setInterval(() => {
      for (const b of this.bots) if (b.ws?.readyState === WebSocket.OPEN) b.ws.send('ping');
    }, 25_000);
    await this.ctx.storage.setAlarm(this.stopsAt);
    return this.status();
  }

  /** 연결을 끊고 서버에서 봇 데이터를 지운다 */
  async stop(): Promise<{ removed: number }> {
    const ev = this.ev;
    await this.halt();
    if (!ev) return { removed: 0 };
    return this.eventStub(ev).removeBots();
  }

  async alarm() {
    if (this.stopsAt && Date.now() >= this.stopsAt) await this.stop();
  }

  private async halt() {
    this.stopping = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const b of this.bots) {
      b.dead = true;
      for (const t of b.timers) clearTimeout(t);
      try {
        b.ws?.close(1000, 'bot-stop');
      } catch {
        /* 무시 */
      }
    }
    this.bots = [];
    this.startedAt = this.stopsAt = null;
    await this.ctx.storage.deleteAlarm();
  }

  private eventStub(ev: string) {
    return this.env.EVENTS.get(this.env.EVENTS.idFromName('ev:' + ev)) as DurableObjectStub<EventDO>;
  }

  private err(msg: string) {
    this.stats.errors++;
    this.stats.lastError = msg;
  }

  // ───── 진짜 참가자와 같은 요청 ─────
  private req(path: string, init: { method?: string; body?: unknown; cookie?: string; ws?: boolean }) {
    const headers = new Headers({ origin: this.origin });
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set('x-quiz', '1');
    }
    if (init.ws) headers.set('upgrade', 'websocket');
    return this.env.SELF.fetch(
      new Request(this.origin + path, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      }),
    );
  }

  private async join(b: Bot) {
    if (b.dead) return;
    try {
      const r = await this.req('/api/join', { body: { event: this.ev, code: b.code } });
      if (r.status !== 200) {
        this.err(`입장 실패 ${r.status}`);
        return;
      }
      const m = (r.headers.get('set-cookie') ?? '').match(/qz_p=([^;]+)/);
      if (!m) return this.err('입장 쿠키 없음');
      b.cookie = 'qz_p=' + m[1];
      this.openSocket(b);
    } catch (e) {
      this.err('입장 오류 ' + String((e as Error).message ?? e));
    }
  }

  private async openSocket(b: Bot) {
    if (b.dead) return;
    try {
      const r = await this.req('/ws?role=p', { cookie: b.cookie, ws: true });
      const ws = r.webSocket;
      if (!ws) {
        this.err('WebSocket 연결 실패 ' + r.status);
        return this.reconnectLater(b);
      }
      ws.accept();
      b.ws = ws;
      b.retry = 0;
      ws.addEventListener('message', (e) => this.onMessage(b, e.data));
      ws.addEventListener('close', (e) => {
        if (b.ws !== ws) return;
        b.ws = null;
        if (b.dead || this.stopping) return;
        if (e.code === 4001 || e.code === 4401 || e.code === 4404) {
          b.dead = true; // 다른 기기 입장·초기화·행사 없음 → 진짜 화면처럼 멈춘다
          return;
        }
        this.reconnectLater(b);
      });
    } catch (e) {
      this.err('WebSocket 오류 ' + String((e as Error).message ?? e));
      this.reconnectLater(b);
    }
  }

  /** 진짜 화면과 같은 재접속: 지수 백오프 + 무작위 지연 */
  private reconnectLater(b: Bot) {
    if (b.dead || this.stopping) return;
    const cap = Math.min(15_000, 500 * 2 ** b.retry);
    b.retry = Math.min(b.retry + 1, 10);
    b.timers.push(setTimeout(() => this.openSocket(b), 250 + Math.random() * cap));
  }

  private onMessage(b: Bot, data: unknown) {
    if (typeof data !== 'string' || data === 'pong') return;
    let m: { t?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === 'kicked') {
      b.dead = true;
      return;
    }
    if (m.t !== 'state') return;
    const v = m as PlayerView;
    const prevRun = b.run;
    b.view = v;
    if (v.run !== prevRun) {
      // 새 문제: 이전 문제에 보내려던 답은 버린다(진짜 화면과 같음)
      for (const t of b.timers) clearTimeout(t);
      b.timers = [];
      b.run = v.run;
      b.seq = 0;
      if (v.phase === 'open') this.plan(b, v);
    } else if (v.phase !== 'open') {
      // 마감 소식을 받으면 진짜 화면은 입력·제출이 막힌다 → 예약한 제출 취소
      for (const t of b.timers) clearTimeout(t);
      b.timers = [];
    }
  }

  /** 문제가 열렸을 때 이 사람이 언제 무엇을 낼지 정한다 */
  private plan(b: Bot, v: PlayerView) {
    const q = v.qid ? QUESTION_BY_ID.get(v.qid) : undefined;
    if (!q || !v.endsAt || b.persona.silent) return;
    const now = Date.now();
    const offset = v.now - now; // 서버 시각 보정
    const left = v.endsAt - (now + offset);
    const right = () => pick(q.accepted);
    const wrong = () => pick(q.decoys?.length ? q.decoys : ['모르겠어요']);
    const firstRight = Math.random() < b.persona.accuracy;
    const first = firstRight ? right() : wrong();
    let at = rnd(b.persona.paceMin, b.persona.paceMax);
    if (b.persona.late) at = left + rnd(-800, 600); // 마감 직전·직후
    at = Math.min(at, left + 600);
    b.timers.push(setTimeout(() => this.submit(b, first, v.run), Math.max(300, at)));
    if (b.persona.revise && !b.persona.late) {
      // 고치는 사람은 대개 정답 쪽으로 고친다(틀렸다가 정답 70%, 맞았다가 다른 표기·오답)
      const second = !firstRight ? (Math.random() < 0.7 ? right() : wrong()) : Math.random() < 0.7 ? right() : wrong();
      const at2 = at + rnd(2000, 5000);
      if (at2 < left - 300) b.timers.push(setTimeout(() => this.submit(b, second, v.run), at2));
    }
  }

  private async submit(b: Bot, text: string, run: number) {
    if (b.dead || !b.view || b.view.run !== run) return;
    b.seq += 1;
    const body = { qid: b.view.qid, run, seq: b.seq, reqId: crypto.randomUUID().replace(/-/g, ''), text };
    for (let tries = 0; tries < 5; tries++) {
      // 첫 전송은 마감 직후라도 보낸다(늦게 누른 사람 — 서버가 'closed' 로 거부). 재시도는 열려 있을 때만.
      if (b.dead || b.view?.run !== run || (tries > 0 && b.view.phase !== 'open')) return;
      try {
        const r = await this.req('/api/answer', { body, cookie: b.cookie });
        if (r.status === 401) {
          b.dead = true;
          return;
        }
        if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
        const res = (await r.json()) as SubmitResult;
        if (res.status === 'accepted' || res.status === 'duplicate') this.stats.submitted++;
        else this.stats.rejected[res.status] = (this.stats.rejected[res.status] ?? 0) + 1;
        return;
      } catch (e) {
        if (tries === 4) this.err('제출 실패 ' + String((e as Error).message ?? e));
        await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** (tries + 1)) * (0.5 + Math.random())));
      }
    }
  }
}

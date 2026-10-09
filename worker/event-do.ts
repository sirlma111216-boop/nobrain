// 행사 하나 = Durable Object 하나.
// 상태·참가자·답안·결과는 모두 이 Object 의 SQLite 에 영구 저장한다. 메모리는 캐시일 뿐이며
// 재시작·퇴거·Hibernation 후에는 constructor 에서 SQLite 를 읽어 복구한다.
//
// 동시성 원칙: 답안 접수·마감·채점은 모두 await 없는 동기 코드로 처리한다.
// Durable Object 는 한 번에 하나의 이벤트만 실행하고, 동기 구간 사이에는 다른 요청이 끼어들 수 없다.
// 따라서 "마감 확인 → 기존 답안 비교 → 저장" 이 하나의 원자적 단계가 되고,
// 마감 처리(트랜잭션)와 답안 저장은 반드시 어느 한쪽이 먼저 완전히 끝난다.
// 저장 후의 응답은 Durable Object 의 output gate 가 디스크 기록 확정 때까지 붙잡아 두므로
// "접수 완료" 응답은 영구 저장 이후에만 클라이언트에 도착한다.

import { DurableObject } from 'cloudflare:workers';
import { QUESTION_BY_ID, type Question } from './quiz/bank';
import { acceptedKeys, cleanAnswer, normKey } from './quiz/grading';
import {
  LIMITS,
  type BoardView,
  type HostView,
  type MyAnswer,
  type Phase,
  type PlayerView,
  type RunSummary,
  type Stage,
  type SubmitResult,
  type TopAnswer,
} from '../shared/protocol';

// ───────────────────────── 스키마 마이그레이션 ─────────────────────────
// 순서대로 한 번씩만 적용된다. 이미 배포한 항목은 고치지 말고 뒤에 추가한다.
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    `CREATE TABLE participants (
      pid INTEGER PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      code_enc TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      session_gen INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE rounds (
      run INTEGER PRIMARY KEY,
      qid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','closed')),
      started_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      closed_at INTEGER,
      extra_json TEXT NOT NULL DEFAULT '[]',
      featured_json TEXT NOT NULL DEFAULT '[]',
      voided INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      graded_at INTEGER
    )`,
    // 참가자·진행버전(run)별 유효 답안은 하나: PRIMARY KEY(run, pid)
    `CREATE TABLE answers (
      run INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      qid TEXT NOT NULL,
      text TEXT NOT NULL,
      norm TEXT NOT NULL,
      seq INTEGER NOT NULL,
      req_id TEXT NOT NULL,
      versions INTEGER NOT NULL DEFAULT 1,
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (run, pid)
    ) WITHOUT ROWID`,
    `CREATE INDEX answers_run_norm ON answers(run, norm)`,
    `CREATE TABLE results (
      run INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      correct INTEGER NOT NULL,
      PRIMARY KEY (run, pid)
    ) WITHOUT ROWID`,
    `CREATE INDEX results_run_correct ON results(run, correct)`,
    `CREATE TABLE cmd_log (cmd_id TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT NOT NULL)`,
    `CREATE INDEX cmd_log_at ON cmd_log(at)`,
    `CREATE TABLE login_fail (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
    `CREATE INDEX login_fail_ip_at ON login_fail(ip, at)`,
  ],
];

// ───────────────────────── 타입 ─────────────────────────
interface EvState {
  code: string;
  title: string;
  qids: string[];
  idx: number; // -1 = 대기실, qids.length = 종료
  run: number; // 현재 진행 버전. 0 = 없음
  phase: Phase;
  stage: Stage | 0;
  page: number;
  sv: number; // 상태 버전
  runSeq: number; // 지금까지 발급한 마지막 run (초기화해도 줄지 않는다)
  boardKeyVer: number;
  boardKeyHash: string | null;
  createdAt: number;
}

type RoundRow = {
  run: number;
  qid: string;
  idx: number;
  status: 'open' | 'closed';
  started_at: number;
  ends_at: number;
  closed_at: number | null;
  extra_json: string;
  featured_json: string;
  voided: number;
  total: number;
  correct: number;
};

type AnswerRow = { text: string; seq: number; req_id: string; accepted_at: number };

interface Att {
  role: 'p' | 'h' | 'b';
  pid?: number;
  gen?: number;
  k?: number;
}

export interface SubmitBody {
  qid: unknown;
  run: unknown;
  seq: unknown;
  reqId: unknown;
  text: unknown;
}

export type JoinResult =
  | { ok: true; pid: number; name: string; gen: number; title: string }
  | { ok: false; error: 'NO_EVENT' | 'BAD_CODE' | 'RATE' };

export interface CmdResult {
  ok: boolean;
  error?: string;
  message?: string;
  replay?: boolean;
  view?: HostView;
}

const KIND_PREFIX: Record<string, string> = { student: '학생', teacher: '교사', load: '부하', bot: '봇' };
// 연습용 봇 이름(진짜 학생 이름과 겹치지 않게 '(봇)' 을 붙인다)
const BOT_NICKS = ['가람', '나래', '다올', '라온', '마루', '바다', '보람', '빛나', '새롬', '솔빛', '아라', '여름', '온새', '우람', '윤슬', '이슬', '자람', '초롱', '타리', '파랑', '푸름', '하늘', '한별', '해든', '햇살', '호수', '가온', '누리', '다솜', '도담', '미르', '별하', '봄이', '샛별', '소담', '시내', '은솔', '지음', '찬솔', '하람'];
const MAX_PARTICIPANTS = 3000;
const HOST_FLUSH_MS = 500; // 진행자 화면 집계 갱신 묶음 간격
const JOIN_FAIL_WINDOW_MS = 5 * 60_000;
const JOIN_FAIL_LIMIT = 200; // IP 하나당 5분간 실패 허용 횟수(통신사 공유 IP 고려해 넉넉히)

export class EventDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private st: EvState | null = null;
  private round: RoundRow | null = null;
  private submitted = 0;
  private registered = 0;
  private top: { run: number; list: TopAnswer[] } | null = null;
  private readonly boot = crypto.randomUUID().slice(0, 8);
  private genCache = new Map<number, number>();
  private buckets = new Map<number, { tokens: number; at: number }>();
  private joinFails = new Map<string, number[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.load();
    });
    // 앱 수준 ping 은 Object 를 깨우지 않고 런타임이 바로 응답한다 (Hibernation 유지)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ───────────── 저장/복구 ─────────────
  private migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _schema (v INTEGER NOT NULL)`);
    const cur = this.sql.exec<{ v: number }>(`SELECT v FROM _schema`).toArray()[0]?.v ?? 0;
    if (cur >= MIGRATIONS.length) return;
    this.ctx.storage.transactionSync(() => {
      for (let i = cur; i < MIGRATIONS.length; i++) for (const s of MIGRATIONS[i]) this.sql.exec(s);
      this.sql.exec(`DELETE FROM _schema`);
      this.sql.exec(`INSERT INTO _schema (v) VALUES (?)`, MIGRATIONS.length);
    });
  }

  private load() {
    const raw = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k='state'`).toArray()[0]?.v;
    this.st = raw ? (JSON.parse(raw) as EvState) : null;
    this.registered = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM participants`).one().c;
    this.round = this.st && this.st.run ? this.loadRound(this.st.run) : null;
    this.submitted = this.round
      ? this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM answers WHERE run=?`, this.round.run).one().c
      : 0;
  }

  private loadRound(run: number): RoundRow | null {
    return this.sql.exec<RoundRow>(`SELECT * FROM rounds WHERE run=?`, run).toArray()[0] ?? null;
  }

  private saveState() {
    this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('state', ?)`, JSON.stringify(this.st));
  }

  private q(): Question | null {
    const st = this.st;
    if (!st || st.idx < 0 || st.idx >= st.qids.length) return null;
    return QUESTION_BY_ID.get(st.qids[st.idx]) ?? null;
  }

  private qNo(): number {
    const st = this.st!;
    if (st.phase === 'lobby') return 0;
    if (st.phase === 'ended') return st.qids.length;
    return st.idx + 1;
  }

  /** 종료 시각이 지났는데 아직 열려 있으면 지금 마감한다. Alarm 이 늦어도 모든 진입점에서 호출된다. */
  private tick() {
    if (this.round && this.round.status === 'open' && Date.now() >= this.round.ends_at) this.closeRound();
  }

  // ───────────── 행사 생성 ─────────────
  init(code: string, title: string, qids: string[]): { ok: boolean; error?: string } {
    if (this.st) return { ok: false, error: 'EXISTS' };
    for (const id of qids) if (!QUESTION_BY_ID.has(id)) return { ok: false, error: 'BAD_QID' };
    this.st = {
      code,
      title,
      qids,
      idx: -1,
      run: 0,
      phase: 'lobby',
      stage: 0,
      page: 0,
      sv: 1,
      runSeq: 0,
      boardKeyVer: 0,
      boardKeyHash: null,
      createdAt: Date.now(),
    };
    this.saveState();
    return { ok: true };
  }

  exists(): { exists: boolean; title?: string } {
    return this.st ? { exists: true, title: this.st.title } : { exists: false };
  }

  // ───────────── 참가자 ─────────────
  addParticipants(items: { hash: string; enc: string; kind: string }[]): { inserted: number; failed: number[]; names: (string | null)[] } {
    if (!this.st) return { inserted: 0, failed: items.map((_, i) => i), names: items.map(() => null) };
    const failed: number[] = [];
    const names: (string | null)[] = items.map(() => null);
    let inserted = 0;
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const prefix = KIND_PREFIX[it.kind];
        if (!prefix || this.registered + inserted >= MAX_PARTICIPANTS) {
          failed.push(i);
          continue;
        }
        const dup = this.sql.exec(`SELECT 1 FROM participants WHERE code_hash=?`, it.hash).toArray().length;
        if (dup) {
          failed.push(i);
          continue;
        }
        const n = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM participants WHERE kind=?`, it.kind).one().c + 1;
        const width = it.kind === 'load' ? 4 : 3;
        const name =
          it.kind === 'bot'
            ? BOT_NICKS[(n - 1) % BOT_NICKS.length] + (n > BOT_NICKS.length ? String(Math.ceil(n / BOT_NICKS.length)) : '') + '(봇)'
            : prefix + String(n).padStart(width, '0');
        this.sql.exec(
          `INSERT INTO participants (code_hash, code_enc, name, kind, created_at) VALUES (?,?,?,?,?)`,
          it.hash,
          it.enc,
          name,
          it.kind,
          Date.now(),
        );
        names[i] = name;
        inserted++;
      }
    });
    this.registered += inserted;
    this.scheduleHostFlush();
    return { inserted, failed, names };
  }

  /** 연습용 봇의 참가자·답안·결과를 지우고, 마감된 문제는 다시 채점한다(멱등) */
  removeBots(): { removed: number } {
    if (!this.st) return { removed: 0 };
    const pids = this.sql.exec<{ pid: number }>(`SELECT pid FROM participants WHERE kind='bot'`).toArray().map((x) => x.pid);
    if (!pids.length) return { removed: 0 };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM answers WHERE pid IN (SELECT pid FROM participants WHERE kind='bot')`);
      this.sql.exec(`DELETE FROM results WHERE pid IN (SELECT pid FROM participants WHERE kind='bot')`);
      this.sql.exec(`DELETE FROM participants WHERE kind='bot'`);
      for (const r of this.sql.exec<{ run: number }>(`SELECT run FROM rounds WHERE status='closed'`).toArray()) this.gradeRun(r.run);
      this.st!.sv++;
      this.saveState();
    });
    for (const pid of pids) {
      this.genCache.delete(pid);
      this.buckets.delete(pid);
      for (const ws of this.ctx.getWebSockets('p:' + pid)) {
        try {
          ws.close(4401, 'bot-removed');
        } catch {
          /* 무시 */
        }
      }
    }
    this.load(); // 등록 인원·현재 문제·제출 인원을 SQLite 기준으로 다시 계산
    this.top = null;
    this.broadcastBoards();
    this.flushHosts();
    return { removed: pids.length };
  }

  exportCodes(): { name: string; kind: string; enc: string }[] {
    return this.sql
      .exec<{ name: string; kind: string; enc: string }>(`SELECT name, kind, code_enc AS enc FROM participants ORDER BY pid`)
      .toArray();
  }

  private joinBlocked(ip: string): boolean {
    const now = Date.now();
    const arr = (this.joinFails.get(ip) ?? []).filter((t) => now - t < JOIN_FAIL_WINDOW_MS);
    if (arr.length) this.joinFails.set(ip, arr);
    else this.joinFails.delete(ip);
    return arr.length >= JOIN_FAIL_LIMIT;
  }

  join(codeHash: string, ip: string): JoinResult {
    this.tick();
    if (!this.st) return { ok: false, error: 'NO_EVENT' };
    if (this.joinBlocked(ip)) return { ok: false, error: 'RATE' };
    const row = this.sql
      .exec<{ pid: number; name: string; session_gen: number }>(
        `SELECT pid, name, session_gen FROM participants WHERE code_hash=?`,
        codeHash,
      )
      .toArray()[0];
    if (!row) {
      const arr = this.joinFails.get(ip) ?? [];
      arr.push(Date.now());
      this.joinFails.set(ip, arr);
      if (this.joinFails.size > 5000) this.joinFails.clear(); // 메모리 보호
      return { ok: false, error: 'BAD_CODE' };
    }
    // 정책: 같은 코드로 새 기기에서 입장하면 이전 기기의 세션은 무효(마지막 입장 우선)
    const gen = row.session_gen + 1;
    this.sql.exec(`UPDATE participants SET session_gen=?, joined_at=? WHERE pid=?`, gen, Date.now(), row.pid);
    this.genCache.set(row.pid, gen);
    for (const ws of this.ctx.getWebSockets('p:' + row.pid)) {
      try {
        ws.send(JSON.stringify({ t: 'kicked' }));
        ws.close(4001, 'kicked');
      } catch {
        /* 이미 닫힘 */
      }
    }
    this.scheduleHostFlush();
    return { ok: true, pid: row.pid, name: row.name, gen, title: this.st.title };
  }

  private genOf(pid: number): number | null {
    const c = this.genCache.get(pid);
    if (c !== undefined) return c;
    const r = this.sql.exec<{ g: number }>(`SELECT session_gen AS g FROM participants WHERE pid=?`, pid).toArray()[0];
    if (!r) return null;
    this.genCache.set(pid, r.g);
    return r.g;
  }

  hello(pid: number, gen: number): { ok: true; name: string; title: string; ev: string } | { ok: false; error: string } {
    if (!this.st) return { ok: false, error: 'NO_EVENT' };
    const g = this.genOf(pid);
    if (g === null) return { ok: false, error: 'GONE' };
    if (g !== gen) return { ok: false, error: 'KICKED' };
    const name = this.sql.exec<{ name: string }>(`SELECT name FROM participants WHERE pid=?`, pid).one().name;
    return { ok: true, name, title: this.st.title, ev: this.st.code };
  }

  /** 참가자별 빈도 제한: 순간 8회, 초당 4회 회복 */
  private rateOk(pid: number): boolean {
    const now = Date.now();
    const b = this.buckets.get(pid) ?? { tokens: 8, at: now };
    b.tokens = Math.min(8, b.tokens + ((now - b.at) / 1000) * 4);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(pid, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(pid, b);
    return true;
  }

  private myAnswer(pid: number, run: number): MyAnswer | null {
    if (!run) return null;
    const r = this.sql
      .exec<{ qid: string; text: string; seq: number; accepted_at: number }>(
        `SELECT qid, text, seq, accepted_at FROM answers WHERE run=? AND pid=?`,
        run,
        pid,
      )
      .toArray()[0];
    return r ? { qid: r.qid, run, text: r.text, seq: r.seq, at: r.accepted_at } : null;
  }

  // ───────────── 답안 접수 (핫 패스) ─────────────
  // 이 메서드에는 await 가 없다. 읽기 1회(PK) + 쓰기 1회(PK)만 한다.
  submit(pid: number, gen: number, b: SubmitBody): SubmitResult {
    this.tick();
    const st = this.st;
    if (!st) return { status: 'not_open' };
    const g = this.genOf(pid);
    if (g === null || g !== gen) return { status: 'kicked' };
    if (!this.rateOk(pid)) return { status: 'rate_limited', message: '너무 자주 보내고 있어요. 잠시 후 다시 시도하세요.' };

    const run = b.run;
    const seq = b.seq;
    const reqId = b.reqId;
    if (
      typeof b.qid !== 'string' ||
      typeof run !== 'number' ||
      !Number.isSafeInteger(run) ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq > 1e9 ||
      typeof reqId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(reqId) ||
      typeof b.text !== 'string'
    ) {
      return { status: 'invalid', message: '요청 형식이 올바르지 않습니다.' };
    }

    const r = this.round;
    if (!r) return { status: 'not_open' };
    // 문제별 고유 ID + 진행 버전으로 이전 문제·이전 진행의 지연 요청 차단
    if (run !== r.run || b.qid !== r.qid) return { status: 'stale', message: '지난 문제의 답안이라 접수하지 않았습니다.' };
    // 접수 기준: 이 요청을 Object 가 처리하는 순간의 서버 시각 < 종료 시각, 그리고 상태가 open
    if (r.status !== 'open' || Date.now() >= r.ends_at) return { status: 'closed', latest: this.myAnswer(pid, run) };

    if (b.text.length > LIMITS.answerMaxRawChars) return { status: 'invalid', message: '답이 너무 깁니다.' };
    const text = cleanAnswer(b.text);
    if (!text) return { status: 'invalid', message: '답을 입력하세요.' };
    if ([...text].length > LIMITS.answerMaxChars) return { status: 'invalid', message: `답은 ${LIMITS.answerMaxChars}자 이내로 입력하세요.` };

    const q = QUESTION_BY_ID.get(r.qid)!;
    const norm = normKey(text, q.rules);
    const now = Date.now();
    const ex = this.sql
      .exec<AnswerRow>(`SELECT text, seq, req_id, accepted_at FROM answers WHERE run=? AND pid=?`, run, pid)
      .toArray()[0];

    if (ex) {
      const latest: MyAnswer = { qid: r.qid, run, text: ex.text, seq: ex.seq, at: ex.accepted_at };
      if (ex.req_id === reqId) return { status: 'duplicate', latest };
      // 과거 요청(낮거나 같은 버전)은 최신 답안을 덮어쓰지 못한다
      if (seq <= ex.seq) return { status: 'superseded', latest };
      this.sql.exec(
        `UPDATE answers SET text=?, norm=?, seq=?, req_id=?, versions=versions+1, accepted_at=? WHERE run=? AND pid=?`,
        text,
        norm,
        seq,
        reqId,
        now,
        run,
        pid,
      );
    } else {
      this.sql.exec(
        `INSERT INTO answers (run, pid, qid, text, norm, seq, req_id, accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
        run,
        pid,
        r.qid,
        text,
        norm,
        seq,
        reqId,
        now,
      );
      this.submitted++;
      this.scheduleHostFlush();
    }
    return { status: 'accepted', latest: { qid: r.qid, run, text, seq, at: now } };
  }

  // ───────────── 마감·채점 ─────────────
  private closeRound() {
    const r = this.round;
    const st = this.st;
    if (!r || !st || r.status !== 'open') return;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE rounds SET status='closed', closed_at=?, ends_at=MIN(ends_at, ?) WHERE run=? AND status='open'`,
        now,
        now,
        r.run,
      );
      this.gradeRun(r.run);
      st.phase = 'closed';
      st.stage = 2;
      st.page = 0;
      st.sv++;
      this.saveState();
    });
    this.round = this.loadRound(r.run);
    this.top = null;
    this.ctx.storage.deleteAlarm().catch(() => {});
    this.broadcastAll();
  }

  /** 결과를 지우고 다시 계산한다. 몇 번을 실행해도 결과는 같다(멱등). 트랜잭션 안에서 호출. */
  private gradeRun(run: number) {
    const r = this.loadRound(run);
    if (!r) return;
    const q = QUESTION_BY_ID.get(r.qid)!;
    const extra = JSON.parse(r.extra_json) as string[];
    const keys = acceptedKeys([...q.accepted, ...extra], q.rules);
    this.sql.exec(`DELETE FROM results WHERE run=?`, run);
    this.sql.exec(
      `INSERT INTO results (run, pid, correct)
       SELECT run, pid, CASE WHEN norm IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END FROM answers WHERE run=?`,
      JSON.stringify(keys),
      run,
    );
    this.sql.exec(
      `UPDATE rounds SET
         total=(SELECT COUNT(*) FROM results WHERE run=?1),
         correct=(SELECT COUNT(*) FROM results WHERE run=?1 AND correct=1),
         graded_at=?2
       WHERE run=?1`,
      run,
      Date.now(),
    );
  }

  private topAnswers(run: number): TopAnswer[] {
    if (this.top && this.top.run === run) return this.top.list;
    const r = this.loadRound(run);
    if (!r) return [];
    const q = QUESTION_BY_ID.get(r.qid)!;
    const keys = new Set(acceptedKeys([...q.accepted, ...(JSON.parse(r.extra_json) as string[])], q.rules));
    const list = this.sql
      .exec<{ norm: string; c: number }>(
        `SELECT norm, COUNT(*) AS c FROM answers WHERE run=? GROUP BY norm ORDER BY c DESC, norm LIMIT 30`,
        run,
      )
      .toArray()
      .map((x) => ({ norm: x.norm, count: x.c, correct: keys.has(x.norm) }));
    this.top = { run, list };
    return list;
  }

  async alarm() {
    this.tick();
    if (this.round && this.round.status === 'open') await this.ctx.storage.setAlarm(this.round.ends_at);
  }

  // ───────────── 진행자 명령 ─────────────
  hostCmd(cmd: string, args: Record<string, unknown>, cmdId: string, sv: number): CmdResult {
    this.tick();
    const st = this.st;
    if (!st) return { ok: false, error: 'NO_EVENT', message: '행사가 없습니다.' };
    if (cmdId) {
      const prev = this.sql.exec<{ result: string }>(`SELECT result FROM cmd_log WHERE cmd_id=?`, cmdId).toArray()[0];
      if (prev) return { ...(JSON.parse(prev.result) as CmdResult), replay: true, view: this.hostView() };
    }
    const needSv = ['start', 'extend', 'close', 'stage', 'next', 'reset'];
    if (needSv.includes(cmd) && sv !== st.sv) {
      return { ok: false, error: 'STALE', message: '화면이 최신 상태가 아니어서 실행하지 않았습니다. 최신 상태를 확인한 뒤 다시 누르세요.', view: this.hostView() };
    }
    let res: CmdResult;
    try {
      res = this.runCmd(cmd, args);
    } catch (e) {
      res = { ok: false, error: 'FAILED', message: String((e as Error).message ?? e) };
    }
    if (res.ok && cmdId) {
      const now = Date.now();
      this.sql.exec(`INSERT OR REPLACE INTO cmd_log (cmd_id, at, result) VALUES (?,?,?)`, cmdId, now, JSON.stringify(res));
      this.sql.exec(`DELETE FROM cmd_log WHERE at < ?`, now - 6 * 3600_000);
    }
    return { ...res, view: this.hostView() };
  }

  private runCmd(cmd: string, a: Record<string, unknown>): CmdResult {
    const st = this.st!;
    const fail = (message: string): CmdResult => ({ ok: false, error: 'BAD_STATE', message });
    switch (cmd) {
      case 'start': {
        if (st.phase !== 'ready') return fail('지금은 문제를 시작할 수 없습니다.');
        const q = this.q()!;
        const now = Date.now();
        const run = st.runSeq + 1;
        const ends = now + q.timeLimitSec * 1000;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT INTO rounds (run, qid, idx, status, started_at, ends_at) VALUES (?,?,?,'open',?,?)`,
            run,
            q.id,
            st.idx,
            now,
            ends,
          );
          st.runSeq = run;
          st.run = run;
          st.phase = 'open';
          st.stage = 1;
          st.page = 0;
          st.sv++;
          this.saveState();
        });
        this.round = this.loadRound(run);
        this.submitted = 0;
        this.top = null;
        this.ctx.storage.setAlarm(ends).catch(() => {});
        this.broadcastAll();
        return { ok: true };
      }
      case 'extend': {
        const sec = Number(a.sec);
        if (st.phase !== 'open' || !this.round) return fail('진행 중인 문제가 없습니다.');
        if (!Number.isInteger(sec) || sec < 1 || sec > 120) return fail('연장 시간은 1~120초입니다.');
        const ends = Math.max(this.round.ends_at, Date.now()) + sec * 1000;
        this.sql.exec(`UPDATE rounds SET ends_at=? WHERE run=?`, ends, this.round.run);
        st.sv++;
        this.saveState();
        this.round = this.loadRound(this.round.run);
        this.ctx.storage.setAlarm(ends).catch(() => {});
        this.broadcastAll();
        return { ok: true };
      }
      case 'close': {
        if (st.phase !== 'open') return fail('진행 중인 문제가 없습니다.');
        this.closeRound();
        return { ok: true };
      }
      case 'stage': {
        const to = Number(a.to);
        if (st.phase !== 'closed' || !this.round) return fail('마감된 문제가 없습니다.');
        if (![2, 3, 4, 5].includes(to)) return fail('잘못된 공개 단계입니다.');
        if (to === 3 && (JSON.parse(this.round.featured_json) as string[]).length === 0) return fail('대표 답안을 먼저 선택하세요.');
        st.stage = to as Stage;
        st.page = 0;
        st.sv++;
        this.saveState();
        this.broadcastBoards();
        this.flushHosts();
        return { ok: true };
      }
      case 'page': {
        if (st.phase !== 'closed' || st.stage !== 5 || !this.round) return fail('정답자 명단 단계가 아닙니다.');
        const pages = Math.max(1, Math.ceil(this.round.correct / LIMITS.winnersPageSize));
        const p = Math.min(Math.max(0, Math.floor(Number(a.page) || 0)), pages - 1);
        if (p !== st.page) {
          st.page = p;
          st.sv++;
          this.saveState();
          this.broadcastBoards();
        }
        return { ok: true };
      }
      case 'feature': {
        if (st.phase !== 'closed' || !this.round) return fail('마감된 문제가 없습니다.');
        const list = Array.isArray(a.norms) ? a.norms.filter((x): x is string => typeof x === 'string') : [];
        const known = new Set(this.topAnswers(this.round.run).map((t) => t.norm));
        const picked = [...new Set(list)].filter((n) => known.has(n)).slice(0, 8);
        this.sql.exec(`UPDATE rounds SET featured_json=? WHERE run=?`, JSON.stringify(picked), this.round.run);
        this.round = this.loadRound(this.round.run);
        st.sv++;
        this.saveState();
        if (st.stage === 3) this.broadcastBoards();
        return { ok: true };
      }
      case 'next': {
        if (st.phase === 'open') return fail('진행 중인 문제를 먼저 마감하세요.');
        if (st.phase === 'ended') return fail('이미 마지막 문제까지 끝났습니다.');
        st.idx += 1;
        st.run = 0;
        st.stage = 0;
        st.page = 0;
        st.phase = st.idx >= st.qids.length ? 'ended' : 'ready';
        st.sv++;
        this.saveState();
        this.round = null;
        this.submitted = 0;
        this.top = null;
        this.broadcastAll();
        return { ok: true };
      }
      case 'accept':
      case 'unaccept': {
        const run = Number(a.run) || this.round?.run || 0;
        const r = this.loadRound(run);
        if (!r) return fail('해당 문제 진행 기록이 없습니다.');
        const q = QUESTION_BY_ID.get(r.qid)!;
        const text = typeof a.text === 'string' ? cleanAnswer(a.text) : '';
        if (!text || [...text].length > LIMITS.answerMaxChars) return fail('인정할 답을 입력하세요.');
        const key = normKey(text, q.rules);
        let extra = JSON.parse(r.extra_json) as string[];
        if (cmd === 'accept') {
          if (!extra.some((e) => normKey(e, q.rules) === key) && !acceptedKeys(q.accepted, q.rules).includes(key)) extra.push(text);
        } else {
          extra = extra.filter((e) => normKey(e, q.rules) !== key);
        }
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE rounds SET extra_json=? WHERE run=?`, JSON.stringify(extra), run);
          if (r.status === 'closed') this.gradeRun(run); // 재채점: 결과를 지우고 다시 계산(중복 반영 없음)
          st.sv++;
          this.saveState();
        });
        if (this.round?.run === run) this.round = this.loadRound(run);
        this.top = null;
        if (st.run === run && st.stage >= 4) this.broadcastBoards();
        return { ok: true };
      }
      case 'void': {
        const run = Number(a.run) || this.round?.run || 0;
        if (!this.loadRound(run)) return fail('해당 문제 진행 기록이 없습니다.');
        this.sql.exec(`UPDATE rounds SET voided=? WHERE run=?`, a.voided === false ? 0 : 1, run);
        if (this.round?.run === run) this.round = this.loadRound(run);
        st.sv++;
        this.saveState();
        if (st.run === run) this.broadcastBoards();
        return { ok: true };
      }
      case 'reset': {
        if (a.confirm !== st.code) return fail('확인용 행사 코드가 일치하지 않습니다.');
        const wipeParticipants = a.participants === true;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`DELETE FROM answers`);
          this.sql.exec(`DELETE FROM results`);
          this.sql.exec(`DELETE FROM rounds`);
          if (wipeParticipants) this.sql.exec(`DELETE FROM participants`);
          st.idx = -1;
          st.run = 0; // runSeq 는 그대로 두어 초기화 전 요청이 새 진행에 섞이지 않게 한다
          st.phase = 'lobby';
          st.stage = 0;
          st.page = 0;
          st.sv++;
          this.saveState();
        });
        this.round = null;
        this.submitted = 0;
        this.top = null;
        this.ctx.storage.deleteAlarm().catch(() => {});
        if (wipeParticipants) {
          this.registered = 0;
          this.genCache.clear();
          for (const ws of this.ctx.getWebSockets('p')) {
            try {
              ws.close(4401, 'reset');
            } catch {
              /* 무시 */
            }
          }
        }
        this.broadcastAll();
        return { ok: true };
      }
      case 'boardKey': {
        const hash = typeof a.hash === 'string' ? a.hash : '';
        if (hash.length < 20) return fail('잘못된 요청입니다.');
        st.boardKeyVer += 1;
        st.boardKeyHash = hash;
        this.saveState();
        // 이전 전광판 연결은 끊는다(키 교체)
        for (const ws of this.ctx.getWebSockets('b')) {
          try {
            ws.close(4401, 'rotated');
          } catch {
            /* 무시 */
          }
        }
        return { ok: true };
      }
      case 'restart': {
        // 로컬 검증 전용(Worker 에서 DEV_MODE + APP_ENV=local 일 때만 전달). 메모리를 버리고 Object 를 재시작한다.
        setTimeout(() => this.ctx.abort('개발용 재시작'), 20);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'UNKNOWN', message: '알 수 없는 명령입니다.' };
    }
  }

  boardLogin(hash: string): { ok: true; k: number } | { ok: false } {
    if (!this.st || !this.st.boardKeyHash || this.st.boardKeyHash !== hash) return { ok: false };
    return { ok: true, k: this.st.boardKeyVer };
  }

  // 진행자 로그인 실패 기록(행사와 무관한 시스템 Object '__sys__' 에서만 사용)
  hostLoginAllowed(ip: string): boolean {
    const since = Date.now() - 10 * 60_000;
    this.sql.exec(`DELETE FROM login_fail WHERE at < ?`, since);
    return this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM login_fail WHERE ip=?`, ip).one().c < 10;
  }
  hostLoginFailed(ip: string) {
    this.sql.exec(`INSERT INTO login_fail (ip, at) VALUES (?,?)`, ip, Date.now());
  }

  // ───────────── 결과 내보내기 ─────────────
  exportResults() {
    const st = this.st;
    if (!st) return null;
    const rounds = this.sql.exec<RoundRow>(`SELECT * FROM rounds ORDER BY run`).toArray();
    const people = this.sql.exec<{ pid: number; name: string; kind: string }>(`SELECT pid, name, kind FROM participants ORDER BY pid`).toArray();
    const ans = this.sql
      .exec<{ run: number; pid: number; text: string; seq: number; versions: number; accepted_at: number; correct: number | null }>(
        `SELECT a.run, a.pid, a.text, a.seq, a.versions, a.accepted_at, r.correct
         FROM answers a LEFT JOIN results r ON r.run=a.run AND r.pid=a.pid`,
      )
      .toArray();
    const byKey = new Map(ans.map((x) => [x.run + ':' + x.pid, x]));
    return {
      event: st.code,
      title: st.title,
      exportedAt: Date.now(),
      runs: rounds.map((r) => ({
        run: r.run,
        qNo: r.idx + 1,
        qid: r.qid,
        status: r.status,
        voided: !!r.voided,
        endsAt: r.ends_at,
        closedAt: r.closed_at,
        total: r.total,
        correct: r.correct,
        answerDisplay: QUESTION_BY_ID.get(r.qid)?.answerDisplay ?? '',
        extra: JSON.parse(r.extra_json) as string[],
      })),
      rows: people.map((p) => {
        let score = 0;
        const cells = rounds.map((r) => {
          const a = byKey.get(r.run + ':' + p.pid);
          const correct = a ? a.correct === 1 : false;
          if (correct && !r.voided && r.status === 'closed') score++;
          return a ? { text: a.text, seq: a.seq, versions: a.versions, at: a.accepted_at, correct: a.correct === null ? null : correct } : null;
        });
        return { pid: p.pid, name: p.name, kind: p.kind, cells, score };
      }),
    };
  }

  // ───────────── 화면별 상태 ─────────────
  private playerView(): PlayerView {
    const st = this.st!;
    const r = this.round;
    return {
      t: 'state',
      ev: st.code,
      title: st.title,
      phase: st.phase,
      qNo: this.qNo(),
      qTotal: st.qids.length,
      qid: r ? r.qid : null,
      run: r ? r.run : 0,
      endsAt: r ? r.ends_at : null,
      now: Date.now(),
    };
  }

  private boardView(): BoardView {
    const st = this.st!;
    const r = this.round;
    const v: BoardView = {
      t: 'board',
      ev: st.code,
      title: st.title,
      phase: st.phase,
      stage: st.stage,
      qNo: this.qNo(),
      qTotal: st.qids.length,
      run: r ? r.run : 0,
      endsAt: r ? r.ends_at : null,
      now: Date.now(),
    };
    // 공개 단계에 해당하는 정보만 담는다. 정답·집계는 해당 단계 전에는 전광판에도 보내지 않는다.
    if (r && (st.phase === 'open' || st.phase === 'closed')) {
      const q = QUESTION_BY_ID.get(r.qid)!;
      v.question = { prompt: q.prompt, image: q.image, imageAlt: q.imageAlt };
      if (st.phase === 'closed') {
        if (st.stage === 3) {
          const counts = new Map(this.topAnswers(r.run).map((t) => [t.norm, t.count]));
          v.featured = (JSON.parse(r.featured_json) as string[]).map((n) => ({ text: n, count: counts.get(n) ?? 0 }));
        }
        if (st.stage >= 4) {
          v.answer = { display: q.answerDisplay, explanation: q.explanation };
          v.voided = !!r.voided;
        }
        if (st.stage === 5 && !r.voided) {
          const size = LIMITS.winnersPageSize;
          const pages = Math.max(1, Math.ceil(r.correct / size));
          const page = Math.min(st.page, pages - 1);
          const names = this.sql
            .exec<{ name: string }>(
              `SELECT p.name FROM results x JOIN participants p ON p.pid=x.pid
               WHERE x.run=? AND x.correct=1 ORDER BY p.name LIMIT ? OFFSET ?`,
              r.run,
              size,
              page * size,
            )
            .toArray()
            .map((x) => x.name);
          v.winners = { count: r.correct, names, page, pages };
        }
      }
    }
    return v;
  }

  hostView(): HostView {
    this.tick();
    const st = this.st!;
    const r = this.round;
    const q = this.q();
    const pids = new Set<number>();
    for (const ws of this.ctx.getWebSockets('p')) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a?.pid !== undefined && ws.readyState === WebSocket.OPEN) pids.add(a.pid);
    }
    const runs: RunSummary[] = this.sql
      .exec<{ run: number; qid: string; idx: number; status: 'open' | 'closed'; total: number; correct: number; voided: number }>(
        `SELECT run, qid, idx, status, total, correct, voided FROM rounds ORDER BY run`,
      )
      .toArray()
      .map((x) => ({ run: x.run, qNo: x.idx + 1, qid: x.qid, status: x.status, total: x.total, correct: x.correct, voided: !!x.voided }));
    const nq = st.idx + 1 < st.qids.length ? QUESTION_BY_ID.get(st.qids[st.idx + 1]) : null;
    const v: HostView = {
      t: 'host',
      ev: st.code,
      title: st.title,
      sv: st.sv,
      phase: st.phase,
      stage: st.stage,
      page: st.page,
      qNo: this.qNo(),
      qTotal: st.qids.length,
      run: r ? r.run : 0,
      endsAt: r ? r.ends_at : null,
      now: Date.now(),
      boot: this.boot,
      registered: this.registered,
      bots: this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM participants WHERE kind='bot'`).one().c,
      connected: pids.size,
      boards: this.ctx.getWebSockets('b').length,
      submitted: this.submitted,
      runs,
      nextQuestion: nq ? { qNo: st.idx + 2, prompt: nq.prompt } : null,
    };
    if (q) {
      v.question = {
        id: q.id,
        prompt: q.prompt,
        image: q.image,
        answerDisplay: q.answerDisplay,
        accepted: q.accepted,
        extra: r ? (JSON.parse(r.extra_json) as string[]) : [],
        explanation: q.explanation,
        rules: q.rules,
        timeLimitSec: q.timeLimitSec,
      };
    }
    if (r && r.status === 'closed') {
      v.top = this.topAnswers(r.run);
      v.featured = JSON.parse(r.featured_json) as string[];
      v.correct = r.correct;
      v.voided = !!r.voided;
      v.winnerPages = Math.max(1, Math.ceil(r.correct / LIMITS.winnersPageSize));
    }
    return v;
  }

  // ───────────── 전송 ─────────────
  private sendAll(tag: string, msg: string) {
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(msg);
      } catch {
        /* 닫히는 중인 연결 */
      }
    }
  }
  private broadcastPlayers() {
    if (this.st) this.sendAll('p', JSON.stringify(this.playerView()));
  }
  private broadcastBoards() {
    if (this.st && this.ctx.getWebSockets('b').length) this.sendAll('b', JSON.stringify(this.boardView()));
  }
  private flushHosts() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.st && this.ctx.getWebSockets('h').length) this.sendAll('h', JSON.stringify(this.hostView()));
  }
  /** 제출 인원 등 집계 변화는 짧게 묶어서 진행자에게만 보낸다(한 번 예약, 반복 타이머 아님). */
  private scheduleHostFlush() {
    if (this.flushTimer || !this.ctx.getWebSockets('h').length) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushHosts();
    }, HOST_FLUSH_MS);
  }
  private broadcastAll() {
    this.broadcastPlayers();
    this.broadcastBoards();
    this.flushHosts();
  }

  // ───────────── WebSocket (Hibernation API) ─────────────
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 전용', { status: 426 });
    this.tick();
    const role = req.headers.get('x-quiz-role') as Att['role'] | null;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const deny = (code: number, reason: string, msg?: object) => {
      this.ctx.acceptWebSocket(server, ['x']);
      if (msg) server.send(JSON.stringify(msg));
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!this.st) return deny(4404, 'no-event');

    if (role === 'p') {
      const pid = Number(req.headers.get('x-quiz-pid'));
      const gen = Number(req.headers.get('x-quiz-gen'));
      const g = this.genOf(pid);
      if (g === null) return deny(4401, 'gone');
      if (g !== gen) return deny(4001, 'kicked', { t: 'kicked' });
      this.ctx.acceptWebSocket(server, ['p', 'p:' + pid]);
      server.serializeAttachment({ role: 'p', pid, gen } satisfies Att);
      server.send(JSON.stringify({ ...this.playerView(), me: this.myAnswer(pid, this.round?.run ?? 0) }));
      this.scheduleHostFlush();
    } else if (role === 'b') {
      const k = Number(req.headers.get('x-quiz-k'));
      if (k !== this.st.boardKeyVer) return deny(4401, 'rotated');
      this.ctx.acceptWebSocket(server, ['b']);
      server.serializeAttachment({ role: 'b', k } satisfies Att);
      server.send(JSON.stringify(this.boardView()));
      this.scheduleHostFlush();
    } else if (role === 'h') {
      this.ctx.acceptWebSocket(server, ['h']);
      server.serializeAttachment({ role: 'h' } satisfies Att);
      server.send(JSON.stringify(this.hostView()));
    } else {
      return new Response('권한 없음', { status: 403 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 200) return;
    this.tick();
    let m: { t?: string } = {};
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (m.t !== 'sync' || !this.st) return;
    const a = ws.deserializeAttachment() as Att | null;
    if (!a) return;
    if (a.role === 'p' && a.pid !== undefined) {
      if (this.genOf(a.pid) !== a.gen) {
        ws.send(JSON.stringify({ t: 'kicked' }));
        ws.close(4001, 'kicked');
        return;
      }
      ws.send(JSON.stringify({ ...this.playerView(), me: this.myAnswer(a.pid, this.round?.run ?? 0) }));
    } else if (a.role === 'b') ws.send(JSON.stringify(this.boardView()));
    else if (a.role === 'h') ws.send(JSON.stringify(this.hostView()));
  }

  async webSocketClose() {
    this.scheduleHostFlush();
  }

  async webSocketError() {
    this.scheduleHostFlush();
  }
}

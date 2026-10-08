#!/usr/bin/env node
// 부하 시험: 실제 참가자 경로(입장 API → 쿠키 세션 → WebSocket → 답안 API)만 쓴다. 우회 경로 없음.
//
// 사용 예 (로컬):
//   node loadtest/run.mjs --base http://127.0.0.1:8787 --n 500
//   node loadtest/run.mjs --base http://127.0.0.1:8787 --n 1000 --hold 30
// 클라우드(별도 시험 행사·시험용 Worker 에만, 승인 후):
//   node loadtest/run.mjs --base https://<시험용>.workers.dev --n 500 --cloud-ok --max-requests 12000 --max-seconds 600
//
// 진행자 비밀번호: 환경변수 HOST_PASSWORD, 또는 --password-file <파일>. 로컬 주소면 .dev.vars 를 읽는다.
// 중단: Ctrl+C (모든 연결을 닫고 그때까지의 결과를 저장한다)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { cpus, totalmem, freemem, hostname } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Agent, setGlobalDispatcher } from 'undici';
import { Bot, Host, Http, hostLogin, rid, percentile, pool, sleep } from './client.mjs';

// ───────── 인자 ─────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const BASE = (args.base ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const N = Number(args.n ?? 500);
const HOLD_SEC = Number(args.hold ?? 20);
const SPREAD_MS = Number(args.spread ?? 1000); // 집중 제출 시작 분산 구간
const DROP_RATIO = Number(args.drop ?? 0.3); // 2번 문제에서 끊었다 다시 붙일 비율
const ABORT_SIM = args['abort-sim'] !== 'false'; // 응답 전에 연결을 끊는 재시도 흉내
const JOIN_CONCURRENCY = Number(args['join-concurrency'] ?? 100);
const MAX_REQUESTS = Number(args['max-requests'] ?? 20000);
const MAX_SECONDS = Number(args['max-seconds'] ?? 900);
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE);
// 생성기의 HTTP 연결 수 상한. 0 = 제한 없음(요청마다 연결 가능 — 실제 휴대폰에 가까움).
// Windows 로컬 시험에서는 한꺼번에 수백 개의 TCP 연결을 열면 연결 거부(ECONNREFUSED)가 나므로 제한을 걸 수 있다.
const MAX_CONN = Number(args['max-conn'] ?? 0);
if (MAX_CONN > 0) setGlobalDispatcher(new Agent({ connections: MAX_CONN, pipelining: 1, keepAliveTimeout: 30_000 }));

if (!IS_LOCAL && args['cloud-ok'] !== 'true') {
  console.error('로컬이 아닌 주소입니다. 시험용 Worker·별도 시험 행사인지 확인한 뒤 --cloud-ok 를 붙여 실행하세요.');
  process.exit(2);
}
if (!Number.isInteger(N) || N < 1 || N > 2000) {
  console.error('--n 은 1~2000');
  process.exit(2);
}

function password() {
  if (process.env.HOST_PASSWORD) return process.env.HOST_PASSWORD;
  if (args['password-file']) return readFileSync(args['password-file'], 'utf8').trim();
  if (IS_LOCAL && existsSync('.dev.vars')) {
    const m = readFileSync('.dev.vars', 'utf8').match(/^HOST_PASSWORD=(.*)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('진행자 비밀번호가 필요합니다 (HOST_PASSWORD 또는 --password-file)');
}

// ───────── 안전장치: 요청 수·실행 시간 상한 ─────────
let requestCount = 0;
let wsOpenCount = 0;
let aborted = '';
const origReq = Http.prototype.req;
Http.prototype.req = function (...a) {
  if (aborted) return Promise.resolve({ status: 0, data: null, error: 'aborted', ms: 0 });
  if (++requestCount > MAX_REQUESTS) {
    abort(`요청 수 상한(${MAX_REQUESTS}) 도달`);
    return Promise.resolve({ status: 0, data: null, error: 'aborted', ms: 0 });
  }
  return origReq.apply(this, a);
};
const origWs = Http.prototype.ws;
Http.prototype.ws = function (...a) {
  wsOpenCount++;
  return origWs.apply(this, a);
};
const bots = [];
function abort(reason) {
  if (aborted) return;
  aborted = reason;
  console.error('\n■ 중단: ' + reason);
}
const deadline = setTimeout(() => abort(`실행 시간 상한(${MAX_SECONDS}초) 도달`), MAX_SECONDS * 1000);
deadline.unref();
process.on('SIGINT', () => {
  abort('사용자 중단(Ctrl+C)');
  setTimeout(() => finish().then(() => process.exit(130)), 100);
});

// ───────── 생성기(이 컴퓨터) 상태 측정 ─────────
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const cpu0 = cpus().map((c) => c.times);
const proc0 = process.cpuUsage();
const t0 = Date.now();
function machineStats() {
  const now = cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const a = cpu0[i];
    const d = (k) => t[k] - a[k];
    idle += d('idle');
    total += d('user') + d('nice') + d('sys') + d('idle') + d('irq');
  });
  const pu = process.cpuUsage(proc0);
  const wall = (Date.now() - t0) * 1000;
  return {
    host: hostname(),
    cores: cpus().length,
    systemCpuBusyPct: +(100 * (1 - idle / total)).toFixed(1),
    thisProcessCpuPctOfOneCore: +((100 * (pu.user + pu.system)) / wall).toFixed(1),
    eventLoopDelayP99ms: +(loop.percentile(99) / 1e6).toFixed(1),
    eventLoopDelayMaxMs: +(loop.max / 1e6).toFixed(1),
    memFreeMB: Math.round(freemem() / 2 ** 20),
    memTotalMB: Math.round(totalmem() / 2 ** 20),
  };
}

// ───────── 답안 계획 ─────────
const PLAN = [
  { right: ['3시', '세시', '세 시', '3:00'], wrong: ['4시', '2시'] },
  { right: ['원', '동그라미', '원형'], wrong: ['삼각형', '사각형'] },
  { right: ['3', '3개', '세개', '세 개'], wrong: ['4개', '2개'] },
];
const wantsRight = (i, q) => (i + q) % 4 !== 0; // 약 75% 정답
const pick = (arr, i) => arr[i % arr.length];
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  local: IS_LOCAL,
  options: { hold: HOLD_SEC, spread: SPREAD_MS, drop: DROP_RATIO, abortSim: ABORT_SIM, maxConn: MAX_CONN, joinConcurrency: JOIN_CONCURRENCY },
  n: N,
  note: IS_LOCAL
    ? '로컬 wrangler dev(workerd 1개 프로세스) 결과입니다. Cloudflare 실제 배포 성능이 아닙니다.'
    : 'Cloudflare 배포 대상 결과입니다. 생성기 컴퓨터·회선 영향을 포함하며 강당 LTE·5G 혼잡은 반영하지 않습니다.',
  phases: {},
};

function summarize(lat, statuses) {
  return {
    count: lat.length,
    p50: percentile(lat, 50) && +percentile(lat, 50).toFixed(1),
    p95: percentile(lat, 95) && +percentile(lat, 95).toFixed(1),
    p99: percentile(lat, 99) && +percentile(lat, 99).toFixed(1),
    max: lat.length ? +Math.max(...lat).toFixed(1) : null,
    statuses,
  };
}
const tally = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});

/** 한 요청의 결과 분류: 응답 status 또는 HTTP 오류 */
const classify = (r) => (r.data?.status ? r.data.status : r.status === 0 ? 'net:' + (r.error ?? '?') : 'http' + r.status + (r.data?.error ? ':' + r.data.error : ''));

/** 봇별로 '서버가 접수했다고 알려 준 최신 답' 기록 */
function noteAck(b, r, body) {
  const st = r.data?.status;
  if (st === 'accepted' || st === 'duplicate' || st === 'superseded' || st === 'closed') {
    const latest = r.data.latest;
    if (latest && latest.run === body.run && (!b.ack || latest.seq > b.ack.seq)) b.ack = { seq: latest.seq, text: latest.text, run: latest.run };
  }
  if (r.status === 0) b.unacked = (b.unacked ?? 0) + 1;
}

async function waitAll(pred, timeoutMs) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
}

/** 브라우저와 같은 재접속: 지수 백오프 + 무작위 지연 */
async function reconnect(b) {
  const t = performance.now();
  for (let attempt = 0; attempt < 8 && !aborted; attempt++) {
    const cap = Math.min(15000, 500 * 2 ** attempt);
    await sleep(250 + Math.random() * cap);
    if (await b.connect()) return { ok: true, ms: performance.now() - t, attempts: attempt + 1 };
  }
  return { ok: false, ms: performance.now() - t };
}

async function runQuestion(host, qi, mode) {
  const tag = `q${qi + 1}`;
  await host.mustCmd('next');
  await host.mustCmd('start');
  const live = bots.filter((b) => b.ok);
  const okOpen = await waitAll(() => live.every((b) => b.view?.phase === 'open' && b.view.qNo === qi + 1), 15000);
  const openSeen = live.filter((b) => b.view?.phase === 'open' && b.view.qNo === qi + 1).length;
  const lat = []; // 첫 전송 ~ 최종 접수 확인(재시도 포함)
  const firstLat = [];
  const doLat = []; // 서버(Worker)가 잰 Durable Object 왕복 시간
  const sts = [];
  const firstSts = [];
  let retries = 0;
  const plan = PLAN[qi];
  const dropInfo = [];

  // 실제 휴대폰 화면(Player.tsx)과 같은 재시도: 네트워크 오류·5xx·429 이면 같은 reqId·seq 로 백오프 재전송, 마감되면 중단
  const one = async (b, text, extra = {}) => {
    const run = b.view?.run;
    const qid = b.view?.qid;
    const seq = extra.seq ?? b.nextSeq(run);
    const reqId = extra.reqId ?? rid();
    const t = performance.now();
    let r;
    for (let tries = 0; ; tries++) {
      r = await b.submit(text, { seq, reqId, run, qid, timeoutMs: tries === 0 && extra.timeoutMs ? extra.timeoutMs : 15000 });
      if (tries === 0 && !extra.noStats) {
        firstLat.push(r.ms);
        if (r.serverMs !== null && r.serverMs !== undefined) doLat.push(r.serverMs);
        firstSts.push(classify(r));
      }
      noteAck(b, r, r.body);
      const transient = r.status === 0 || r.status >= 500 || r.status === 429;
      if (!transient || tries >= 6 || aborted || b.view?.phase !== 'open') break;
      retries++;
      await sleep(Math.min(8000, 400 * 2 ** (tries + 1)) * (0.5 + Math.random()));
    }
    if (!extra.noStats) {
      lat.push(performance.now() - t);
      sts.push(classify(r));
    }
    return r;
  };

  // 2번 문제: 일부 연결을 끊고 지수 백오프로 다시 붙는다
  let dropPromise = Promise.resolve();
  if (mode === 'mixed' && DROP_RATIO > 0 && !aborted) {
    const victims = live.filter((_, i) => i % Math.round(1 / DROP_RATIO) === 0);
    for (const b of victims) b.disconnect();
    dropPromise = Promise.all(
      victims.map(async (b) => {
        const r = await reconnect(b);
        dropInfo.push(r);
        if (r.ok && b.me && b.ack && b.me.seq !== undefined && b.me.seq < b.ack.seq) b.meStale = true;
      }),
    );
  }

  const tStart = performance.now();
  const tasks = live.map(async (b, i) => {
    b.ack = null;
    b.unacked = 0;
    const right = wantsRight(i, qi);
    const finalText = right ? pick(plan.right, i) : pick(plan.wrong, i);
    await sleep(Math.random() * SPREAD_MS);
    if (aborted) return;
    if (mode !== 'mixed') return one(b, finalText);
    switch (i % 5) {
      case 0:
        return one(b, finalText);
      case 1: // 답 수정: 다른 답 → 최종 답
        await one(b, pick(plan.wrong, i + 1), { seq: 1 });
        return one(b, finalText, { seq: 2 });
      case 2: {
        // 같은 요청 중복 전송(동시)
        const reqId = rid();
        return Promise.all([one(b, finalText, { seq: 1, reqId }), one(b, finalText, { seq: 1, reqId })]);
      }
      case 3: // 순서 뒤바뀜: 새 버전(seq2)을 먼저, 옛 버전(seq1)을 나중에
        return Promise.all([one(b, finalText, { seq: 2 }), sleep(30).then(() => one(b, pick(plan.wrong, i), { seq: 1 }))]);
      case 4: {
        // 통신 재시도: 응답을 못 받은 것처럼(ABORT_SIM 이면 5ms 만에 연결을 끊고) 같은 reqId 로 다시 보냄
        const reqId = rid();
        if (ABORT_SIM) return one(b, finalText, { seq: 1, reqId, timeoutMs: 5 });
        await one(b, finalText, { seq: 1, reqId, noStats: true });
        return one(b, finalText, { seq: 1, reqId });
      }
    }
  });
  await Promise.all(tasks);
  await dropPromise;
  await sleep(300);
  await host.refresh();
  const submittedSeen = host.view.submitted;
  const tasksMs = Math.round(performance.now() - tStart);
  // 제한시간 안에 끝나지 않았으면 서버가 이미 자동 마감했다(정상 동작). 열려 있을 때만 조기 마감한다.
  const autoClosed = host.view.phase !== 'open';
  if (!autoClosed) await host.mustCmd('close');
  await waitAll(() => live.every((b) => b.view?.phase === 'closed'), 10000);

  // 재접속한 봇: 서버 스냅샷의 '내 답'이 마지막 접수와 일치하는지 (sync 요청으로 확인)
  let snapshotMismatch = 0;
  if (dropInfo.length) {
    for (const b of live) b.me = undefined;
    for (const b of live) b.sock?.readyState === 1 && b.sock.send('{"t":"sync"}');
    await waitAll(() => live.every((b) => b.me !== undefined || b.sock?.readyState !== 1), 8000);
    for (const b of live) if (b.ack && b.me && (b.me.seq !== b.ack.seq || b.me.text !== b.ack.text)) snapshotMismatch++;
  }

  report.phases[tag] = {
    mode,
    participants: live.length,
    sawOpenBroadcast: openSeen,
    openBroadcastAll: okOpen,
    submittedCountOnHostBeforeClose: submittedSeen,
    allTasksDoneMs: tasksMs,
    closedBy: autoClosed ? 'alarm(제한시간)' : '진행자 조기 마감',
    submit: summarize(lat, tally(sts)),
    firstAttempt: summarize(firstLat, tally(firstSts)),
    durableObjectRoundTrip: summarize(doLat, {}),
    retries,
    reconnect: dropInfo.length
      ? { dropped: dropInfo.length, ok: dropInfo.filter((d) => d.ok).length, p95ms: +(percentile(dropInfo.filter((d) => d.ok).map((d) => d.ms), 95) ?? 0).toFixed(0) }
      : undefined,
    reconnectSnapshotMismatch: dropInfo.length ? snapshotMismatch : undefined,
  };
  for (const b of live) b[tag] = b.ack;
  const P = report.phases[tag];
  console.log(`  ${tag}(${mode}) 접수 확인까지 p50/p95/p99 = ${P.submit.p50}/${P.submit.p95}/${P.submit.p99} ms (DO 왕복 p50/p95 ${P.durableObjectRoundTrip.p50}/${P.durableObjectRoundTrip.p95}) · 최종`, P.submit.statuses, '· 첫 시도', P.firstAttempt.statuses, '· 재시도', retries, P.reconnect ? '· 재접속 ' + JSON.stringify(P.reconnect) : '');
}

async function finish() {
  for (const b of bots) b.disconnect();
  report.finishedAt = new Date().toISOString();
  report.aborted = aborted || false;
  report.requests = { http: requestCount, wsConnects: wsOpenCount };
  report.generator = machineStats();
  mkdirSync('loadtest/results', { recursive: true });
  const file = `loadtest/results/load-${IS_LOCAL ? 'local' : 'cloud'}-n${N}-${report.startedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\n결과 파일:', file);
  return file;
}

async function main() {
  console.log(`부하 시험 시작: ${BASE} · 참가자 ${N}명 · 요청 상한 ${MAX_REQUESTS} · 시간 상한 ${MAX_SECONDS}초`);
  console.log(report.note);
  const hostHttp = await hostLogin(BASE, password());
  let host;
  let codes;
  if (args.event) {
    host = new Host(hostHttp, args.event);
    codes = (await host.codes()).filter((c) => c.kind === '부하시험');
    if (args.reset !== 'false') await host.mustCmd('reset', { confirm: args.event });
  } else {
    host = await Host.create(hostHttp, `부하시험 n=${N} ${new Date().toISOString().slice(0, 16)}`);
    const tg = performance.now();
    await host.genCodes(N, 'load');
    codes = await host.codes();
    report.codeGenMs = Math.round(performance.now() - tg);
  }
  if (codes.length < N) throw new Error(`부하시험 코드가 부족합니다 (${codes.length} < ${N})`);
  report.event = host.event;
  console.log('시험 행사:', host.event);

  // ① 입장 + WebSocket 연결
  for (let i = 0; i < N; i++) bots.push(new Bot(BASE));
  const joinLat = [];
  const joinDo = [];
  const joinSt = [];
  const tj = performance.now();
  await pool(bots, JOIN_CONCURRENCY, async (b, i) => {
    const r = await b.join(host.event, codes[i].code);
    joinLat.push(r.ms);
    if (r.serverMs != null) joinDo.push(r.serverMs);
    joinSt.push(r.status === 200 ? 'ok' : classify(r));
    if (r.status === 200) b.ok = await b.connect();
  });
  const connected = bots.filter((b) => b.ok).length;
  report.phases.join = { ...summarize(joinLat, tally(joinSt)), wsConnected: connected, wallMs: Math.round(performance.now() - tj), durableObjectRoundTrip: summarize(joinDo, {}) };
  console.log(`① 입장 ${joinSt.filter((s) => s === 'ok').length}/${N}, WebSocket ${connected}/${N}, 입장 p95 ${report.phases.join.p95}ms`);

  // ② 연결 유지
  const samples = [];
  for (let s = 0; s < HOLD_SEC && !aborted; s += 5) {
    await sleep(5000);
    const hr = await host.refresh();
    if (hr.status !== 200) console.log('  진행자 화면 갱신 실패', hr.status, hr.error ?? hr.data);
    samples.push({ t: s + 5, hostStatus: hr.status, hostConnected: host.view?.connected, clientOpen: bots.filter((b) => b.sock?.readyState === 1).length });
  }
  report.phases.hold = { seconds: HOLD_SEC, samples };
  console.log(`② ${HOLD_SEC}초 유지: 진행자 화면 연결 수`, samples.map((x) => x.hostConnected).join(' → '));

  // ③ 3문항 연속 진행
  if (!aborted) await runQuestion(host, 0, 'burst');
  if (!aborted) await runQuestion(host, 1, 'mixed');
  if (!aborted) await runQuestion(host, 2, 'burst');

  // ④ 예상 결과와 실제 결과 비교
  if (!aborted) {
    const res = await host.results();
    const byName = new Map(res.rows.map((r) => [r.name, r]));
    const isRight = (qi, text) => PLAN[qi].right.map((x) => x.replace(/\s/g, '')).includes(norm(text).replace(/\s/g, ''));
    const cmp = {
      // ★ 0 이어야 함: 접수 응답을 받은 답이 서버에 없거나, 서버가 그보다 옛 버전을 가진 경우
      lostAccepted: 0,
      // 행 중복(참가자당 한 행)
      duplicateRows: 0,
      // 허용: 나중 요청이 저장됐지만 그 응답을 못 받은 경우(응답 유실 — 재시도하면 duplicate 로 확인됨)
      storedNewerThanAck: 0,
      storedWithoutAck: 0,
      ackExpectedCorrect: [0, 0, 0],
      recountCorrectFromStored: [0, 0, 0],
      serverCorrect: res.runs.map((r) => r.correct),
      serverTotal: res.runs.map((r) => r.total),
    };
    const names = new Set();
    for (const r of res.rows) {
      if (names.has(r.name)) cmp.duplicateRows++;
      names.add(r.name);
      r.cells.forEach((c, qi) => c && isRight(qi, c.text) && cmp.recountCorrectFromStored[qi]++);
    }
    bots.forEach((b) => {
      if (!b.name) return;
      const row = byName.get(b.name);
      [0, 1, 2].forEach((qi) => {
        const ack = b[`q${qi + 1}`];
        const cell = row?.cells[qi] ?? null;
        if (ack) {
          if (!cell || cell.seq < ack.seq || (cell.seq === ack.seq && cell.text !== norm(ack.text))) cmp.lostAccepted++;
          else if (cell.seq > ack.seq) cmp.storedNewerThanAck++;
          if (isRight(qi, ack.text)) cmp.ackExpectedCorrect[qi]++;
        } else if (cell) cmp.storedWithoutAck++;
      });
    });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // 채점·집계 일치: 서버에 저장된 답을 독립적으로 다시 채점한 수 == 서버 집계
    cmp.gradingMatches = same(cmp.recountCorrectFromStored, cmp.serverCorrect);
    // 접수 응답 기준 예상 == 서버 집계 (응답 유실이 없을 때만 성립해야 함)
    cmp.ackExpectationMatches = same(cmp.ackExpectedCorrect, cmp.serverCorrect);
    cmp.aggregateMatches =
      cmp.lostAccepted === 0 &&
      cmp.duplicateRows === 0 &&
      cmp.gradingMatches &&
      (cmp.ackExpectationMatches || cmp.storedNewerThanAck + cmp.storedWithoutAck > 0);
    report.compare = cmp;
    console.log('④ 예상 vs 실제:', cmp);
  }
  await finish();
  const g = report.generator;
  console.log(`생성기: 시스템 CPU ${g.systemCpuBusyPct}% · 이 프로세스 ${g.thisProcessCpuPctOfOneCore}%(1코어 기준) · 이벤트 루프 지연 p99 ${g.eventLoopDelayP99ms}ms / 최대 ${g.eventLoopDelayMaxMs}ms`);
  console.log(`요청 수: HTTP ${requestCount} · WebSocket 연결 ${wsOpenCount}`);
  process.exit(report.compare?.aggregateMatches ? 0 : 1);
}

main().catch(async (e) => {
  console.error('실패:', e.message);
  report.error = e.message;
  await finish();
  process.exit(1);
});

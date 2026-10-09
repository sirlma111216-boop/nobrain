// 실제 wrangler dev 에 HTTP·WebSocket 으로만 접근하는 기능·권한 시험.
// 순서대로 진행되는 하나의 행사 시나리오이므로 테스트 순서에 의존한다.
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import WebSocket from 'ws';
import { Bot, Host, Http, hostLogin, rid, sleep } from '../../loadtest/client.mjs';

const base = inject('base');
const password = inject('password');

let host: Host;
let codes: { name: string; code: string }[];
const bots: Bot[] = [];
let board: { http: Http; ws: WebSocket; msgs: any[] };

async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function newBot(i: number) {
  const b = new Bot(base, { keepMessages: true });
  const r = await b.join(host.event, codes[i].code);
  expect(r.status).toBe(200);
  expect(await b.connect()).toBe(true);
  bots.push(b);
  return b;
}

/** WebSocket 연결 결과: 'open' 또는 HTTP 상태 코드 */
function wsResult(http: Http, path: string, origin?: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const s = http.ws(path, () => {}, { origin });
    s.on('open', () => {
      resolve('open');
      s.terminate();
    });
    s.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    s.on('error', () => resolve(-1));
  });
}

const lastBoard = () => board.msgs.filter((m) => m.t === 'board').at(-1);

beforeAll(async () => {
  const hostHttp = await hostLogin(base, password);
  host = await Host.create(hostHttp, 'E2E 행사');
  await host.genCodes(10, 'student');
  await host.genCodes(2, 'teacher');
  codes = await host.codes();
  expect(codes.length).toBe(12);
  // 전광판 연결
  const r = await host.cmd('boardKey');
  expect(r.status).toBe(200);
  const m = String(r.data.link).match(/k=([0-9A-Z]{6})\.(.+)$/)!;
  const http = new Http(base);
  expect((await http.post('/api/board/login', { event: m[1], key: m[2] })).status).toBe(200);
  const msgs: any[] = [];
  const ws = http.ws('/ws?role=b', (x: any) => msgs.push(x));
  board = { http, ws, msgs };
  await until(() => msgs.length > 0);
});

afterAll(() => {
  for (const b of bots) b.disconnect();
  board?.ws.terminate();
});

describe('입장·권한', () => {
  it('잘못된 코드는 거부하고 정상 코드는 미리 연결된 이름으로 입장한다', async () => {
    const b = new Bot(base);
    expect((await b.join(host.event, 'ZZZZ-ZZZZ')).status).toBe(401);
    expect((await b.join('ZZZZZZ', codes[0].code)).status).toBe(404);
    expect((await b.join(host.event, '12')).status).toBe(400);
    const ok = await b.join(host.event, codes[0].code.toLowerCase()); // 소문자·하이픈 허용
    expect(ok.status).toBe(200);
    expect(ok.data.name).toBe('학생001');
    // 표시 이름만으로는 입장할 수 없다
    expect((await b.http.post('/api/join', { event: host.event, name: '학생001' })).status).toBe(400);
    for (let i = 0; i < 6; i++) await newBot(i);
    expect(bots[0].name).toBe('학생001');
    expect(bots[0].view.phase).toBe('lobby');
  });

  it('학생은 진행자 명령·진행자 화면·내보내기·전광판에 접근할 수 없다', async () => {
    const b = bots[0];
    expect((await b.http.post('/api/host/cmd', { event: host.event, cmd: 'next', cmdId: rid(), sv: 1 })).status).toBe(401);
    expect((await b.http.post('/api/host/codes', { event: host.event, count: 1, kind: 'student' })).status).toBe(401);
    expect((await b.http.get('/api/host/view?event=' + host.event)).status).toBe(401);
    expect((await b.http.get('/api/host/export/results?event=' + host.event)).status).toBe(401);
    expect((await b.http.get('/api/host/export/codes?event=' + host.event)).status).toBe(401);
    expect(await wsResult(b.http, '/ws?role=h&event=' + host.event)).toBe(401);
    expect(await wsResult(b.http, '/ws?role=b')).toBe(401);
    // 행사 코드만으로 전광판 권한을 얻을 수 없다
    expect((await new Http(base).post('/api/board/login', { event: host.event, key: 'x'.repeat(32) })).status).toBe(401);
    // 위조 쿠키
    const f = new Http(base);
    f.cookies.set('qz_h', 'eyJyIjoiaCIsIngiOjk5OTk5OTk5OTl9.AAAA');
    expect((await f.get('/api/host/view?event=' + host.event)).status).toBe(401);
  });

  it('Origin·CSRF 검사: 다른 출처 요청과 사용자 정의 헤더 없는 요청을 막는다', async () => {
    const b = bots[0];
    const evil = await b.http.req('POST', '/api/answer', { qid: 'x', run: 1, seq: 1, reqId: rid(), text: 'a' }, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const r = await fetch(base + '/api/answer', {
      method: 'POST',
      headers: { cookie: b.http.cookieHeader(), origin: base, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect(await wsResult(b.http, '/ws?role=p', 'https://evil.example')).toBe(403);
    expect(await wsResult(new Http(base), '/ws?role=p')).toBe(401);
  });

  it('진행 중인 문제가 없으면 답안을 받지 않는다', async () => {
    const r = await bots[0].submit('3시', { run: 0, qid: 'q-clock-01' });
    expect(r.data.status).toBe('not_open');
  });
});

describe('1번 문제: 접수·수정·중복·순서', () => {
  let q1run = 0;
  it('문제 시작 시 입력이 활성화되고 종료 시각이 전달된다', async () => {
    await host.mustCmd('next');
    expect(await until(() => bots.every((b) => b.view.phase === 'ready'))).toBe(true);
    // 준비 단계 전광판에는 문제 내용이 없다
    expect(lastBoard().question).toBeUndefined();
    const before = Date.now();
    await host.mustCmd('start');
    expect(await until(() => bots.every((b) => b.view.phase === 'open'))).toBe(true);
    const v = bots[0].view;
    q1run = v.run;
    expect(v.qNo).toBe(1);
    expect(v.endsAt).toBeGreaterThan(before + 15_000);
    expect(v.endsAt).toBeLessThan(Date.now() + 21_000);
    expect(await until(() => lastBoard()?.phase === 'open')).toBe(true);
    expect(lastBoard().question.prompt).toBe('몇 시일까요?');
    expect(lastBoard().answer).toBeUndefined();
  });

  it('정답·인정 답안·정규화·오답을 접수한다', async () => {
    expect((await bots[0].submit('3시')).data.status).toBe('accepted');
    expect((await bots[1].submit('  세   시 ')).data.status).toBe('accepted');
    const r2 = await bots[2].submit('３:００'); // 전각 → NFKC
    expect(r2.data.status).toBe('accepted');
    expect(r2.data.latest.text).toBe('3:00');
    expect((await bots[3].submit('네시')).data.status).toBe('accepted');
  });

  it('마감 전 수정: 마지막 버전이 유효 답안이 된다', async () => {
    expect((await bots[4].submit('4시')).data.status).toBe('accepted');
    const r = await bots[4].submit('세시');
    expect(r.data.status).toBe('accepted');
    expect(r.data.latest.seq).toBe(2);
  });

  it('같은 요청의 재시도는 중복 저장되지 않는다', async () => {
    const reqId = rid();
    const a = await bots[5].submit('3시', { seq: 1, reqId });
    const b = await bots[5].submit('3시', { seq: 1, reqId });
    expect(a.data.status).toBe('accepted');
    expect(b.data.status).toBe('duplicate');
  });

  it('순서가 뒤바뀐 과거 요청은 최신 답안을 덮어쓰지 못한다', async () => {
    const newer = await bots[5].submit('세 시', { seq: 3 });
    const older = await bots[5].submit('5시', { seq: 2 });
    expect(newer.data.status).toBe('accepted');
    expect(older.data.status).toBe('superseded');
    expect(older.data.latest.text).toBe('세 시');
  });

  it('지난 진행 버전·다른 문제 ID·형식 오류를 거부한다', async () => {
    expect((await bots[0].submit('3시', { run: q1run - 1 })).data.status).toBe('stale');
    expect((await bots[0].submit('3시', { qid: 'q-shape-01' })).data.status).toBe('stale');
    expect((await bots[0].submit('가'.repeat(31))).data.status).toBe('invalid');
    expect((await bots[0].submit('   ')).data.status).toBe('invalid');
    expect((await bots[0].submit('x'.repeat(500))).data.status).toBe('invalid');
    const bad = await bots[0].http.post('/api/answer', { qid: 'q-clock-01', run: q1run, seq: 'a', reqId: rid(), text: 'x' });
    expect(bad.data.status).toBe('invalid');
  });

  it('클라이언트가 보낸 참가자 식별값은 무시하고 쿠키의 참가자로만 저장한다', async () => {
    await sleep(2100); // 바로 앞 시험에서 쓴 빈도 제한 토큰 회복
    const r = await bots[0].http.post('/api/answer', { qid: 'q-clock-01', run: q1run, seq: 50, reqId: rid(), text: '3시', pid: 2, name: '학생002' });
    expect(r.data.status).toBe('accepted');
    const res = await host.results();
    expect(res.rows.find((x: any) => x.name === '학생002').cells[0].text).toBe('세 시'); // 학생002 의 답은 그대로
  });

  it('진행자에게 제출 인원이 묶여서 전달된다', async () => {
    expect(await until(async () => (await host.refresh(), host.view.submitted === 6), 3000)).toBe(true);
  });

  it('수동 마감 후 도착한 답은 거부되고, 채점이 확정된다', async () => {
    await host.mustCmd('close');
    expect(await until(() => bots.every((b) => b.view.phase === 'closed'))).toBe(true);
    const late = await bots[0].submit('세시');
    expect(late.data.status).toBe('closed');
    const res = await host.results();
    const byName = Object.fromEntries(res.rows.map((r: any) => [r.name, r.cells[0]]));
    expect(byName['학생001']).toMatchObject({ text: '3시', correct: true });
    expect(byName['학생002']).toMatchObject({ text: '세 시', correct: true });
    expect(byName['학생003']).toMatchObject({ text: '3:00', correct: true });
    expect(byName['학생004']).toMatchObject({ text: '네시', correct: false });
    expect(byName['학생005']).toMatchObject({ text: '세시', correct: true, versions: 2 });
    expect(byName['학생006']).toMatchObject({ text: '세 시', correct: true });
    expect(byName['학생007']).toBeNull();
    expect(res.runs[0]).toMatchObject({ total: 6, correct: 5, status: 'closed' });
  });
});

describe('공개 단계·재채점', () => {
  it('마감 단계 전광판에는 정답·집계가 없다', async () => {
    expect(await until(() => lastBoard()?.stage === 2)).toBe(true);
    const b = lastBoard();
    expect(b.answer).toBeUndefined();
    expect(b.winners).toBeUndefined();
    expect(b.featured).toBeUndefined();
  });

  it('대표 답안은 진행자가 고른 것만 공개된다', async () => {
    const none = await host.cmd('stage', { to: 3 });
    expect(none.status).toBe(409); // 고르지 않으면 공개 불가
    await host.refresh();
    const norms = host.view.top.map((t: any) => t.norm);
    expect(norms).toContain('세시');
    expect(norms).toContain('네시');
    await host.mustCmd('feature', { norms: ['세시', '네시', '없는답'] });
    await host.mustCmd('stage', { to: 3 });
    expect(await until(() => lastBoard()?.stage === 3)).toBe(true);
    const b = lastBoard();
    expect(b.featured).toEqual([
      { text: '세시', count: 3 },
      { text: '네시', count: 1 },
    ]);
    expect(b.answer).toBeUndefined();
    expect(b.winners).toBeUndefined();
  });

  it('정답·해설 → 정답자 명단 순서로 공개된다', async () => {
    await host.mustCmd('stage', { to: 4 });
    expect(await until(() => lastBoard()?.stage === 4)).toBe(true);
    expect(lastBoard().answer.display).toBe('3시');
    expect(lastBoard().winners).toBeUndefined();
    await host.mustCmd('stage', { to: 5 });
    expect(await until(() => lastBoard()?.stage === 5)).toBe(true);
    expect(lastBoard().winners).toEqual({ count: 5, names: ['학생001', '학생002', '학생003', '학생005', '학생006'], page: 0, pages: 1 });
  });

  it('인정 답안 추가·재채점을 반복해도 결과가 중복 반영되지 않는다', async () => {
    const cmdId = rid();
    const a = await host.cmd('accept', { text: '네 시' }, { cmdId });
    expect(a.data.ok).toBe(true);
    const replay = await host.cmd('accept', { text: '네 시' }, { cmdId });
    expect(replay.data.replay).toBe(true);
    await host.mustCmd('accept', { text: '네시' }); // 같은 답(띄어쓰기 무시) 다시 추가
    let res = await host.results();
    expect(res.runs[0]).toMatchObject({ total: 6, correct: 6, extra: ['네 시'] });
    expect(await until(() => lastBoard()?.winners?.count === 6)).toBe(true);
    await host.mustCmd('unaccept', { text: '네시' });
    res = await host.results();
    expect(res.runs[0]).toMatchObject({ total: 6, correct: 5, extra: [] });
    expect(res.rows.filter((r: any) => r.cells[0]?.correct).length).toBe(5);
  });

  it('상태 버전이 다른 명령(중복 클릭)은 실행하지 않는다', async () => {
    await host.refresh();
    const old = host.view.sv - 1;
    const r = await host.cmd('next', {}, { sv: old });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('STALE');
    await host.refresh();
    expect(host.view.phase).toBe('closed');
  });

  it('문제 무효 처리는 총점에서 빠진다', async () => {
    await host.mustCmd('void', { voided: true });
    let res = await host.results();
    expect(res.rows.find((r: any) => r.name === '학생001').score).toBe(0);
    expect(await until(() => lastBoard()?.voided === true && !lastBoard()?.winners)).toBe(true);
    await host.mustCmd('void', { voided: false });
    res = await host.results();
    expect(res.rows.find((r: any) => r.name === '학생001').score).toBe(1);
  });
});

describe('2번 문제: 시간 연장·자동 마감(Alarm)·경계', () => {
  it('연장된 종료 시각이 전달되고, 종료 시각 직전은 접수·직후는 거부된다', async () => {
    await host.mustCmd('next');
    await host.mustCmd('start');
    expect(await until(() => bots.every((b) => b.view.phase === 'open' && b.view.qNo === 2))).toBe(true);
    const ends0 = bots[0].view.endsAt;
    await host.mustCmd('extend', { sec: 2 });
    expect(await until(() => bots.every((b) => b.view.endsAt >= ends0 + 2000))).toBe(true);
    const endsAt = bots[0].view.endsAt;
    expect((await bots[0].submit('원')).data.status).toBe('accepted');
    expect((await bots[1].submit('동그라미')).data.status).toBe('accepted');
    // 종료 1.2초 전 제출 → 접수
    await sleep(Math.max(0, endsAt - Date.now() - 1200));
    expect((await bots[2].submit('원형')).data.status).toBe('accepted');
    // 아무도 요청하지 않아도 Alarm 이 마감한다
    await sleep(Math.max(0, endsAt - Date.now()));
    const closedByAlarm = await until(() => bots.every((b) => b.view.phase === 'closed'), 5000, 50);
    const lag = Date.now() - endsAt;
    console.log(`[측정] Alarm 자동 마감 브로드캐스트 수신까지 종료 시각 대비 ${lag}ms`);
    expect(closedByAlarm).toBe(true);
    const late = await bots[3].submit('원');
    expect(late.data.status).toBe('closed');
    const res = await host.results();
    expect(res.runs[1]).toMatchObject({ total: 3, correct: 3, status: 'closed' });
    expect(res.runs[1].closedAt).toBeGreaterThanOrEqual(endsAt);
  });
});

describe('3번 문제: 마감과 저장 경합', () => {
  it('마감 직전·직후에 몰린 요청 중 접수 응답을 받은 답만, 빠짐없이 채점된다', async () => {
    await host.mustCmd('next');
    await host.mustCmd('start');
    expect(await until(() => bots.every((b) => b.view.phase === 'open' && b.view.qNo === 3))).toBe(true);
    const texts = ['3', '3개', '세개', '4개', '세 개', '5'];
    const results: { bot: number; seq: number; text: string; status: string }[] = [];
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) {
      for (let k = 1; k <= 6; k++) {
        const text = texts[(i + k) % texts.length];
        sends.push(
          (async () => {
            await sleep(Math.random() * 400);
            const r = await bots[i].submit(text, { seq: k });
            results.push({ bot: i, seq: k, text, status: r.data?.status ?? 'http' + r.status });
          })(),
        );
      }
    }
    await sleep(200);
    const close = host.mustCmd('close');
    await Promise.all([...sends, close]);
    const res = await host.results();
    const statuses = results.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
    console.log('[측정] 경합 시험 응답 분포', statuses);
    for (let i = 0; i < 6; i++) {
      const acc = results.filter((r) => r.bot === i && r.status === 'accepted').sort((a, b) => b.seq - a.seq)[0];
      const cell = res.rows.find((r: any) => r.name === bots[i].name).cells[2];
      if (!acc) {
        // 접수된 것이 없으면 저장도 없어야 한다(혹은 superseded/duplicate 만 받은 경우 그보다 높은 seq 가 저장됨)
        const anyOk = results.some((r) => r.bot === i && ['superseded', 'duplicate'].includes(r.status));
        if (!anyOk) expect(cell).toBeNull();
        continue;
      }
      expect(cell).not.toBeNull();
      expect(cell.seq).toBeGreaterThanOrEqual(acc.seq);
      // 저장된 버전은 반드시 접수 응답을 받은 요청 중 하나
      const stored = results.find((r) => r.bot === i && r.seq === cell.seq);
      expect(stored?.status).toBe('accepted');
      expect(cell.text).toBe(stored!.text.replace(/\s+/g, ' ').trim());
      expect(cell.at).toBeLessThanOrEqual(res.runs[2].closedAt);
    }
    // 마감 이후 'accepted' 는 없어야 한다: 접수 응답 수 == 저장된 최종 답 중 접수 seq 와 일치
    const run = res.runs[2];
    expect(run.total).toBe(res.rows.filter((r: any) => r.cells[2]).length);
  });
});

describe('재접속·다중 기기·재시작', () => {
  it('끊긴 뒤 다시 연결하면 서버 최신 상태와 본인 답을 다시 받는다', async () => {
    const b = bots[0];
    b.disconnect();
    expect(await b.connect()).toBe(true);
    expect(b.view.phase).toBe('closed');
    expect(b.view.qNo).toBe(3);
    const res = await host.results();
    const mine = res.rows.find((r: any) => r.name === b.name).cells[2];
    if (mine) expect(b.me.text).toBe(mine.text);
    // 다른 참가자의 정보·정답·집계는 오지 않는다
    expect(Object.keys(b.view).sort()).toEqual(['endsAt', 'ev', 'me', 'now', 'phase', 'qNo', 'qTotal', 'qid', 'run', 't', 'title'].sort());
  });

  it('참가자 화면으로 보낸 모든 메시지에 정답·집계·명단·타인 답안이 없다', () => {
    const all = JSON.stringify(bots.flatMap((b) => b.messages));
    for (const k of ['"answer"', '"accepted"', '"winners"', '"top"', '"featured"', '"correct"', '"names"', '"explanation"', '"answerDisplay"']) {
      expect(all).not.toContain(k);
    }
    expect(all).not.toContain('정각 3시'); // 해설 문구
    expect(all).not.toContain('학생002'); // 다른 참가자 이름
  });

  it('같은 코드로 다른 기기에서 입장하면 이전 기기는 끊기고 제출할 수 없다', async () => {
    const a = await newBot(8);
    const b2 = new Bot(base);
    expect((await b2.join(host.event, codes[8].code)).status).toBe(200);
    // 서버는 {t:'kicked'} 를 보낸 뒤 4001 로 닫는다. 화면은 메시지를 받는 즉시 안내한다.
    expect(await until(() => a.kicked)).toBe(true);
    expect((await a.http.get('/api/me')).status).toBe(409);
    const r = await a.submit('x');
    expect(r.data.status).toBe('kicked');
    expect((await b2.http.get('/api/me')).status).toBe(200);
  });

  it('Durable Object 재시작 후에도 상태·답안·결과가 SQLite 에서 복구된다', async () => {
    await host.refresh();
    const before = host.view;
    const resBefore = await host.results();
    const r = await host.cmd('restart');
    expect(r.status).toBe(200);
    await sleep(800);
    expect(await until(async () => ((await host.refresh()).status === 200 && host.view.boot !== before.boot), 10000, 300)).toBe(true);
    expect(host.view.phase).toBe(before.phase);
    expect(host.view.run).toBe(before.run);
    expect(host.view.registered).toBe(before.registered);
    expect(await host.results()).toMatchObject({ runs: resBefore.runs, rows: resBefore.rows });
    // 연결이 끊긴 참가자는 다시 연결해 같은 상태를 받는다
    for (const b of bots) {
      if (b.kicked) continue;
      b.disconnect();
      expect(await b.connect()).toBe(true);
      expect(b.view.run).toBe(before.run);
    }
  });

  it('(관찰) 유휴 상태에서 Hibernation 후 깨어나는지', async () => {
    await host.refresh();
    const boot0 = host.view.boot;
    // 모든 WebSocket 을 열어 둔 채로 15초 동안 아무 요청도 보내지 않는다
    await sleep(15000);
    await host.refresh();
    console.log(`[관찰] 15초 유휴 후 인스턴스 ${boot0} → ${host.view.boot} (${boot0 === host.view.boot ? '같음: 로컬에서 Hibernation 이 관찰되지 않음' : '바뀜: Hibernation/퇴거 후 SQLite 에서 복구'})`);
    expect(host.view.phase).toBe('closed');
    // 깨어난 뒤에도 기존 WebSocket(attachment 포함)이 살아 있어 방송을 받는다
    const live = bots.filter((b) => !b.kicked);
    expect(host.view.connected).toBe(live.length);
    await host.mustCmd('next');
    expect(await until(() => live.every((b) => b.view.phase === 'ended'))).toBe(true);
  }, 30000);
});

describe('다음 문제·종료·초기화', () => {
  it('마지막 문제 다음은 종료, 초기화는 확인 코드가 있어야 하고 이전 요청은 섞이지 않는다', async () => {
    await host.refresh();
    expect(host.view.phase).toBe('ended');
    const oldRun = host.view.runs.at(-1).run;
    expect((await host.cmd('reset', { confirm: 'WRONG1' })).status).toBe(409);
    await host.mustCmd('reset', { confirm: host.event });
    await host.refresh();
    expect(host.view.phase).toBe('lobby');
    expect(host.view.runs).toEqual([]);
    expect(host.view.registered).toBe(12);
    expect((await bots[2].submit('3', { run: oldRun, qid: 'q-apple-01' })).data.status).toBe('not_open');
    await host.mustCmd('next');
    await host.mustCmd('start');
    await host.refresh();
    expect(host.view.run).toBeGreaterThan(oldRun); // 진행 버전은 초기화 후에도 줄지 않는다
    expect((await bots[2].submit('3', { run: oldRun, qid: 'q-apple-01' })).data.status).toBe('stale');
    await host.mustCmd('close');
  });

  it('참가자별 빈도 제한', async () => {
    await host.mustCmd('next');
    await host.mustCmd('start');
    await until(() => bots[3].view.phase === 'open');
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => bots[3].submit('a' + i, { seq: i + 1 })));
    const limited = rs.filter((r) => r.status === 429).length;
    expect(limited).toBeGreaterThan(0);
    await host.mustCmd('close');
  });
});

describe('연습용 봇', () => {
  it('진행자가 부른 봇이 실제 경로로 입장·답안 제출하고, 정리하면 서버에서 지워진다', async () => {
    const h2 = await hostLogin(base, password);
    const ev = await Host.create(h2, '봇 시험');
    await ev.genCodes(1, 'student');
    const [c] = await ev.codes();
    const realBot = new Bot(base);
    await realBot.join(ev.event, c.code);
    await realBot.connect();
    // 학생은 봇을 부를 수 없다
    expect((await realBot.http.post('/api/host/bots', { event: ev.event, action: 'start', count: 5 })).status).toBe(401);
    expect((await h2.post('/api/host/bots', { event: ev.event, action: 'start', count: 999 })).status).toBe(400);
    const r = await h2.post('/api/host/bots', { event: ev.event, action: 'start', count: 20 });
    expect(r.status).toBe(200);
    expect(await until(async () => (await h2.get('/api/host/bots?event=' + ev.event)).data.connected === 20, 20000, 500)).toBe(true);
    await ev.refresh();
    expect(ev.view.bots).toBe(20);
    expect(ev.view.connected).toBe(21); // 봇 연결도 진짜 참가자 WebSocket 으로 집계됨
    await ev.mustCmd('next');
    await ev.mustCmd('start');
    await realBot.waitFor((b: Bot) => b.view?.phase === 'open');
    await realBot.submit('3시');
    await sleep(16000);
    await ev.mustCmd('close');
    const res = await ev.results();
    const botRows = res.rows.filter((x: any) => x.kind === 'bot');
    expect(botRows.length).toBe(20);
    expect(botRows[0].name).toMatch(/\(봇\)$/);
    expect(botRows.filter((x: any) => x.cells[0]).length).toBeGreaterThan(5); // 대부분 제출(일부는 무응답·느림)
    const st = (await h2.get('/api/host/bots?event=' + ev.event)).data;
    expect(st.errors).toBe(0);
    const stop = await h2.post('/api/host/bots', { event: ev.event, action: 'stop' });
    expect(stop.data.removed).toBe(20);
    const after = await ev.results();
    expect(after.rows.map((x: any) => x.kind)).toEqual(['student']);
    expect(after.runs[0]).toMatchObject({ total: 1, correct: 1 }); // 봇 답을 빼고 다시 채점
    await ev.refresh();
    expect(ev.view.bots).toBe(0);
    realBot.disconnect();
  }, 60000);
});

describe('진행자 로그인 방어', () => {
  it('틀린 비밀번호를 반복하면 해당 IP 를 잠근다', async () => {
    const ipHeaders = { 'CF-Connecting-IP': '203.0.113.77' };
    const h = new Http(base, { headers: ipHeaders });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await h.post('/api/host/login', { password: 'wrong-password-' + i })).status;
    expect(last).toBe(429);
    const ok = await new Http(base, { headers: ipHeaders }).post('/api/host/login', { password });
    expect(ok.status).toBe(429); // 잠긴 동안은 맞는 비밀번호도 거부
  });
});

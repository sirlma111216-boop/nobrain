import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, rid, store } from '../lib/api';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { syncClock, useRemaining } from '../lib/clock';
import type { HostView } from '../../shared/protocol';

const STAGE_LABEL: Record<number, string> = {
  0: '-',
  1: '① 문제 공개·접수 중',
  2: '② 접수 마감',
  3: '③ 대표 답안 공개',
  4: '④ 정답·해설 공개',
  5: '⑤ 정답자 수·명단 공개',
};
const PHASE_LABEL: Record<string, string> = { lobby: '대기실', ready: '문제 준비', open: '접수 중', closed: '마감됨', ended: '종료' };

export default function Host() {
  const [auth, setAuth] = useState<'loading' | 'no' | 'yes'>('loading');
  const [devTools, setDevTools] = useState(false);
  const [event, setEvent] = useState<string | null>(new URLSearchParams(location.search).get('event'));

  useEffect(() => {
    api<{ host: boolean; devTools: boolean }>('/api/host/session')
      .then((r) => {
        setAuth(r.host ? 'yes' : 'no');
        setDevTools(r.devTools);
      })
      .catch(() => setAuth('no'));
  }, []);

  const choose = (ev: string | null) => {
    setEvent(ev);
    const u = new URL(location.href);
    if (ev) u.searchParams.set('event', ev);
    else u.searchParams.delete('event');
    history.replaceState(null, '', u);
  };

  if (auth === 'loading') return <div className="h-wrap">불러오는 중…</div>;
  if (auth === 'no') return <HostLogin onOk={() => setAuth('yes')} />;
  if (!event) return <EventPicker onPick={choose} />;
  return <Dashboard event={event} devTools={devTools} onBack={() => choose(null)} onAuthLost={() => setAuth('no')} />;
}

function HostLogin({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const login = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/api/host/login', { body: { password: pw } });
      onOk();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-wrap narrow">
      <h1>진행자 로그인</h1>
      <input
        className="h-input"
        type="password"
        autoComplete="current-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && login()}
        placeholder="진행자 비밀번호"
      />
      <button className="h-btn primary" disabled={busy || !pw} onClick={login}>로그인</button>
      {err && <p className="h-err">{err}</p>}
    </div>
  );
}

function recentEvents(): string[] {
  try {
    return JSON.parse(store.get('qz:host:recent') ?? '[]');
  } catch {
    return [];
  }
}
function remember(ev: string) {
  store.set('qz:host:recent', JSON.stringify([ev, ...recentEvents().filter((x) => x !== ev)].slice(0, 8)));
}

function EventPicker({ onPick }: { onPick: (ev: string) => void }) {
  const [title, setTitle] = useState('축제 퀴즈 (시험)');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ event: string }>('/api/host/events', { body: { title } });
      remember(r.event);
      onPick(r.event);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const open = (ev: string) => {
    const c = ev.toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (c.length !== 6) return setErr('행사 코드는 6자리입니다.');
    remember(c);
    onPick(c);
  };
  return (
    <div className="h-wrap narrow">
      <h1>행사 선택</h1>
      <section className="h-card">
        <h2>새 행사 만들기</h2>
        <input className="h-input" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="행사 이름" />
        <button className="h-btn primary" disabled={busy} onClick={create}>만들기</button>
      </section>
      <section className="h-card">
        <h2>기존 행사 열기</h2>
        <div className="h-row">
          <input className="h-input" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="행사 코드 6자리" />
          <button className="h-btn" onClick={() => open(code)}>열기</button>
        </div>
        {recentEvents().length > 0 && (
          <div className="h-recent">
            최근:{' '}
            {recentEvents().map((ev) => (
              <button key={ev} className="h-chip" onClick={() => open(ev)}>{ev}</button>
            ))}
          </div>
        )}
      </section>
      {err && <p className="h-err">{err}</p>}
    </div>
  );
}

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Dashboard({ event, devTools, onBack, onAuthLost }: { event: string; devTools: boolean; onBack: () => void; onAuthLost: () => void }) {
  const [v, setV] = useState<HostView | null>(null);
  const [conn, setConn] = useState<SocketStatus>('connecting');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [boardLink, setBoardLink] = useState('');
  const [featured, setFeatured] = useState<string[]>([]);
  const [acceptText, setAcceptText] = useState('');
  const [codeCount, setCodeCount] = useState(10);
  const [codeKind, setCodeKind] = useState('student');
  const [resetText, setResetText] = useState('');
  const [resetAll, setResetAll] = useState(false);
  const vRef = useRef<HostView | null>(null);
  const sockRef = useRef<LiveSocket | null>(null);

  const take = useCallback((m: HostView) => {
    syncClock(m.now);
    vRef.current = m;
    setV(m);
  }, []);

  useEffect(() => {
    let alive = true;
    api<HostView>(`/api/host/view?event=${event}`)
      .then((m) => alive && take(m))
      .catch((e: ApiError) => {
        if (e.status === 401) onAuthLost();
        else setMsg({ ok: false, text: e.message });
      });
    const s = new LiveSocket(`/ws?role=h&event=${event}`, (m) => m.t === 'host' && take(m), (st) => setConn(st));
    sockRef.current = s;
    s.start();
    return () => {
      alive = false;
      s.stop();
    };
  }, [event, take, onAuthLost]);

  // 대표 답안 선택은 서버 값으로 초기화(다른 진행자 기기·새로고침에서도 복원)
  const runKey = v ? `${v.run}:${(v.featured ?? []).join('|')}` : '';
  useEffect(() => {
    if (v) setFeatured(v.featured ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  /** 진행자 명령: 명령 ID 로 재시도를 안전하게 하고, 상태 버전(sv)으로 중복 클릭을 막는다 */
  const cmd = async (name: string, args: Record<string, unknown> = {}, label = name) => {
    if (busy || !vRef.current) return;
    setBusy(name);
    setMsg(null);
    const body = { event, cmd: name, args, cmdId: rid(), sv: vRef.current.sv };
    try {
      for (let i = 0; ; i++) {
        try {
          const r = await api<{ ok: boolean; view?: HostView; link?: string; message?: string }>('/api/host/cmd', { body, timeoutMs: 10_000 });
          if (r.view) take(r.view);
          if (r.link) setBoardLink(r.link);
          setMsg({ ok: true, text: `${label} 완료${(r as { replay?: boolean }).replay ? ' (재시도 확인)' : ''}` });
          return r;
        } catch (e) {
          const err = e as ApiError;
          // 응답을 못 받은 경우만 같은 명령 ID 로 재시도 (서버가 이미 처리했다면 기록된 결과를 돌려준다)
          if ((err.status === 0 || err.status >= 500) && i < 2) continue;
          throw err;
        }
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) return onAuthLost();
      const d = err.data as { view?: HostView } | undefined;
      if (d?.view) take(d.view);
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const remaining = useRemaining(v?.endsAt, v?.phase === 'open');
  if (!v) {
    return (
      <div className="h-wrap">
        <button className="h-btn" onClick={onBack}>← 행사 선택</button>
        <p>{msg?.text ?? '불러오는 중…'}</p>
      </div>
    );
  }

  const genCodes = async () => {
    setBusy('codes');
    setMsg(null);
    try {
      const r = await api<{ inserted: number }>('/api/host/codes', { body: { event, count: codeCount, kind: codeKind }, timeoutMs: 60_000 });
      setMsg({ ok: true, text: `참가 코드 ${r.inserted}개를 만들었습니다. CSV 로 내려받아 나눠 주세요.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(null);
    }
  };

  const B = (p: { name: string; args?: Record<string, unknown>; label: string; on: boolean; kind?: string }) => (
    <button className={'h-btn ' + (p.kind ?? '')} disabled={!p.on || !!busy} onClick={() => cmd(p.name, p.args, p.label)}>
      {busy === p.name ? '처리 중…' : p.label}
    </button>
  );

  const toggleFeatured = (n: string) => setFeatured((f) => (f.includes(n) ? f.filter((x) => x !== n) : [...f, n].slice(0, 8)));
  const ph = v.phase;

  return (
    <div className="h-wrap">
      <header className="h-head">
        <button className="h-btn small" onClick={onBack}>← 행사 선택</button>
        <h1>{v.title} <span className="h-code">{v.ev}</span></h1>
        <span className={'h-conn ' + conn}>{conn === 'open' ? '실시간 연결' : '다시 연결 중'}</span>
      </header>

      <section className="h-stats">
        <Stat label={v.bots ? `등록 인원 (봇 ${v.bots})` : '등록 인원'} value={v.registered} />
        <Stat label="현재 연결(참고)" value={v.connected} hint="네트워크 상태에 따라 늦게 반영될 수 있습니다" />
        <Stat label="이번 문제 제출" value={ph === 'open' || ph === 'closed' ? v.submitted : '-'} />
        <Stat label="전광판" value={v.boards} />
        <Stat label="남은 시간" value={ph === 'open' ? `${remaining}초` : '-'} />
      </section>

      {msg && <p className={msg.ok ? 'h-ok' : 'h-err'}>{msg.text}</p>}

      <section className="h-card">
        <h2>
          진행 — {v.qNo > 0 && ph !== 'ended' ? `문제 ${v.qNo}/${v.qTotal} · ` : ''}{PHASE_LABEL[ph]}
          {ph === 'closed' || ph === 'open' ? ` · ${STAGE_LABEL[v.stage]}` : ''}
        </h2>
        {v.question && ph !== 'lobby' && ph !== 'ended' && (
          <div className="h-q">
            <img src={v.question.image} alt="" />
            <div>
              <div className="h-q-prompt">{v.question.prompt}</div>
              <div className="h-q-ans">정답: <b>{v.question.answerDisplay}</b> · 인정: {[...v.question.accepted, ...v.question.extra].join(', ')}</div>
              <div className="h-q-meta">
                제한 {v.question.timeLimitSec}초 · 띄어쓰기 {v.question.rules.ignoreSpaces ? '무시' : '구분'} · 영문 대소문자 {v.question.rules.caseInsensitive ? '무시' : '구분'}
              </div>
            </div>
          </div>
        )}
        <div className="h-actions">
          <B name="next" label={ph === 'lobby' ? '첫 문제 준비' : ph === 'ready' ? '이 문제 건너뛰기' : v.nextQuestion ? '다음 문제로' : '퀴즈 끝내기'} on={ph === 'lobby' || ph === 'ready' || ph === 'closed'} />
          <B name="start" label="▶ 문제 시작" on={ph === 'ready'} kind="primary" />
          <B name="extend" args={{ sec: 10 }} label="+10초" on={ph === 'open'} />
          <B name="close" label="■ 조기 마감" on={ph === 'open'} kind="warn" />
        </div>
        {ph === 'ready' && v.question && <p className="h-hint">시작하면 전광판에 문제가 공개되고 {v.question.timeLimitSec}초 동안 답을 받습니다.</p>}
        {ph === 'closed' && v.nextQuestion && <p className="h-hint">다음: 문제 {v.nextQuestion.qNo} “{v.nextQuestion.prompt}”</p>}
      </section>

      {ph === 'closed' && (
        <section className="h-card">
          <h2>결과 공개 (현재: {STAGE_LABEL[v.stage]})</h2>
          <p className="h-hint">정답자 {v.correct ?? 0}명 / 제출 {v.submitted}명 {v.voided ? '· 무효 처리된 문제' : ''}</p>
          <div className="h-actions">
            <B name="stage" args={{ to: 2 }} label="② 마감 화면" on={v.stage !== 2} />
            <B name="stage" args={{ to: 3 }} label="③ 대표 답안 공개" on={v.stage !== 3 && (v.featured?.length ?? 0) > 0} />
            <B name="stage" args={{ to: 4 }} label="④ 정답·해설 공개" on={v.stage !== 4} />
            <B name="stage" args={{ to: 5 }} label="⑤ 정답자 공개" on={v.stage !== 5} />
          </div>
          {v.stage === 5 && (v.winnerPages ?? 1) > 1 && (
            <div className="h-actions">
              <B name="page" args={{ page: v.page - 1 }} label="◀ 이전 명단" on={v.page > 0} />
              <span className="h-pg">명단 {v.page + 1} / {v.winnerPages}</span>
              <B name="page" args={{ page: v.page + 1 }} label="다음 명단 ▶" on={v.page + 1 < (v.winnerPages ?? 1)} />
            </div>
          )}

          <h3>많이 낸 답 (전광판에 자동 공개되지 않음)</h3>
          <table className="h-table">
            <thead>
              <tr><th>대표 선택</th><th>답(비교 기준)</th><th>인원</th><th>판정</th><th></th></tr>
            </thead>
            <tbody>
              {(v.top ?? []).map((t) => (
                <tr key={t.norm} className={t.correct ? 'ok' : ''}>
                  <td><input type="checkbox" checked={featured.includes(t.norm)} onChange={() => toggleFeatured(t.norm)} /></td>
                  <td className="h-ans">{t.norm}</td>
                  <td>{t.count}</td>
                  <td>{t.correct ? '정답' : '오답'}</td>
                  <td>
                    {!t.correct && <B name="accept" args={{ text: t.norm, run: v.run }} label="정답 인정" on />}
                    {t.correct && v.question?.extra.some((e) => e.replace(/\s/g, '') === t.norm.replace(/\s/g, '')) && (
                      <B name="unaccept" args={{ text: t.norm, run: v.run }} label="인정 취소" on />
                    )}
                  </td>
                </tr>
              ))}
              {(v.top ?? []).length === 0 && <tr><td colSpan={5}>제출된 답이 없습니다.</td></tr>}
            </tbody>
          </table>
          <div className="h-actions">
            <button className="h-btn" disabled={!!busy} onClick={() => cmd('feature', { norms: featured }, '대표 답안 저장')}>선택한 대표 답안 저장 ({featured.length})</button>
          </div>
          <div className="h-row">
            <input className="h-input" value={acceptText} maxLength={30} onChange={(e) => setAcceptText(e.target.value)} placeholder="인정 답안 직접 추가 (예: 3 시)" />
            <button className="h-btn" disabled={!acceptText.trim() || !!busy} onClick={() => cmd('accept', { text: acceptText, run: v.run }, '인정 답안 추가·재채점').then(() => setAcceptText(''))}>추가 후 재채점</button>
          </div>
          <div className="h-actions">
            <B name="void" args={{ run: v.run, voided: !v.voided }} label={v.voided ? '무효 해제' : '이 문제 무효 처리'} on kind="warn" />
          </div>
        </section>
      )}

      <section className="h-card">
        <h2>문항별 집계</h2>
        <table className="h-table">
          <thead><tr><th>진행</th><th>문제</th><th>상태</th><th>제출</th><th>정답</th><th>무효</th></tr></thead>
          <tbody>
            {v.runs.map((r) => (
              <tr key={r.run}>
                <td>#{r.run}</td><td>{r.qNo}번</td><td>{r.status === 'open' ? '접수 중' : '마감·채점 완료'}</td>
                <td>{r.status === 'closed' ? r.total : '-'}</td><td>{r.status === 'closed' ? r.correct : '-'}</td><td>{r.voided ? '무효' : ''}</td>
              </tr>
            ))}
            {v.runs.length === 0 && <tr><td colSpan={6}>아직 진행한 문제가 없습니다.</td></tr>}
          </tbody>
        </table>
        <div className="h-actions">
          <button className="h-btn" onClick={() => download(`/api/host/export/results?event=${event}`)}>결과 CSV 내려받기</button>
        </div>
      </section>

      <section className="h-card">
        <h2>전광판</h2>
        <p className="h-hint">전광판 링크는 읽기 전용 권한입니다. 새로 발급하면 이전 링크는 끊깁니다. 링크를 학생에게 보여 주지 마세요.</p>
        <div className="h-actions">
          <button className="h-btn" disabled={!!busy} onClick={() => cmd('boardKey', {}, '전광판 링크 발급')}>전광판 링크 발급</button>
        </div>
        {boardLink && (
          <div className="h-row">
            <input className="h-input mono" readOnly value={boardLink} onFocus={(e) => e.target.select()} />
            <button className="h-btn" onClick={() => navigator.clipboard?.writeText(boardLink)}>복사</button>
            <button className="h-btn" onClick={() => window.open(boardLink, '_blank', 'noopener')}>열기</button>
          </div>
        )}
      </section>

      <section className="h-card">
        <h2>참가 코드</h2>
        <div className="h-row">
          <input className="h-input short" type="number" min={1} max={1000} value={codeCount} onChange={(e) => setCodeCount(Number(e.target.value))} />
          <select className="h-input short" value={codeKind} onChange={(e) => setCodeKind(e.target.value)}>
            <option value="student">학생</option>
            <option value="teacher">교사</option>
            <option value="load">부하 시험</option>
          </select>
          <button className="h-btn" disabled={!!busy} onClick={genCodes}>코드 만들기</button>
          <button className="h-btn" onClick={() => download(`/api/host/export/codes?event=${event}`)}>코드 CSV 내려받기</button>
        </div>
        <p className="h-hint">CSV 파일에는 개인 참가 코드가 들어 있습니다. 공개 폴더·저장소에 올리지 마세요.</p>
      </section>

      <BotsCard event={event} />

      <section className="h-card danger">
        <h2>시험 행사 초기화</h2>
        <p className="h-hint">답안·채점 결과·진행 기록을 지우고 대기실로 돌아갑니다. 되돌릴 수 없습니다.</p>
        <label className="h-check"><input type="checkbox" checked={resetAll} onChange={(e) => setResetAll(e.target.checked)} /> 참가자·참가 코드도 함께 삭제</label>
        <div className="h-row">
          <input className="h-input short" value={resetText} onChange={(e) => setResetText(e.target.value.toUpperCase())} placeholder={`확인: ${v.ev} 입력`} />
          <button
            className="h-btn warn"
            disabled={resetText !== v.ev || !!busy}
            onClick={() => {
              if (window.confirm('정말 초기화할까요? 되돌릴 수 없습니다.')) cmd('reset', { confirm: resetText, participants: resetAll }, '초기화').then(() => setResetText(''));
            }}
          >
            초기화
          </button>
        </div>
      </section>

      {devTools && (
        <section className="h-card">
          <h2>개발 도구 (로컬 전용)</h2>
          <p className="h-hint">Object 인스턴스: {v.boot}</p>
          <button className="h-btn" onClick={() => cmd('restart', {}, 'Object 재시작')}>Durable Object 강제 재시작</button>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="h-stat" title={hint}>
      <div className="h-stat-v">{value}</div>
      <div className="h-stat-l">{label}</div>
    </div>
  );
}

interface BotStatus {
  running: boolean;
  total: number;
  joined: number;
  connected: number;
  submitted: number;
  rejected: Record<string, number>;
  errors: number;
  stopsAt: number | null;
  lastError: string | null;
}

const REJECT_KO: Record<string, string> = { closed: '마감 후 도착', superseded: '옛 버전', stale: '지난 문제', invalid: '형식 오류', rate_limited: '빈도 제한', not_open: '진행 중 아님', kicked: '세션 종료' };

/** 연습용 봇: 서버가 실제 참가 경로(입장·WebSocket·답안 API)로 가짜 참가자를 움직인다. 진행자 화면에서만 쓴다. */
function BotsCard({ event }: { event: string }) {
  const [st, setSt] = useState<BotStatus | null>(null);
  const [count, setCount] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSt(await api<BotStatus>(`/api/host/bots?event=${event}`));
    } catch {
      /* 다음 주기에 다시 */
    }
  }, [event]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (action: 'start' | 'stop') => {
    if (action === 'stop' && !window.confirm('봇 연결을 끊고, 봇이 낸 답안·결과를 서버에서 지울까요?')) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ status: BotStatus; removed?: number }>('/api/host/bots', { body: { event, action, count }, timeoutMs: 60_000 });
      setSt(r.status);
      setMsg({ ok: true, text: action === 'start' ? `봇 ${count}명을 불렀습니다. 몇 초에 걸쳐 차례로 들어옵니다.` : `봇을 내보냈습니다. 봇 자료 ${r.removed ?? 0}명분을 지우고 다시 채점했습니다.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  const rejected = st ? Object.entries(st.rejected).map(([k, n]) => `${REJECT_KO[k] ?? k} ${n}`).join(', ') : '';
  return (
    <section className="h-card">
      <h2>연습용 봇 (리허설)</h2>
      <p className="h-hint">
        가짜 참가자가 <b>진짜 휴대폰과 같은 경로</b>(참가 코드 입장 → 실시간 연결 → 답안 제출)로 들어와 문제마다 답을 냅니다.
        정답·오답·답 고치기·무응답·마감 직전 제출이 섞여 있습니다. 이름에는 "(봇)"이 붙고, 60분이 지나면 자동으로 멈춥니다.
      </p>
      <div className="h-row">
        <input className="h-input short" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        <button className="h-btn primary" disabled={busy || !(count >= 1 && count <= 200)} onClick={() => act('start')}>
          {st?.running ? '봇 다시 부르기' : '봇 불러오기'}
        </button>
        <button className="h-btn warn" disabled={busy} onClick={() => act('stop')}>봇 내보내기·정리</button>
      </div>
      {st?.running && (
        <p className="h-hint">
          실행 중: 입장 {st.joined}/{st.total} · 연결 {st.connected} · 접수된 제출 {st.submitted}
          {rejected && ` · 거부(정상 동작 포함) ${rejected}`}
          {st.errors > 0 && ` · 오류 ${st.errors}(${st.lastError})`}
          {st.stopsAt && ` · ${new Date(st.stopsAt).toLocaleTimeString('ko-KR')} 자동 종료`}
        </p>
      )}
      {st && !st.running && <p className="h-hint">봇이 없습니다.</p>}
      {msg && <p className={msg.ok ? 'h-ok' : 'h-err'}>{msg.text}</p>}
    </section>
  );
}

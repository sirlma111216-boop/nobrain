import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, rid, store } from '../lib/api';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { syncClock, useRemaining } from '../lib/clock';
import type { MyAnswer, PlayerView, SubmitResult } from '../../shared/protocol';
import { LIMITS } from '../../shared/protocol';

interface Me {
  name: string;
  event: string;
  title: string;
}

export default function Player() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [notice, setNotice] = useState<string>('');

  useEffect(() => {
    api<Me & { ok: boolean }>('/api/me')
      .then((r) => setMe({ name: r.name, event: r.event, title: r.title }))
      .catch((e: ApiError) => {
        if (e.code === 'KICKED') setNotice(e.message);
        else if (e.status === 0) setNotice('네트워크 연결을 확인한 뒤 새로고침하세요.');
        setMe(null);
      });
  }, []);

  if (me === 'loading') return <div className="p-center">불러오는 중…</div>;
  if (!me) return <JoinForm notice={notice} onJoined={(m) => { setNotice(''); setMe(m); }} />;
  return (
    <Game
      me={me}
      onLeave={(msg) => {
        setNotice(msg);
        setMe(null);
      }}
    />
  );
}

function fmtInput(v: string) {
  const s = v.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s;
}

function JoinForm({ notice, onJoined }: { notice: string; onJoined: (m: Me) => void }) {
  const params = new URLSearchParams(location.search);
  const [event, setEvent] = useState((params.get('e') ?? store.get('qz:event') ?? '').toUpperCase().slice(0, 6));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const join = async () => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const r = await api<Me & { ok: boolean }>('/api/join', { body: { event, code } });
      store.set('qz:event', r.event);
      onJoined({ name: r.name, event: r.event, title: r.title });
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    join();
  };

  return (
    <div className="p-wrap">
      <header className="p-brand">축제 퀴즈</header>
      <main className="p-card">
        <h1 className="p-h1">입장하기</h1>
        {notice && <p className="p-msg warn">{notice}</p>}
        <label className="p-label" htmlFor="ev">행사 코드</label>
        <input
          id="ev"
          className="p-input code"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={event}
          maxLength={6}
          onChange={(e) => setEvent(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6))}
          onKeyDown={onKey}
          placeholder="예: AB12CD"
        />
        <label className="p-label" htmlFor="code">개인 참가 코드</label>
        <input
          id="code"
          className="p-input code"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(fmtInput(e.target.value))}
          onKeyDown={onKey}
          placeholder="XXXX-XXXX"
        />
        {err && <p className="p-msg err" role="alert">{err}</p>}
        <button className="p-btn" disabled={busy || event.length !== 6 || code.replace('-', '').length !== 8} onClick={join}>
          {busy ? '확인 중…' : '입장'}
        </button>
        <p className="p-hint">참가 코드는 한 사람에게 하나씩 나누어 준 코드입니다. 다른 기기에서 같은 코드로 입장하면 이 기기의 연결은 끝납니다.</p>
      </main>
    </div>
  );
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'accepted' }
  | { kind: 'failed'; msg: string }
  | { kind: 'error'; msg: string }
  | { kind: 'closed'; msg: string };

interface Pending {
  qid: string;
  run: number;
  seq: number;
  reqId: string;
  text: string;
  tries: number;
}

function Game({ me, onLeave }: { me: Me; onLeave: (msg: string) => void }) {
  const [view, setView] = useState<PlayerView | null>(null);
  const [conn, setConn] = useState<SocketStatus>('connecting');
  const [draft, setDraftState] = useState('');
  const [confirmed, setConfirmed] = useState<MyAnswer | null>(null);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });

  const viewRef = useRef<PlayerView | null>(null);
  const confirmedRef = useRef<MyAnswer | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const seqRef = useRef(0);
  const sockRef = useRef<LiveSocket | null>(null);
  const runRef = useRef(0);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;

  const setDraft = (v: string) => {
    setDraftState(v);
    if (runRef.current) store.set(`qz:draft:${me.event}:${runRef.current}`, v);
  };
  const confirm = (a: MyAnswer | null | undefined) => {
    if (!a || a.run !== runRef.current) return;
    if (confirmedRef.current && confirmedRef.current.seq > a.seq) return; // 늦게 온 옛 응답은 무시
    confirmedRef.current = a;
    setConfirmed(a);
    if (a.seq > seqRef.current) {
      seqRef.current = a.seq;
      store.set(`qz:seq:${me.event}:${a.run}`, String(a.seq));
    }
  };

  const onMessage = useCallback(
    (m: any) => {
      if (m.t === 'kicked') {
        leaveRef.current('다른 기기에서 같은 참가 코드로 입장해 이 기기의 연결이 끝났습니다.');
        return;
      }
      if (m.t !== 'state') return;
      const v = m as PlayerView;
      syncClock(v.now);
      const prevRun = runRef.current;
      if (v.run !== prevRun) {
        // 새 문제(또는 문제 없음): 이전 문제의 미전송 답은 버린다. 다음 문제로 보내지 않는다.
        runRef.current = v.run;
        pendingRef.current = null;
        confirmedRef.current = null;
        setConfirmed(null);
        seqRef.current = v.run ? Number(store.get(`qz:seq:${me.event}:${v.run}`) ?? 0) : 0;
        setDraftState(v.run ? store.get(`qz:draft:${me.event}:${v.run}`) ?? '' : '');
        setSend({ kind: 'idle' });
      }
      if (m.me !== undefined) confirm(m.me);
      if (v.phase !== 'open' && v.run) {
        const lost = pendingRef.current;
        pendingRef.current = null;
        setSend(
          lost
            ? { kind: 'closed', msg: '마감되어 마지막으로 누른 답은 접수되지 않았습니다.' }
            : { kind: 'closed', msg: '답안 접수가 마감되었습니다.' },
        );
      }
      viewRef.current = v;
      setView(v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me.event],
  );

  useEffect(() => {
    const s = new LiveSocket('/ws?role=p', onMessage, (st, info) => {
      setConn(st);
      if (st === 'stopped') {
        if (info?.code === 4001) leaveRef.current('다른 기기에서 같은 참가 코드로 입장해 이 기기의 연결이 끝났습니다.');
        else leaveRef.current('입장 정보가 만료되었거나 행사가 초기화되었습니다. 다시 입장하세요.');
      }
    });
    sockRef.current = s;
    s.start();
    return () => s.stop();
  }, [onMessage]);

  const remaining = useRemaining(view?.endsAt, view?.phase === 'open');
  const timeUp = view?.phase === 'open' && remaining === 0;

  // 기기 시계로 시간이 끝났는데 마감 소식이 안 오면 한 번 상태를 다시 요청
  useEffect(() => {
    if (!timeUp) return;
    const id = setTimeout(() => sockRef.current?.sync(), 1500);
    return () => clearTimeout(id);
  }, [timeUp]);

  const stillValid = (p: Pending) => {
    const v = viewRef.current;
    return !!v && v.phase === 'open' && v.run === p.run && pendingRef.current === p;
  };

  const attempt = async (p: Pending) => {
    try {
      const r = await api<SubmitResult>('/api/answer', {
        body: { qid: p.qid, run: p.run, seq: p.seq, reqId: p.reqId, text: p.text },
        timeoutMs: 8000,
      });
      handle(p, r);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) return onLeave('입장 정보가 만료되었습니다. 다시 입장하세요.');
      if (err.status === 429 && (err.data as SubmitResult)?.status === 'rate_limited') return retry(p, '잠시 후 자동으로 다시 보냅니다.');
      retry(p, err.status === 0 ? '전송 실패 — 연결을 확인하며 다시 보내는 중' : '서버가 바빠 다시 보내는 중');
    }
  };

  const retry = (p: Pending, msg: string) => {
    if (!stillValid(p)) return;
    p.tries++;
    setSend({ kind: 'failed', msg });
    // 같은 reqId·seq 로 재전송 → 서버가 중복을 알아본다
    const delay = Math.min(8000, 400 * 2 ** p.tries) * (0.5 + Math.random());
    setTimeout(() => {
      if (stillValid(p)) attempt(p);
    }, delay);
  };

  const handle = (p: Pending, r: SubmitResult) => {
    const mine = pendingRef.current === p;
    switch (r.status) {
      case 'accepted':
      case 'duplicate':
        confirm(r.latest);
        if (mine) {
          pendingRef.current = null;
          setSend({ kind: 'accepted' });
        }
        return;
      case 'superseded':
        confirm(r.latest);
        if (mine) {
          pendingRef.current = null;
          setSend(r.latest && r.latest.text === p.text ? { kind: 'accepted' } : { kind: 'error', msg: '더 최근에 보낸 답이 이미 접수되어 있습니다.' });
        }
        return;
      case 'closed':
        confirm(r.latest);
        if (mine) pendingRef.current = null;
        setSend({ kind: 'closed', msg: '서버 마감 후 도착해 접수되지 않았습니다.' });
        return;
      case 'stale':
      case 'not_open':
        if (mine) pendingRef.current = null;
        setSend({ kind: 'closed', msg: '지난 문제라 접수되지 않았습니다.' });
        sockRef.current?.sync();
        return;
      case 'invalid':
        if (mine) {
          pendingRef.current = null;
          setSend({ kind: 'error', msg: r.message ?? '답을 확인하세요.' });
        }
        return;
      case 'rate_limited':
        return retry(p, r.message ?? '잠시 후 다시 보냅니다.');
      case 'kicked':
        return onLeave('다른 기기에서 같은 참가 코드로 입장해 이 기기의 연결이 끝났습니다.');
    }
  };

  const submit = () => {
    const v = viewRef.current;
    if (!v || v.phase !== 'open' || !v.qid) return;
    const text = draft.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!text) return setSend({ kind: 'error', msg: '답을 입력하세요.' });
    if ([...text].length > LIMITS.answerMaxChars) return setSend({ kind: 'error', msg: `답은 ${LIMITS.answerMaxChars}자 이내로 입력하세요.` });
    if (!pendingRef.current && confirmedRef.current?.text === text) return setSend({ kind: 'accepted' });
    seqRef.current += 1;
    store.set(`qz:seq:${me.event}:${v.run}`, String(seqRef.current));
    const p: Pending = { qid: v.qid, run: v.run, seq: seqRef.current, reqId: rid(), text, tries: 0 };
    pendingRef.current = p;
    setSend({ kind: 'sending' });
    attempt(p);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // 한글 조합 중 Enter 는 글자 확정용이므로 제출하지 않는다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const logout = async () => {
    if (!confirm2('이 기기에서 나갈까요? 다시 들어오려면 참가 코드가 필요합니다.')) return;
    try {
      await api('/api/logout', { body: {} });
    } catch {
      /* 무시 */
    }
    onLeave('');
  };

  if (!view) {
    return (
      <div className="p-wrap">
        <TopBar me={me} conn={conn} />
        <div className="p-center">연결하는 중…</div>
      </div>
    );
  }

  const open = view.phase === 'open' && !timeUp;
  const changed = confirmed ? confirmed.text !== draft.normalize('NFKC').replace(/\s+/g, ' ').trim() : draft.trim() !== '';

  return (
    <div className="p-wrap">
      <TopBar me={me} conn={conn} />
      {view.phase === 'lobby' && (
        <main className="p-card center">
          <div className="p-big">곧 시작합니다</div>
          <p className="p-sub">문제는 무대 화면에 나옵니다.<br />이 화면은 그대로 켜 두세요.</p>
        </main>
      )}
      {view.phase === 'ready' && (
        <main className="p-card center">
          <div className="p-qno">문제 {view.qNo} / {view.qTotal}</div>
          <div className="p-big">준비하세요!</div>
          <p className="p-sub">무대 화면을 봐 주세요.</p>
        </main>
      )}
      {view.phase === 'ended' && (
        <main className="p-card center">
          <div className="p-big">퀴즈가 끝났습니다</div>
          <p className="p-sub">참여해 주셔서 고맙습니다!</p>
        </main>
      )}
      {(view.phase === 'open' || view.phase === 'closed') && (
        <main className="p-card">
          <div className="p-row">
            <div className="p-qno">문제 {view.qNo} / {view.qTotal}</div>
            <div className={'p-timer' + (open && (remaining ?? 0) <= 5 ? ' hurry' : '')} aria-live="off">
              {view.phase === 'closed' ? '마감' : timeUp ? '마감 중' : `${remaining}초`}
            </div>
          </div>
          <input
            className="p-input answer"
            value={draft}
            disabled={!open}
            maxLength={LIMITS.answerMaxChars + 10}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={open ? '정답을 입력하세요' : '입력이 닫혔습니다'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button className="p-btn" disabled={!open || send.kind === 'sending'} onClick={submit}>
            {!open ? '마감됨' : send.kind === 'sending' ? '전송 중…' : confirmed ? '답 고쳐서 다시 제출' : '제출'}
          </button>
          <StatusLine send={send} />
          <div className="p-accepted">
            <span className="lbl">서버에 접수된 내 답</span>
            {confirmed ? (
              <span className="val">
                “{confirmed.text}” <small>{new Date(confirmed.at).toLocaleTimeString('ko-KR')}</small>
              </span>
            ) : (
              <span className="val none">아직 없음</span>
            )}
            {open && confirmed && changed && <span className="p-diff">입력 칸의 답은 아직 제출하지 않았습니다.</span>}
          </div>
          {open && <p className="p-hint">마감 전까지 몇 번이든 고쳐 낼 수 있어요. 마지막으로 접수된 답만 채점합니다.</p>}
        </main>
      )}
      <footer className="p-foot">
        <button className="p-link" onClick={logout}>나가기</button>
      </footer>
    </div>
  );
}

function confirm2(msg: string) {
  return window.confirm(msg);
}

function StatusLine({ send }: { send: SendState }) {
  switch (send.kind) {
    case 'idle':
      return <p className="p-status">&nbsp;</p>;
    case 'sending':
      return <p className="p-status sending">⏳ 전송 중…</p>;
    case 'accepted':
      return <p className="p-status ok">✔ 접수 완료</p>;
    case 'failed':
      return <p className="p-status fail">⚠ {send.msg}</p>;
    case 'error':
      return <p className="p-status fail">⚠ {send.msg}</p>;
    case 'closed':
      return <p className="p-status closed">⏹ {send.msg}</p>;
  }
}

function TopBar({ me, conn }: { me: Me; conn: SocketStatus }) {
  return (
    <header className="p-top">
      <span className="p-title">{me.title}</span>
      <span className="p-name">{me.name}</span>
      <span className={'p-conn ' + conn} title="연결 상태">
        {conn === 'open' ? '연결됨' : conn === 'stopped' ? '끊김' : '다시 연결 중'}
      </span>
    </header>
  );
}


import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { joinUrlFor, useQr } from '../lib/qr';
import { api, ApiError } from '../lib/api';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { serverNow, syncClock, useRemaining } from '../lib/clock';
import type { BoardView } from '../../shared/protocol';

// 16:9 전광판. 읽기 전용 권한이며 서버가 보낸 '현재 공개 단계' 정보만 그린다.

// StrictMode 에서 effect 가 두 번 돌아도 로그인은 한 번만 하도록 모듈 수준에서 한 번만 시작
let boot: Promise<{ ok: boolean; err?: string }> | null = null;
function bootBoard() {
  if (boot) return boot;
  const m = location.hash.match(/k=([0-9A-Z]{6})\.([A-Za-z0-9_-]+)/);
  if (m) {
    // 링크 키를 쿠키 세션으로 바꾸고 주소창에서 지운다
    history.replaceState(null, '', location.pathname);
    boot = api('/api/board/login', { body: { event: m[1], key: m[2] } }).then(
      () => ({ ok: true }),
      (e: ApiError) => ({ ok: false, err: e.message }),
    );
  } else {
    boot = api('/api/board/session').then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
  }
  return boot;
}

export default function Board() {
  const [state, setState] = useState<'loading' | 'need-link' | 'ok'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    bootBoard().then((r) => {
      if (r.err) setErr(r.err);
      setState(r.ok ? 'ok' : 'need-link');
    });
  }, []);

  if (state === 'loading') return <div className="b-root"><div className="b-stage"><div className="b-center">불러오는 중…</div></div></div>;
  if (state === 'need-link')
    return (
      <div className="b-root">
        <div className="b-stage">
          <div className="b-center">
            <div className="b-title">전광판</div>
            <p className="b-sub">진행자 화면에서 발급한 전광판 링크로 열어 주세요.</p>
            {err && <p className="b-sub err">{err}</p>}
          </div>
        </div>
      </div>
    );
  return <Live onLost={(e) => { setErr(e); setState('need-link'); }} />;
}

function Live({ onLost }: { onLost: (msg: string) => void }) {
  const [v, setV] = useState<BoardView | null>(null);
  const [conn, setConn] = useState<SocketStatus>('connecting');
  const [full, setFull] = useState(false);

  useEffect(() => {
    const s = new LiveSocket(
      '/ws?role=b',
      (m) => {
        if (m.t !== 'board') return;
        syncClock(m.now);
        setV(m);
      },
      (st) => {
        setConn(st);
        if (st === 'stopped') onLost('전광판 링크가 교체되었거나 만료되었습니다. 진행자 화면에서 새 링크를 받으세요.');
      },
    );
    s.start();
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      s.stop();
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [onLost]);

  const joinUrl = joinUrlFor(v?.ev ?? '');
  const qr = useQr(joinUrl);
  const remaining = useRemaining(v?.endsAt, v?.phase === 'open');

  const goFull = () => document.documentElement.requestFullscreen?.().catch(() => {});

  return (
    <div className="b-root">
      <div className="b-stage">
        {!v ? (
          <div className="b-center">연결하는 중…</div>
        ) : (
          <Scene v={v} qr={qr} joinUrl={joinUrl} remaining={remaining} />
        )}
        {conn !== 'open' && v && <div className="b-conn">다시 연결 중…</div>}
      </div>
      {!full && (
        <button className="b-full" onClick={goFull}>
          전체화면
        </button>
      )}
    </div>
  );
}

function JoinBox({ qr, joinUrl, ev, big }: { qr: string; joinUrl: string; ev: string; big?: boolean }) {
  return (
    <div className={'b-join' + (big ? ' big' : '')}>
      {qr && <img className="b-qr" src={qr} alt="입장 QR 코드" />}
      <div className="b-join-text">
        <div className="b-url">{joinUrl.replace(/^https?:\/\//, '')}</div>
        <div className="b-ev">행사 코드 <b>{ev}</b></div>
      </div>
    </div>
  );
}

function Scene({ v, qr, joinUrl, remaining }: { v: BoardView; qr: string; joinUrl: string; remaining: number | null }) {
  if (v.phase === 'lobby') {
    return (
      <div className="b-lobby">
        <div className="b-title">{v.title}</div>
        <JoinBox qr={qr} joinUrl={joinUrl} ev={v.ev} big />
        <div className="b-sub">휴대폰 카메라로 QR 코드를 찍고, 구분을 고른 뒤 이름을 쓰고 입장하세요.</div>
      </div>
    );
  }
  if (v.phase === 'ended') return <EndScene s={v.standings} />;
  if (v.phase === 'ready') {
    return (
      <div className="b-ready">
        <div className="b-qbadge big">문제 {v.qNo}</div>
        <div className="b-sub">곧 시작합니다 — 휴대폰을 준비하세요!</div>
        <JoinBox qr={qr} joinUrl={joinUrl} ev={v.ev} />
      </div>
    );
  }
  // open / closed
  const q = v.question;
  const head = (
    <div className="b-head">
      <div className="b-qbadge">
        문제 {v.qNo} <small>/ {v.qTotal}</small>
      </div>
      <div className={'b-timer' + (v.phase === 'open' && (remaining ?? 0) <= 5 ? ' hurry' : '')}>
        {v.phase === 'open' ? `${remaining ?? 0}` : '마감'}
      </div>
    </div>
  );

  if (v.phase === 'open' || v.stage === 2) {
    return (
      <div className="b-question">
        {head}
        <div className="b-qbody">
          {q && <img className="b-img" src={q.image} alt={q.imageAlt} />}
          {q?.prompt && <div className="b-prompt">{q.prompt}</div>}
        </div>
        {v.phase === 'closed' && <div className="b-stamp">답안 접수 마감</div>}
        <div className="b-foot">{joinUrl.replace(/^https?:\/\//, '')} · 행사 코드 {v.ev}</div>
      </div>
    );
  }
  if (v.stage === 3) {
    const max = Math.max(1, ...(v.featured ?? []).map((f) => f.count));
    return (
      <div className="b-question">
        {head}
        <div className="b-split">
          {q && <img className="b-img small" src={q.image} alt={q.imageAlt} />}
          <div className="b-featured">
            <div className="b-h2">여러분이 낸 답</div>
            {(v.featured ?? []).map((f) => (
              <div className="b-bar" key={f.text}>
                <span className="b-bar-t">{f.text}</span>
                <span className="b-bar-fill" style={{ width: `${(f.count / max) * 100}%` }} />
                <span className="b-bar-n">{f.count}명</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (v.stage === 4 && v.standings) {
    const s = v.standings;
    return <StandingsGate at={s.at} early={<AnswerScene v={v} head={head} />} late={<Standings s={s} head={head} />} />;
  }
  if (v.stage === 4) return <AnswerScene v={v} head={head} />;
  return <WinnersScene v={v} head={head} />;
}

function AnswerScene({ v, head }: { v: BoardView; head: ReactNode }) {
  const q = v.question;
  return (
    <div className="b-question">
      {head}
      <div className="b-split">
        {q && <img className="b-img small" src={q.image} alt={q.imageAlt} />}
        <div className="b-answer">
          <div className="b-h2">정답</div>
          <div className="b-ans">{v.answer?.display}</div>
          {v.tally && (
            <div className="b-tally">
              <div className="b-tally-ok"><span>맞힘</span><b>{v.tally.correct}</b>명</div>
              <div className="b-tally-no"><span>틀림</span><b>{v.tally.wrong}</b>명</div>
            </div>
          )}
          <div className="b-exp">{v.answer?.explanation}</div>
          {v.voided && <div className="b-void">이 문제는 무효 처리되었습니다</div>}
        </div>
      </div>
    </div>
  );
}

/** 서버 시각 at 전에는 early, 지난 뒤에는 late. 다시 연결돼 늦게 받아도 시각 기준이라 어긋나지 않는다. */
function StandingsGate({ at, early, late }: { at: number; early: ReactNode; late: ReactNode }) {
  const [, force] = useState(0);
  const wait = at - serverNow();
  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => force((x) => x + 1), wait + 50);
    return () => clearTimeout(id);
  }, [at, wait > 0]);
  return <>{wait > 0 ? early : late}</>;
}

/**
 * 이름 칸을 넘치지 않는 가장 큰 글자 크기(em). 적을수록 크고 많을수록 작다.
 * 이름 길이가 제각각이라 공식으로 어림한 뒤, 실제로 넘치면 조금씩 줄인다(창 크기가 바뀌어도 em 이라 비율 그대로).
 */
function useFitSize(names: string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  const key = names.join('|');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s = Math.min(12, 30 / Math.sqrt(Math.max(1, names.length)));
    el.style.fontSize = s + 'em';
    while (s > 0.6 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
      s *= 0.92;
      el.style.fontSize = s + 'em';
    }
    setSize(s);
  }, [key]);
  return { ref, size };
}

function Standings({ s, head }: { s: NonNullable<BoardView['standings']>; head: ReactNode }) {
  const more = s.count - s.names.length;
  const fit = useFitSize(s.names);
  const title = s.score === 0 ? '아직 맞힌 사람이 없습니다' : s.perfect ? `${s.total}문제 모두 맞힌 사람` : `가장 많이 맞힌 사람 (${s.total}문제 중 ${s.score}개)`;
  return (
    <div className="b-question">
      {head}
      <div className="b-standings">
        <div className="b-h2">
          {title} {s.score > 0 && <b>{s.count}명</b>}
        </div>
        <div className="b-snames" ref={fit.ref} style={fit.size ? { fontSize: `${fit.size}em` } : undefined}>
          {s.names.map((n) => (
            <span key={n}>{n}</span>
          ))}
          {more > 0 && <span className="more">외 {more}명</span>}
        </div>
      </div>
    </div>
  );
}

/** 퀴즈 종료: 최종 성적 + 마무리 인사 */
function EndScene({ s }: { s: BoardView['standings'] }) {
  const names = s && s.score > 0 ? (s.perfect ? s.names : s.names.map((n) => `${n}(${s.score}개)`)) : [];
  const more = s ? s.count - s.names.length : 0;
  const fit = useFitSize(names);
  return (
    <div className="b-end">
      <div className="b-end-title">퀴즈가 종료되었습니다.</div>
      <div className="b-end-label">
        {!s || s.score === 0 ? '맞춘 참여자가 없습니다.' : s.perfect ? '모두 맞춘 참여자 이름 :' : '가장 많이 맞춘 참여자 이름 :'}
      </div>
      <div className="b-snames" ref={fit.ref} style={fit.size ? { fontSize: `${fit.size}em` } : undefined}>
        {names.map((n) => (
          <span key={n}>{n}</span>
        ))}
        {more > 0 && <span className="more">외 {more}명</span>}
      </div>
      <div className="b-end-thanks">출제자의 의도를 맞추느라 수고 많으셨습니다!!!</div>
      <div className="b-end-prize">상품은.... 방송반의 사랑을 드립니다!</div>
    </div>
  );
}

function WinnersScene({ v, head }: { v: BoardView; head: ReactNode }) {
  const w = v.winners;
  return (
    <div className="b-question">
      {head}
      {v.voided ? (
        <div className="b-center"><div className="b-void">이 문제는 무효 처리되었습니다</div></div>
      ) : (
        <div className="b-winners">
          <div className="b-h2">
            정답자 <b>{w?.count ?? 0}</b>명 {w && w.pages > 1 && <small>({w.page + 1}/{w.pages})</small>}
          </div>
          <div className="b-names">
            {(w?.names ?? []).map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          {w && w.count === 0 && <div className="b-sub">이번 문제는 정답자가 없습니다.</div>}
        </div>
      )}
    </div>
  );
}

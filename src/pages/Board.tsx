import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../lib/api';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { syncClock, useRemaining } from '../lib/clock';
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

function useQr(text: string) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 720, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => setSrc(''));
  }, [text]);
  return src;
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

  const joinUrl = `${location.origin}/?e=${v?.ev ?? ''}`;
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
        <div className="b-sub">휴대폰 카메라로 QR 코드를 찍고, 받은 참가 코드로 입장하세요.</div>
      </div>
    );
  }
  if (v.phase === 'ended') {
    return (
      <div className="b-center">
        <div className="b-title">퀴즈 끝!</div>
        <div className="b-sub">참여해 주셔서 고맙습니다.</div>
      </div>
    );
  }
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
          <div className="b-prompt">{q?.prompt}</div>
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
  if (v.stage === 4) {
    return (
      <div className="b-question">
        {head}
        <div className="b-split">
          {q && <img className="b-img small" src={q.image} alt={q.imageAlt} />}
          <div className="b-answer">
            <div className="b-h2">정답</div>
            <div className="b-ans">{v.answer?.display}</div>
            <div className="b-exp">{v.answer?.explanation}</div>
            {v.voided && <div className="b-void">이 문제는 무효 처리되었습니다</div>}
          </div>
        </div>
      </div>
    );
  }
  // stage 5
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

// 진행자 전용: 문제세트 만들기·고치기 + 혼자 풀기.
// 정답·해설은 진행자 쿠키가 있어야 받는 API(/api/host/sets/:id)에서만 온다. 학생 화면 번들에는 정답이 없다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { HostLogin } from './Host';

interface SetInfo {
  id: string;
  title: string;
  count: number;
  editable: boolean;
}
interface Q {
  id: string;
  prompt: string;
  image: string;
  imageAlt: string;
  timeLimitSec: number;
  answerDisplay: string;
  accepted: string[];
  explanation: string;
  rules: { ignoreSpaces: boolean; caseInsensitive: boolean };
  decoys?: string[];
}
interface FullSet {
  id: string;
  title: string;
  questions: Q[];
  editable: boolean;
}
interface Check {
  correct: boolean;
  text: string;
  answerDisplay: string;
  explanation: string;
}
type Result = { q: Q; text: string; correct: boolean; timeout: boolean; skipped: boolean };

export default function HostSets() {
  const [auth, setAuth] = useState<'loading' | 'no' | 'yes'>('loading');
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [full, setFull] = useState<FullSet | null>(null);
  const [solo, setSolo] = useState<{ order: Q[]; timer: number } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadList = useCallback(async () => {
    const s = await api<SetInfo[]>('/api/host/sets');
    setSets(s);
    return s;
  }, []);

  const loadSet = useCallback(async (id: string) => {
    try {
      setFull(await api<FullSet>(`/api/host/sets/${id}`));
      const u = new URL(location.href);
      u.searchParams.set('set', id);
      history.replaceState(null, '', u);
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  }, []);

  useEffect(() => {
    loadList()
      .then(() => {
        setAuth('yes');
        const id = new URLSearchParams(location.search).get('set');
        if (id) loadSet(id);
      })
      .catch((e: ApiError) => setAuth(e.status === 401 ? 'no' : 'yes'));
  }, [loadList, loadSet]);

  const refresh = async () => {
    await loadList();
    if (full) await loadSet(full.id);
  };

  const create = async () => {
    setMsg(null);
    try {
      const r = await api<{ id: string }>('/api/host/sets', { body: { title: newTitle } });
      setNewTitle('');
      await loadList();
      await loadSet(r.id);
      setMsg({ ok: true, text: '새 세트를 만들었습니다. 아래에서 사진과 정답을 넣으세요.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  };

  if (auth === 'loading') return <div className="h-wrap">불러오는 중…</div>;
  if (auth === 'no') return <HostLogin onOk={() => location.reload()} />;
  if (solo && full) return <Solo set={full} order={solo.order} timer={solo.timer} onExit={() => setSolo(null)} />;

  const mine = sets.filter((s) => s.editable);
  const builtIn = sets.filter((s) => !s.editable);
  return (
    <div className="h-wrap">
      <header className="h-head">
        <a className="h-btn small" href="/host">← 진행자 화면</a>
        <h1>문제세트</h1>
      </header>
      {msg && <p className={msg.ok ? 'h-ok' : 'h-err'}>{msg.text}</p>}

      <section className="h-card">
        <h2>내 세트</h2>
        <div className="s-tabs">
          {mine.map((s) => (
            <button key={s.id} className={'h-btn' + (full?.id === s.id ? ' primary' : '')} onClick={() => loadSet(s.id)}>
              {s.title} <small>· {s.count}문제</small>
            </button>
          ))}
          {mine.length === 0 && <span className="h-hint">아직 만든 세트가 없습니다.</span>}
        </div>
        <div className="h-row">
          <input className="h-input" value={newTitle} maxLength={40} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && newTitle.trim() && create()} placeholder="새 세트 이름 (예: 축제 본행사)" />
          <button className="h-btn primary" disabled={!newTitle.trim()} onClick={create}>＋ 새 세트 만들기</button>
        </div>
        {builtIn.length > 0 && (
          <div className="s-tabs">
            <span className="h-hint">기본 예시(수정 불가):</span>
            {builtIn.map((s) => (
              <button key={s.id} className={'h-btn small' + (full?.id === s.id ? ' primary' : '')} onClick={() => loadSet(s.id)}>
                {s.title} · {s.count}
              </button>
            ))}
          </div>
        )}
      </section>

      {full && (
        <SetDetail
          key={full.id}
          set={full}
          onChanged={refresh}
          onDeleted={async () => {
            setFull(null);
            history.replaceState(null, '', '/host/sets');
            await loadList();
          }}
          onSolo={(order, timer) => setSolo({ order, timer })}
        />
      )}
    </div>
  );
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** 사진을 전광판용으로 줄인다: 긴 변 1600px, WebP(안 되면 JPEG). GIF 는 움직임 유지를 위해 그대로 */
async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  if (!file.type.startsWith('image/')) throw new Error('사진 파일만 올릴 수 있습니다.');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff'; // 투명 PNG 를 JPEG 로 바꿀 때 검게 되지 않도록
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const enc = (type: string, q: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    let b = await enc('image/webp', q);
    if (!b || b.type !== 'image/webp') b = await enc('image/jpeg', q);
    if (b && b.size <= 1_800_000) return b;
  }
  throw new Error('사진을 1.8MB 이하로 줄이지 못했습니다. 더 작은 사진을 써 주세요.');
}

async function uploadImage(file: File): Promise<string> {
  const blob = await prepareImage(file);
  const res = await fetch('/api/host/media', {
    method: 'POST',
    headers: { 'content-type': blob.type, 'x-quiz': '1' },
    body: blob,
    credentials: 'same-origin',
  });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(d?.message ?? `올리기 실패 (${res.status})`);
  return d.id as string;
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

interface Draft {
  qid: string | null;
  imageId: string;
  imageUrl: string;
  answerDisplay: string;
  accepted: string;
  prompt: string;
  explanation: string;
  timeLimitSec: number;
  ignoreSpaces: boolean;
  caseInsensitive: boolean;
  decoys: string;
}
const emptyDraft = (): Draft => ({ qid: null, imageId: '', imageUrl: '', answerDisplay: '', accepted: '', prompt: '', explanation: '', timeLimitSec: 20, ignoreSpaces: true, caseInsensitive: true, decoys: '' });

function QuestionEditor({ setId, draft, setDraft, onSaved }: { setId: string; draft: Draft; setDraft: (d: Draft) => void; onSaved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);

  const takeFile = async (f: File | null | undefined) => {
    if (!f) return;
    setErr('');
    setBusy('사진 올리는 중…');
    try {
      const id = await uploadImage(f);
      setDraft({ ...draft, imageId: id, imageUrl: `/api/media/${id}` });
      setTimeout(() => answerRef.current?.focus(), 0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // 클립보드 사진 붙여넣기(Ctrl+V)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) {
        e.preventDefault();
        takeFile(f);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const save = async () => {
    setErr('');
    setBusy('저장 중…');
    try {
      const body = {
        imageId: draft.imageId,
        answerDisplay: draft.answerDisplay,
        accepted: lines(draft.accepted),
        prompt: draft.prompt,
        explanation: draft.explanation,
        timeLimitSec: draft.timeLimitSec,
        rules: { ignoreSpaces: draft.ignoreSpaces, caseInsensitive: draft.caseInsensitive },
        decoys: lines(draft.decoys),
      };
      const path = draft.qid ? `/api/host/sets/${setId}/questions/${draft.qid}` : `/api/host/sets/${setId}/questions`;
      await api(path, { body });
      setDraft(emptyDraft());
      onSaved();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const can = draft.imageId && draft.answerDisplay.trim() && !busy;
  return (
    <section className="h-card">
      <h2>{draft.qid ? '문제 고치기' : '문제 추가'}</h2>
      <div className="q-editor">
        <div
          className={'q-drop' + (drag ? ' over' : '')}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            takeFile(e.dataTransfer.files[0]);
          }}
        >
          {draft.imageUrl ? <img src={draft.imageUrl} alt="문제 사진" /> : <span>사진을 끌어다 놓거나<br />눌러서 고르세요<br /><small>(Ctrl+V 붙여넣기도 됩니다)</small></span>}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => takeFile(e.target.files?.[0])} />
        </div>
        <div className="q-fields">
          <label>정답 (전광판에 공개) *
            <input ref={answerRef} className="h-input" value={draft.answerDisplay} maxLength={30} onChange={(e) => setDraft({ ...draft, answerDisplay: e.target.value })} placeholder="예: 엄마손파이" />
          </label>
          <label>함께 인정할 답 (한 줄에 하나)
            <textarea className="h-input" rows={3} value={draft.accepted} onChange={(e) => setDraft({ ...draft, accepted: e.target.value })} placeholder={'예:\n엄마 손 파이\n엄마손'} />
          </label>
          <div className="h-row">
            <label className="h-check"><input type="checkbox" checked={draft.ignoreSpaces} onChange={(e) => setDraft({ ...draft, ignoreSpaces: e.target.checked })} /> 띄어쓰기 무시</label>
            <label className="h-check"><input type="checkbox" checked={draft.caseInsensitive} onChange={(e) => setDraft({ ...draft, caseInsensitive: e.target.checked })} /> 영문 대소문자 무시</label>
            <label className="h-check">제한시간
              <input className="h-input tiny" type="number" min={5} max={300} value={draft.timeLimitSec} onChange={(e) => setDraft({ ...draft, timeLimitSec: Number(e.target.value) })} />초
            </label>
          </div>
          <details>
            <summary>선택 항목 (질문 글 · 해설 · 봇용 오답 예시)</summary>
            <label>질문 글 (비워 두면 사진만 나옵니다)
              <input className="h-input" value={draft.prompt} maxLength={80} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="예: 이 과자의 이름은?" />
            </label>
            <label>해설 (정답 공개 때 보임)
              <input className="h-input" value={draft.explanation} maxLength={300} onChange={(e) => setDraft({ ...draft, explanation: e.target.value })} />
            </label>
            <label>연습용 봇이 낼 오답 예시 (한 줄에 하나, 채점에는 안 씀)
              <textarea className="h-input" rows={2} value={draft.decoys} onChange={(e) => setDraft({ ...draft, decoys: e.target.value })} />
            </label>
          </details>
          {err && <p className="h-err">{err}</p>}
          <div className="h-actions">
            <button className="h-btn primary" disabled={!can} onClick={save}>{busy ?? (draft.qid ? '고친 내용 저장' : '＋ 이 문제 추가')}</button>
            {(draft.qid || draft.imageId) && <button className="h-btn" disabled={!!busy} onClick={() => setDraft(emptyDraft())}>취소</button>}
          </div>
          <p className="h-hint">채점: 유니코드 정규화·앞뒤 공백 제거 후, 위 규칙으로 정답·인정 답과 정확히 같을 때만 정답입니다. 놓친 표기는 행사 중 진행자 화면의 "정답 인정"으로 추가할 수 있습니다.</p>
        </div>
      </div>
    </section>
  );
}

function SetDetail({ set, onChanged, onDeleted, onSolo }: { set: FullSet; onChanged: () => void; onDeleted: () => void; onSolo: (order: Q[], timer: number) => void }) {
  const [timer, setTimer] = useState(0); // 0 = 없음, -1 = 문제별 제한시간
  const [mix, setMix] = useState(false);
  const [count, setCount] = useState(set.questions.length);
  const [show, setShow] = useState(set.editable);
  const [title, setTitle] = useState(set.title);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [err, setErr] = useState('');
  useEffect(() => setCount(set.questions.length), [set.questions.length]);

  const call = async (path: string, body: unknown = {}) => {
    setErr('');
    try {
      await api(path, { body });
      onChanged();
      return true;
    } catch (e) {
      setErr((e as ApiError).message);
      return false;
    }
  };
  const move = (i: number, d: number) => {
    const ids = set.questions.map((q) => q.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    call(`/api/host/sets/${set.id}/order`, { qids: ids });
  };
  const edit = (q: Q) => {
    setDraft({
      qid: q.id,
      imageId: q.image.split('/').pop() ?? '',
      imageUrl: q.image,
      answerDisplay: q.answerDisplay,
      accepted: q.accepted.filter((a) => a !== q.answerDisplay).join('\n'),
      prompt: q.prompt,
      explanation: q.explanation,
      timeLimitSec: q.timeLimitSec,
      ignoreSpaces: q.rules.ignoreSpaces,
      caseInsensitive: q.rules.caseInsensitive,
      decoys: (q.decoys ?? []).join('\n'),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      {set.editable && (
        <section className="h-card">
          <div className="h-row">
            <input className="h-input" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} aria-label="세트 이름" />
            <button className="h-btn" disabled={!title.trim() || title === set.title} onClick={() => call(`/api/host/sets/${set.id}`, { title })}>이름 저장</button>
            <button className="h-btn warn" onClick={async () => window.confirm(`'${set.title}' 세트를 지울까요? (이미 만든 행사에는 영향 없음)`) && (await call(`/api/host/sets/${set.id}/delete`)) && onDeleted()}>세트 삭제</button>
          </div>
          <p className="h-hint">행사를 만들 때 그 순간의 세트 내용이 행사에 복사됩니다. 세트를 고쳐도 이미 만든 행사는 바뀌지 않으니, 고친 뒤에는 새 행사를 만드세요.</p>
        </section>
      )}
      {set.editable && <QuestionEditor setId={set.id} draft={draft} setDraft={setDraft} onSaved={onChanged} />}

      {set.questions.length > 0 && (
        <section className="h-card">
          <h2>혼자 풀기 — {set.title}</h2>
          <div className="h-row">
            <label className="h-check">타이머
              <select className="h-input short" value={timer} onChange={(e) => setTimer(Number(e.target.value))}>
                <option value={0}>없음</option>
                <option value={-1}>문제별 제한시간</option>
                <option value={5}>5초</option>
                <option value={10}>10초</option>
                <option value={30}>30초</option>
              </select>
            </label>
            <label className="h-check">문항 수
              <input className="h-input tiny" type="number" min={1} max={set.questions.length} value={count} onChange={(e) => setCount(Math.max(1, Math.min(set.questions.length, Number(e.target.value) || 1)))} />
            </label>
            <label className="h-check"><input type="checkbox" checked={mix} onChange={(e) => setMix(e.target.checked)} /> 순서 섞기</label>
            <button className="h-btn primary" onClick={() => onSolo((mix ? shuffle(set.questions) : set.questions).slice(0, count), timer)}>▶ 혼자 풀기 시작</button>
          </div>
          <p className="h-hint">실제 행사와 같은 서버 채점 규칙을 씁니다. 기록은 저장하지 않습니다.</p>
        </section>
      )}

      <section className="h-card">
        <div className="h-row">
          <h2 style={{ flex: 1 }}>문제 ({set.questions.length})</h2>
          <label className="h-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> 정답 보기</label>
        </div>
        {err && <p className="h-err">{err}</p>}
        {set.questions.length === 0 && <p className="h-hint">아직 문제가 없습니다. 위에서 사진과 정답을 넣어 추가하세요.</p>}
        <div className="s-grid">
          {set.questions.map((q, i) => (
            <article key={q.id} className={'s-card' + (draft.qid === q.id ? ' editing' : '')}>
              <img src={q.image} alt={q.imageAlt} loading="lazy" />
              <div className="s-body">
                <div className="s-no">{i + 1}번 · {q.timeLimitSec}초</div>
                {q.prompt && <div className="s-prompt">{q.prompt}</div>}
                {show ? (
                  <>
                    <div className="s-ans">정답 <b>{q.answerDisplay}</b></div>
                    {q.accepted.length > 1 && <div className="s-meta">인정: {q.accepted.join(', ')}</div>}
                    <div className="s-meta">띄어쓰기 {q.rules.ignoreSpaces ? '무시' : '구분'} · 대소문자 {q.rules.caseInsensitive ? '무시' : '구분'}</div>
                    {q.explanation && <div className="s-exp">{q.explanation}</div>}
                  </>
                ) : (
                  <div className="s-meta">정답 가림</div>
                )}
                {set.editable && (
                  <div className="s-tools">
                    <button className="h-btn small" disabled={i === 0} onClick={() => move(i, -1)} title="앞으로">↑</button>
                    <button className="h-btn small" disabled={i === set.questions.length - 1} onClick={() => move(i, 1)} title="뒤로">↓</button>
                    <button className="h-btn small" onClick={() => edit(q)}>수정</button>
                    <button className="h-btn small warn" onClick={() => window.confirm(`${i + 1}번 문제를 지울까요?`) && call(`/api/host/sets/${set.id}/questions/${q.id}/delete`)}>삭제</button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function Solo({ set, order, timer, onExit }: { set: FullSet; order: Q[]; timer: number; onExit: () => void }) {
  const [i, setI] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<(Check & { timeout?: boolean; skipped?: boolean }) | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const q = order[i];
  const limit = timer === -1 ? q?.timeLimitSec : timer;

  // 문제마다 타이머 시작
  useEffect(() => {
    if (!q || check) return;
    inputRef.current?.focus();
    if (!limit) {
      setLeft(null);
      return;
    }
    const ends = Date.now() + limit * 1000;
    setLeft(limit);
    const id = setInterval(() => {
      const s = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [i, q, limit, check]);

  const grade = useCallback(
    async (value: string, how: 'submit' | 'timeout' | 'skip') => {
      if (!q || busy || check) return;
      setBusy(true);
      try {
        // '모르겠어요'는 채점 없이 오답 처리. 그 밖에는 서버 채점(행사와 같은 규칙)
        const r: Check =
          how === 'skip'
            ? { correct: false, text: '', answerDisplay: q.answerDisplay, explanation: q.explanation }
            : await api<Check>('/api/host/check', { body: { set: set.id, qid: q.id, text: value } });
        setCheck({ ...r, timeout: how === 'timeout', skipped: how === 'skip' });
        setResults((rs) => [...rs, { q, text: r.text, correct: r.correct, timeout: how === 'timeout', skipped: how === 'skip' }]);
        setTimeout(() => nextRef.current?.focus(), 0);
      } catch (e) {
        alert((e as ApiError).message);
      } finally {
        setBusy(false);
      }
    },
    [q, busy, check],
  );

  // 시간 초과 → 그때까지 입력한 답으로 채점
  useEffect(() => {
    if (left === 0 && !check) grade(text, 'timeout');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const next = () => {
    setCheck(null);
    setText('');
    setI((x) => x + 1);
  };

  // 결과가 보이는 동안에는 어디서든 Enter → 다음 문제 (버튼 포커스에 의존하지 않음)
  useEffect(() => {
    if (!check) return;
    const onDoc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
      e.preventDefault();
      next();
    };
    // 답을 낸 Enter(또는 누르고 있는 Enter)가 결과를 바로 넘기지 않도록 0.6초 뒤부터 받는다
    const t = setTimeout(() => document.addEventListener('keydown', onDoc), 600);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onDoc);
    };
  }, [check]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 무시
    e.preventDefault();
    if (text.trim()) grade(text, 'submit');
  };

  if (!q) {
    const score = results.filter((r) => r.correct).length;
    const wrong = results.filter((r) => !r.correct);
    return (
      <div className="h-wrap narrow solo">
        <h1>결과 — {set.title}</h1>
        <div className="solo-score">
          {score} <small>/ {results.length}</small>
        </div>
        <p className="h-hint">{score === results.length ? '모두 맞혔습니다!' : `틀린 문제 ${wrong.length}개`}</p>
        {wrong.map((r) => (
          <div key={r.q.id} className="solo-wrong">
            <img src={r.q.image} alt="" />
            <div>
              {r.q.prompt && <div className="s-prompt">{r.q.prompt}</div>}
              <div className="s-meta">
                내 답: {r.skipped ? '(건너뜀)' : r.text || '(없음)'} {r.timeout && '· 시간 초과'}
              </div>
              <div className="s-ans">정답 <b>{r.q.answerDisplay}</b></div>
            </div>
          </div>
        ))}
        <div className="h-actions">
          <button className="h-btn primary" onClick={() => { setResults([]); setI(0); setCheck(null); setText(''); }}>다시 풀기</button>
          <button className="h-btn" onClick={onExit}>세트로 돌아가기</button>
        </div>
      </div>
    );
  }

  return (
    <div className="solo">
      <header className="solo-top">
        <button className="h-btn small" onClick={() => (results.length === 0 || confirm('그만 풀고 세트로 돌아갈까요?')) && onExit()}>✕ 그만</button>
        <div className="solo-progress">
          <span>{i + 1} / {order.length}</span>
          <div className="solo-bar"><div style={{ width: `${(i / order.length) * 100}%` }} /></div>
        </div>
        <div className={'solo-timer' + (left !== null && left <= 3 ? ' hurry' : '')}>{left === null ? '' : `${left}초`}</div>
      </header>
      <main className="solo-main">
        <img className="solo-img" src={q.image} alt={q.imageAlt} />
        {q.prompt && <div className="solo-prompt">{q.prompt}</div>}
        {!check ? (
          <div className="solo-input">
            <input ref={inputRef} className="p-input answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="정답을 입력하세요" autoComplete="off" spellCheck={false} maxLength={40} />
            <div className="h-actions">
              <button className="h-btn primary" disabled={busy || !text.trim()} onClick={() => grade(text, 'submit')}>제출 (Enter)</button>
              <button className="h-btn" disabled={busy} onClick={() => grade(text, 'skip')}>모르겠어요</button>
            </div>
          </div>
        ) : (
          <div className={'solo-result ' + (check.correct ? 'ok' : 'no')}>
            <div className="solo-verdict">{check.correct ? '정답!' : check.timeout ? '시간 초과' : check.skipped ? '건너뜀' : '아쉬워요'}</div>
            {check.text && <div className="s-meta">내 답: “{check.text}”</div>}
            <div className="solo-answer">정답 <b>{check.answerDisplay}</b></div>
            {check.explanation && <div className="s-exp">{check.explanation}</div>}
            <button ref={nextRef} className="h-btn primary" onClick={(e) => { e.preventDefault(); next(); }}>{i + 1 < order.length ? '다음 문제 (Enter)' : '결과 보기'}</button>
          </div>
        )}
      </main>
    </div>
  );
}

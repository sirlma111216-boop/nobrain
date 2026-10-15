// 문제 보관함 — 진행자가 화면에서 만든 문제세트·문제·사진을 저장하는 Durable Object (전체에 하나: 'library').
// 사진은 SQLite BLOB 으로 저장한다(행 하나 최대 2MB 제한 → 업로드는 1.9MB 이하, 화면에서 미리 줄여 올린다).
// 행사를 만들 때 세트의 복사본이 행사 Object 로 넘어가므로, 여기서 고치거나 지워도 이미 만든 행사는 바뀌지 않는다.

import { DurableObject } from 'cloudflare:workers';
import type { Question } from './quiz/bank';
import type { QuestionInput } from './quiz/validate';

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE questions (id TEXT PRIMARY KEY, set_id TEXT NOT NULL, pos INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX questions_set_pos ON questions(set_id, pos)`,
    `CREATE TABLE media (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  ],
];

export const MAX_MEDIA_BYTES = 1_900_000;
export const MAX_SET_QUESTIONS = 300;
const MAX_SETS = 200;

export interface SetSummary {
  id: string;
  title: string;
  count: number;
  updatedAt: number;
}

const rid = (prefix: string) => {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(a, (b) => (b % 36).toString(36)).join('');
};

export class LibraryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS _schema (v INTEGER NOT NULL)`);
      const cur = this.sql.exec<{ v: number }>(`SELECT v FROM _schema`).toArray()[0]?.v ?? 0;
      if (cur >= MIGRATIONS.length) return;
      ctx.storage.transactionSync(() => {
        for (let i = cur; i < MIGRATIONS.length; i++) for (const s of MIGRATIONS[i]) this.sql.exec(s);
        this.sql.exec(`DELETE FROM _schema`);
        this.sql.exec(`INSERT INTO _schema (v) VALUES (?)`, MIGRATIONS.length);
      });
    });
  }

  listSets(): SetSummary[] {
    return this.sql
      .exec<{ id: string; title: string; count: number; updated_at: number }>(
        `SELECT s.id, s.title, s.updated_at, (SELECT COUNT(*) FROM questions q WHERE q.set_id = s.id) AS count
         FROM sets s ORDER BY s.created_at`,
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, count: r.count, updatedAt: r.updated_at }));
  }

  createSet(title: string): { ok: true; id: string } | { ok: false; message: string } {
    const n = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM sets`).one().c;
    if (n >= MAX_SETS) return { ok: false, message: `세트는 ${MAX_SETS}개까지 만들 수 있습니다.` };
    const id = rid('lib-');
    const now = Date.now();
    this.sql.exec(`INSERT INTO sets (id, title, created_at, updated_at) VALUES (?,?,?,?)`, id, title, now, now);
    return { ok: true, id };
  }

  private touch(setId: string): boolean {
    return this.sql.exec(`UPDATE sets SET updated_at=? WHERE id=?`, Date.now(), setId).rowsWritten > 0;
  }

  renameSet(id: string, title: string): boolean {
    return this.sql.exec(`UPDATE sets SET title=?, updated_at=? WHERE id=?`, title, Date.now(), id).rowsWritten > 0;
  }

  /** 세트와 문제를 지운다. 사진은 이미 만든 행사가 쓰고 있을 수 있어 지우지 않는다. */
  deleteSet(id: string): boolean {
    let ok = false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM questions WHERE set_id=?`, id);
      ok = this.sql.exec(`DELETE FROM sets WHERE id=?`, id).rowsWritten > 0;
    });
    return ok;
  }

  getSet(id: string): { id: string; title: string; questions: Question[] } | null {
    const s = this.sql.exec<{ id: string; title: string }>(`SELECT id, title FROM sets WHERE id=?`, id).toArray()[0];
    if (!s) return null;
    const questions = this.sql
      .exec<{ data: string }>(`SELECT data FROM questions WHERE set_id=? ORDER BY pos, id`, id)
      .toArray()
      .map((r) => JSON.parse(r.data) as Question);
    return { id: s.id, title: s.title, questions };
  }

  /** 문제 추가(qid 없음) 또는 수정 */
  saveQuestion(setId: string, qid: string | null, input: QuestionInput): { ok: true; question: Question } | { ok: false; message: string } {
    if (!this.sql.exec(`SELECT 1 FROM sets WHERE id=?`, setId).toArray().length) return { ok: false, message: '세트를 찾을 수 없습니다.' };
    if (!this.sql.exec(`SELECT 1 FROM media WHERE id=?`, input.imageId).toArray().length) return { ok: false, message: '사진을 다시 올려 주세요.' };
    const id = qid ?? rid('lq-');
    const question: Question = {
      id,
      prompt: input.prompt,
      image: `/api/media/${input.imageId}`,
      imageAlt: input.prompt || '문제 사진',
      timeLimitSec: input.timeLimitSec,
      answerDisplay: input.answerDisplay,
      accepted: input.accepted,
      explanation: input.explanation,
      rules: input.rules,
      decoys: input.decoys,
    };
    const now = Date.now();
    if (qid) {
      const w = this.sql.exec(`UPDATE questions SET data=?, updated_at=? WHERE id=? AND set_id=?`, JSON.stringify(question), now, qid, setId).rowsWritten;
      if (!w) return { ok: false, message: '문제를 찾을 수 없습니다.' };
    } else {
      const n = this.sql.exec<{ c: number; m: number | null }>(`SELECT COUNT(*) AS c, MAX(pos) AS m FROM questions WHERE set_id=?`, setId).one();
      if (n.c >= MAX_SET_QUESTIONS) return { ok: false, message: `한 세트에는 ${MAX_SET_QUESTIONS}문제까지 넣을 수 있습니다.` };
      this.sql.exec(`INSERT INTO questions (id, set_id, pos, data, updated_at) VALUES (?,?,?,?,?)`, id, setId, (n.m ?? 0) + 1, JSON.stringify(question), now);
    }
    this.touch(setId);
    return { ok: true, question };
  }

  deleteQuestion(setId: string, qid: string): boolean {
    const ok = this.sql.exec(`DELETE FROM questions WHERE id=? AND set_id=?`, qid, setId).rowsWritten > 0;
    if (ok) this.touch(setId);
    return ok;
  }

  /** 문제 순서 바꾸기. 목록에 없는 문제는 뒤로 보낸다 */
  reorder(setId: string, qids: string[]): boolean {
    if (!this.sql.exec(`SELECT 1 FROM sets WHERE id=?`, setId).toArray().length) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE questions SET pos = pos + 100000 WHERE set_id=?`, setId);
      qids.slice(0, MAX_SET_QUESTIONS).forEach((q, i) => this.sql.exec(`UPDATE questions SET pos=? WHERE id=? AND set_id=?`, i + 1, q, setId));
    });
    this.touch(setId);
    return true;
  }

  /** 사진 저장. 같은 사진은 한 번만 저장(내용 해시가 ID) */
  async putMedia(data: ArrayBuffer, type: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    if (data.byteLength > MAX_MEDIA_BYTES) return { ok: false, message: '사진이 너무 큽니다(1.9MB 이하).' };
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const id = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
    this.sql.exec(`INSERT OR IGNORE INTO media (id, type, data, size, created_at) VALUES (?,?,?,?,?)`, id, type, data, data.byteLength, Date.now());
    return { ok: true, id };
  }

  getMedia(id: string): { type: string; data: ArrayBuffer } | null {
    const r = this.sql.exec<{ type: string; data: ArrayBuffer }>(`SELECT type, data FROM media WHERE id=?`, id).toArray()[0];
    return r ? { type: r.type, data: r.data } : null;
  }
}

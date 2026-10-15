#!/usr/bin/env node
// 문제세트 가져오기: 폴더 하나(questions.csv + 그림 파일)를 새 문제세트로 만든다.
//
//   node tools/import-set.mjs --dir quiz-sets/festival --id festival --title "축제 본행사"
//
// questions.csv (UTF-8, 첫 줄은 머리글. 엑셀에서 "CSV UTF-8" 로 저장):
//   번호,질문,그림,대표정답,인정답안,해설,제한시간,띄어쓰기무시,대소문자무시,오답예시
//   1,몇 시일까요?,01.png,3시,3시|세시|세 시|3:00,짧은 바늘이 3을 가리켜요.,20,Y,Y,4시|9시
// - 인정답안·오답예시는 | 로 구분. 대표정답은 인정답안에 없으면 자동으로 넣는다.
// - 제한시간 기본 20초, 띄어쓰기무시·대소문자무시 기본 Y.
// - 오답예시는 연습용 봇이 낼 흔한 오답(선택). 채점에는 쓰지 않는다.
//
// 결과: public/media/<id>/ 에 그림 복사(파일 이름은 무작위 해시 — 정답이 드러나지 않음),
//       worker/quiz/sets/<id>.ts 생성, worker/quiz/sets/imported.ts 갱신.
// 다음: npm run test:unit (정답 유출 검사) → npm run build → npm run deploy:test

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const fail = (m) => {
  console.error('오류: ' + m);
  process.exit(1);
};
/** imported.ts 다시 만들기: '@import-set' 표시가 있는 세트 파일 전부 */
function rebuildRegistry() {
  const sets = readdirSync('worker/quiz/sets')
    .filter((f) => f.endsWith('.ts') && f !== 'imported.ts')
    .filter((f) => readFileSync(join('worker/quiz/sets', f), 'utf8').startsWith('// @import-set'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
  const v = (s) => 'SET_' + s.replace(/-/g, '_').toUpperCase();
  const lines = [
    '// tools/import-set.mjs 가 다시 만드는 파일입니다. 직접 고치지 마세요.',
    "import type { QuestionSet } from '../bank';",
    ...sets.map((s) => `import { ${v(s)} } from './${s}';`),
    '',
    `export const IMPORTED_SETS: QuestionSet[] = [${sets.map(v).join(', ')}];`,
    '',
  ];
  writeFileSync('worker/quiz/sets/imported.ts', lines.join('\n'));
}

// 세트 지우기: node tools/import-set.mjs --remove <id>
if (args.remove) {
  const rid = args.remove;
  const f = `worker/quiz/sets/${rid}.ts`;
  if (!existsSync(f) || !readFileSync(f, 'utf8').startsWith('// @import-set')) fail('가져온 세트가 아닙니다: ' + rid);
  rmSync(f);
  rmSync(`public/media/${rid}`, { recursive: true, force: true });
  rebuildRegistry();
  console.log(`세트 '${rid}' 를 지웠습니다. (이 세트로 이미 만든 행사는 문제를 찾지 못합니다)`);
  process.exit(0);
}

const dir = args.dir;
const id = args.id;
const title = args.title ?? id;
if (!dir || !id) fail('--dir 과 --id 가 필요합니다. 예: --dir quiz-sets/festival --id festival --title "축제 본행사"');
if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) fail('--id 는 영문 소문자로 시작하는 영문·숫자·- (2~31자)');
if (['basic', 'set1', 'imported', 'bank'].includes(id)) fail(`'${id}' 는 쓸 수 없는 ID 입니다.`);
const csvPath = join(dir, 'questions.csv');
if (!existsSync(csvPath)) fail(csvPath + ' 이 없습니다.');

/** 따옴표를 지원하는 CSV 파서 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const raw = readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const [head, ...rows] = parseCsv(raw);
const col = (name) => head.findIndex((h) => h.trim() === name);
const C = Object.fromEntries(['번호', '질문', '그림', '대표정답', '인정답안', '해설', '제한시간', '띄어쓰기무시', '대소문자무시', '오답예시'].map((n) => [n, col(n)]));
for (const need of ['질문', '그림', '대표정답']) if (C[need] < 0) fail(`머리글에 '${need}' 열이 없습니다. (머리글: ${head.join(',')})`);
const get = (r, n) => (C[n] >= 0 ? (r[C[n]] ?? '').trim() : '');
const yes = (v, d) => (v === '' ? d : /^(y|yes|o|예|네|1|true)$/i.test(v));
const list = (v) => v.split('|').map((x) => x.trim()).filter(Boolean);

const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
const mediaDir = `public/media/${id}`;
if (existsSync(mediaDir)) rmSync(mediaDir, { recursive: true });
mkdirSync(mediaDir, { recursive: true });

const problems = [];
const questions = rows.map((r, i) => {
  const n = i + 1;
  const prompt = get(r, '질문');
  const img = get(r, '그림');
  const display = get(r, '대표정답');
  if (!prompt || !img || !display) problems.push(`${n}번: 질문·그림·대표정답 중 빈 칸`);
  const src = join(dir, img);
  const ext = extname(img).toLowerCase();
  let image = '';
  if (!existsSync(src)) problems.push(`${n}번: 그림 파일 없음 (${img})`);
  else if (!OK_EXT.has(ext)) problems.push(`${n}번: 지원하지 않는 그림 형식 (${ext})`);
  else {
    const buf = readFileSync(src);
    const file = createHash('sha256').update(id + ':' + n + ':').update(buf).digest('hex').slice(0, 10) + ext;
    copyFileSync(src, join(mediaDir, file));
    image = `/media/${id}/${file}`;
    const mb = statSync(src).size / 2 ** 20;
    if (mb > 1.5) console.warn(`주의: ${n}번 그림이 ${mb.toFixed(1)}MB 입니다. 휴대폰이 아니라 전광판에서만 보이지만, 1MB 이하(WebP 권장)로 줄이면 전환이 빨라집니다.`);
  }
  const accepted = list(get(r, '인정답안'));
  if (display && !accepted.includes(display)) accepted.unshift(display);
  const sec = Number(get(r, '제한시간') || 20);
  if (!Number.isInteger(sec) || sec < 5 || sec > 300) problems.push(`${n}번: 제한시간은 5~300초`);
  return {
    id: `${id}-q${String(n).padStart(2, '0')}`,
    prompt,
    image,
    imageAlt: `${n}번 문제 그림`,
    timeLimitSec: sec,
    answerDisplay: display,
    accepted,
    explanation: get(r, '해설'),
    rules: { ignoreSpaces: yes(get(r, '띄어쓰기무시'), true), caseInsensitive: yes(get(r, '대소문자무시'), true) },
    decoys: list(get(r, '오답예시')),
  };
});
if (!questions.length) problems.push('문제가 한 줄도 없습니다.');
if (problems.length) {
  rmSync(mediaDir, { recursive: true, force: true });
  fail('\n  ' + problems.join('\n  '));
}

const varName = 'SET_' + id.replace(/-/g, '_').toUpperCase();
writeFileSync(
  `worker/quiz/sets/${id}.ts`,
  `// @import-set — tools/import-set.mjs 가 ${dir}/questions.csv 로 만든 파일입니다. 고치려면 CSV 를 고친 뒤 다시 가져오세요.
// 서버 전용: src/ 에서 import 하지 않는다.
import type { QuestionSet } from '../bank';

export const ${varName}: QuestionSet = {
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  questions: ${JSON.stringify(questions, null, 2).replace(/\n/g, '\n  ')},
};
`,
);

rebuildRegistry();
console.log(`'${title}' (${id}) ${questions.length}문항을 가져왔습니다.`);
console.log(`  그림: ${mediaDir}/  ·  데이터: worker/quiz/sets/${id}.ts`);
console.log('다음: npm run test:unit → npm run build → (배포) npm run deploy:test');

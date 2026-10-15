#!/usr/bin/env node
// 문제세트 1 (리허설용 20문항) — 그림을 직접 SVG 로 그려 public/media/ 에 쓰고, worker/quiz/sets/set1.ts 를 만든다.
// 외부 그림을 쓰지 않는다. 실제 축제 사진이 준비되면 tools/import-set.mjs 로 새 세트를 만들면 된다.
//
//   node tools/make-set1.mjs
//
// 그림 파일 이름은 문제 ID 의 해시라 정답을 드러내지 않는다.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const W = 600;
const H = 340;
const INK = '#2b2d42';
const svg = (body, bg = '#f7f9ff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="문제 그림"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>\n`;
const text = (x, y, s, size = 64, fill = INK, w = 800) =>
  `<text x="${x}" y="${y}" font-family="Arial, 'Malgun Gothic', sans-serif" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${s}</text>`;

const star = (cx, cy, r, fill = '#ffd166') => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
};
const heart = (cx, cy, s) =>
  `<path transform="translate(${cx} ${cy}) scale(${s})" d="M0,12 C-18,-4 -30,-14 -30,-26 C-30,-38 -20,-44 -12,-44 C-6,-44 -2,-40 0,-36 C2,-40 6,-44 12,-44 C20,-44 30,-38 30,-26 C30,-14 18,-4 0,12 Z" fill="#ef476f" stroke="${INK}" stroke-width="2.5"/>`;
const apple = (cx, cy, s = 1) =>
  `<g transform="translate(${cx} ${cy}) scale(${s})"><path d="M0,-30 C-12,-42 -42,-36 -42,-6 C-42,22 -20,40 -6,36 C-2,35 2,35 6,36 C20,40 42,22 42,-6 C42,-36 12,-42 0,-30 Z" fill="#e63946" stroke="#7a1c25" stroke-width="3"/><path d="M0,-30 C1,-40 4,-46 9,-50" fill="none" stroke="#6b4226" stroke-width="4" stroke-linecap="round"/><path d="M6,-42 C14,-54 30,-52 32,-44 C22,-38 12,-38 6,-42 Z" fill="#2a9d8f"/></g>`;
const clock = (h, m) => {
  const cx = 300;
  const cy = 170;
  const R = 140;
  let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#fff" stroke="${INK}" stroke-width="12"/>`;
  for (let i = 1; i <= 12; i++) {
    const a = (i * Math.PI) / 6 - Math.PI / 2;
    s += text(cx + (R - 34) * Math.cos(a), cy + (R - 34) * Math.sin(a), String(i), 26, INK, 700);
  }
  const ma = (m / 60) * 2 * Math.PI - Math.PI / 2;
  const ha = (((h % 12) + m / 60) / 12) * 2 * Math.PI - Math.PI / 2;
  s += `<line x1="${cx}" y1="${cy}" x2="${(cx + 70 * Math.cos(ha)).toFixed(1)}" y2="${(cy + 70 * Math.sin(ha)).toFixed(1)}" stroke="#ef476f" stroke-width="14" stroke-linecap="round"/>`;
  s += `<line x1="${cx}" y1="${cy}" x2="${(cx + 84 * Math.cos(ma)).toFixed(1)}" y2="${(cy + 84 * Math.sin(ma)).toFixed(1)}" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>`;
  return s + `<circle cx="${cx}" cy="${cy}" r="10" fill="${INK}"/>`;
};
const polygon = (n, fill) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push(`${(300 + 130 * Math.cos(a)).toFixed(1)},${(178 + 130 * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>`;
};
const blob = (fill) => `<circle cx="300" cy="170" r="130" fill="${fill}" stroke="${INK}" stroke-width="6"/>`;
const sequence = (items) =>
  items
    .map((v, i) => {
      const x = 90 + i * 140;
      const q = v === '?';
      return `<rect x="${x - 55}" y="115" width="110" height="110" rx="16" fill="${q ? '#ffd166' : '#fff'}" stroke="${INK}" stroke-width="5"/>${text(x, 170, v, 60)}`;
    })
    .join('');
const dice = (n) => {
  const pos = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] }[n];
  return `<rect x="190" y="60" width="220" height="220" rx="34" fill="#fff" stroke="${INK}" stroke-width="10"/>` + pos.map(([dx, dy]) => `<circle cx="${300 + dx * 60}" cy="${170 + dy * 60}" r="22" fill="${INK}"/>`).join('');
};

const RULES = { ignoreSpaces: true, caseInsensitive: true };
const Q = [
  { prompt: '별은 몇 개일까요?', alt: '별 그림', body: [[110, 120], [250, 100], [400, 130], [180, 240], [340, 245]].map(([x, y]) => star(x, y, 48)).join(''), display: '5개', accepted: ['5', '5개', '다섯', '다섯개', '다섯 개'], explanation: '위에 3개, 아래에 2개 — 모두 5개예요.', decoys: ['4개', '6개'] },
  { prompt: '하트는 몇 개일까요?', alt: '하트 그림', body: [[90, 110], [210, 95], [330, 115], [450, 100], [140, 240], [290, 235], [430, 250]].map(([x, y]) => heart(x, y + 20, 1.5)).join(''), display: '7개', accepted: ['7', '7개', '일곱', '일곱개', '일곱 개'], explanation: '위에 4개, 아래에 3개 — 모두 7개예요.', decoys: ['6개', '8개'] },
  { prompt: '몇 시일까요?', alt: '시계', body: clock(9, 0), display: '9시', accepted: ['9시', '아홉시', '아홉 시', '9:00'], explanation: '짧은 바늘이 9, 긴 바늘이 12 — 정각 9시예요.', decoys: ['3시', '12시 45분'] },
  { prompt: '몇 시 몇 분일까요?', alt: '시계', body: clock(6, 30), display: '6시 30분', accepted: ['6시 30분', '6시 반', '여섯시 반', '여섯 시 반', '6:30', '여섯시 삼십분', '여섯 시 삼십 분'], explanation: '긴 바늘이 6을 가리키면 30분. 짧은 바늘은 6과 7 사이 — 6시 30분(6시 반)이에요.', decoys: ['7시 30분', '6시'] },
  { prompt: '이 도형의 이름은?', alt: '꼭짓점이 있는 도형', body: polygon(5, '#06d6a0'), display: '오각형', accepted: ['오각형', '5각형'], explanation: '변과 꼭짓점이 5개 — 오각형이에요.', decoys: ['육각형', '별'] },
  { prompt: '이 도형의 이름은?', alt: '꼭짓점이 있는 도형', body: polygon(6, '#118ab2'), display: '육각형', accepted: ['육각형', '6각형'], explanation: '변과 꼭짓점이 6개 — 육각형이에요. 벌집 모양!', decoys: ['오각형', '팔각형'] },
  { prompt: '무슨 색일까요?', alt: '색칠한 원', body: blob('#e63946'), display: '빨강', accepted: ['빨강', '빨간색', '빨강색', '빨간', '적색'], explanation: '빨강(빨간색)이에요.', decoys: ['주황', '분홍'] },
  { prompt: '무슨 색일까요?', alt: '색칠한 원', body: blob('#1d4ed8'), display: '파랑', accepted: ['파랑', '파란색', '파랑색', '파란', '청색'], explanation: '파랑(파란색)이에요.', decoys: ['남색', '보라'] },
  { prompt: '무슨 색일까요?', alt: '색칠한 원', body: blob('#2a9d4f'), display: '초록', accepted: ['초록', '초록색', '녹색'], explanation: '초록(녹색)이에요.', decoys: ['연두', '파랑'] },
  { prompt: '모두 몇 개일까요?', alt: '사과 덧셈 그림', body: apple(80, 170, 1) + apple(170, 170, 1) + text(240, 170, '+', 70) + apple(320, 170, 1) + apple(410, 170, 1) + apple(500, 170, 1), display: '5개', accepted: ['5', '5개', '다섯', '다섯개', '다섯 개'], explanation: '2개 + 3개 = 5개예요.', decoys: ['6개', '4개'] },
  { prompt: '? 에 들어갈 수는?', alt: '수 배열', body: sequence(['2', '4', '6', '?']), display: '8', accepted: ['8', '팔', '여덟'], explanation: '2씩 커져요: 2 → 4 → 6 → 8', decoys: ['10', '7'] },
  { prompt: '? 에 들어갈 수는?', alt: '수 배열', body: sequence(['1', '3', '5', '?']), display: '7', accepted: ['7', '칠', '일곱'], explanation: '홀수가 차례로 나와요: 1 → 3 → 5 → 7', decoys: ['6', '9'] },
  { prompt: '? 에 들어갈 수는?', alt: '수 배열', body: sequence(['3', '6', '9', '?']), display: '12', accepted: ['12', '십이', '열두'], explanation: '3씩 커져요: 3 → 6 → 9 → 12', decoys: ['11', '15'] },
  { prompt: '지금 신호는 무슨 뜻일까요?', alt: '신호등', body: `<rect x="215" y="40" width="170" height="260" rx="30" fill="#333"/><circle cx="300" cy="100" r="44" fill="#ff3b30"/><circle cx="300" cy="170" r="44" fill="#5a4a10"/><circle cx="300" cy="240" r="44" fill="#14401f"/>`, display: '멈춤', accepted: ['멈춤', '정지', '멈추시오', '서시오', '멈춰', '빨간불'], explanation: '빨간불은 멈추라는 신호예요.', decoys: ['출발', '조심'] },
  { prompt: '무지개는 몇 가지 색일까요?', alt: '무지개', body: ['#e63946', '#f77f00', '#ffd166', '#2a9d4f', '#1d4ed8', '#3a0ca3', '#7b2cbf'].map((c, i) => `<path d="M ${80 + i * 18} 300 A ${220 - i * 18} ${220 - i * 18} 0 0 1 ${520 - i * 18} 300" fill="none" stroke="${c}" stroke-width="18"/>`).join(''), display: '7가지', accepted: ['7', '7가지', '7개', '일곱', '일곱가지', '일곱 가지', '7색'], explanation: '빨주노초파남보 — 7가지 색이에요.', decoys: ['6가지', '5가지'] },
  { prompt: '주사위 눈은 몇일까요?', alt: '주사위', body: dice(4), display: '4', accepted: ['4', '넷', '사', '4개'], explanation: '점이 4개 — 4예요.', decoys: ['5', '3'] },
  { prompt: '가장 큰 원은 어느 것일까요?', alt: '크기가 다른 원 세 개', body: `<circle cx="120" cy="190" r="60" fill="#ffd166" stroke="${INK}" stroke-width="5"/><circle cx="300" cy="180" r="110" fill="#06d6a0" stroke="${INK}" stroke-width="5"/><circle cx="480" cy="190" r="80" fill="#118ab2" stroke="${INK}" stroke-width="5"/>${text(120, 190, '가', 50)}${text(300, 180, '나', 60)}${text(480, 190, '다', 54, '#fff')}`, display: '나', accepted: ['나', '나번', '(나)'], explanation: '가운데 "나"가 가장 커요.', decoys: ['다', '가'] },
  { prompt: '화살표는 어느 쪽을 가리킬까요?', alt: '화살표', body: `<path d="M 110 140 L 360 140 L 360 80 L 500 170 L 360 260 L 360 200 L 110 200 Z" fill="#ef476f" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>`, display: '오른쪽', accepted: ['오른쪽', '우측', '오른편', '동쪽'], explanation: '뾰족한 끝이 오른쪽을 향해요.', decoys: ['왼쪽', '위쪽'] },
  { prompt: '삼각형은 몇 개일까요?', alt: '도형 여러 개', body: [[100, 'tri'], [220, 'sq'], [330, 'tri'], [440, 'tri'], [540, 'circ']].map(([x, k], i) => (k === 'tri' ? `<polygon points="${x},${100 + (i % 2) * 40} ${x + 50},${200 + (i % 2) * 40} ${x - 50},${200 + (i % 2) * 40}" fill="#ffd166" stroke="${INK}" stroke-width="5"/>` : k === 'sq' ? `<rect x="${x - 45}" y="120" width="90" height="90" fill="#118ab2" stroke="${INK}" stroke-width="5"/>` : `<circle cx="${x}" cy="170" r="45" fill="#06d6a0" stroke="${INK}" stroke-width="5"/>`)).join('') + `<polygon points="220,240 260,310 180,310" fill="#ffd166" stroke="${INK}" stroke-width="5"/>`, display: '4개', accepted: ['4', '4개', '네개', '네 개', '넷'], explanation: '노란 삼각형이 위에 3개, 아래에 1개 — 모두 4개예요.', decoys: ['3개', '5개'] },
  { prompt: '이것은 무엇일까요?', alt: '밤하늘 그림', body: `<rect width="${W}" height="${H}" fill="#14213d"/><circle cx="300" cy="170" r="110" fill="#ffd166"/><circle cx="350" cy="140" r="100" fill="#14213d"/>${star(470, 90, 18, '#fff')}${star(130, 250, 14, '#fff')}${star(500, 260, 10, '#fff')}`, display: '달', accepted: ['달', '초승달', '그믐달'], explanation: '밤하늘에 뜬 초승달이에요.', decoys: ['바나나', '해'] },
];

mkdirSync('public/media/s1', { recursive: true });
const out = Q.map((q, i) => {
  const id = `s1-q${String(i + 1).padStart(2, '0')}`;
  const file = createHash('sha256').update('set1:' + id).digest('hex').slice(0, 8) + '.svg';
  writeFileSync(`public/media/s1/${file}`, svg(q.body));
  return {
    id,
    prompt: q.prompt,
    image: `/media/s1/${file}`,
    imageAlt: q.alt,
    timeLimitSec: 20,
    answerDisplay: q.display,
    accepted: q.accepted,
    explanation: q.explanation,
    rules: RULES,
    decoys: q.decoys,
  };
});
const ts = `// tools/make-set1.mjs 가 만든 파일입니다. 고치려면 그 스크립트를 고친 뒤 다시 실행하세요.
// 문제세트 1 — 리허설용 20문항(그림 직접 제작). 서버 전용: src/ 에서 import 하지 않는다.
import type { QuestionSet } from '../bank';

export const SET1: QuestionSet = {
  id: 'set1',
  title: '문제세트 1 (리허설 20문항)',
  questions: ${JSON.stringify(out, null, 2).replace(/\n/g, '\n  ')},
};
`;
writeFileSync('worker/quiz/sets/set1.ts', ts);
console.log(`문제세트 1: ${out.length}문항 → worker/quiz/sets/set1.ts, 그림 public/media/s1/`);

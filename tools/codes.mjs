#!/usr/bin/env node
// 참가 코드 생성·내보내기 도구 (진행자 API 를 그대로 사용)
//
//   node tools/codes.mjs --base http://127.0.0.1:8787 --students 480 --teachers 20
//   node tools/codes.mjs --base http://127.0.0.1:8787 --event AB12CD --export-only
//   node tools/codes.mjs --base http://127.0.0.1:8787 --load 1000          (부하 시험용 참가자)
//
// 진행자 비밀번호: HOST_PASSWORD 환경변수 또는 --password-file. 로컬 주소면 .dev.vars 를 읽는다.
// 결과 CSV 는 private/ (git 에서 제외됨) 에만 저장한다. 공개 폴더·저장소에 올리지 말 것.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Host, hostLogin } from '../loadtest/client.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const BASE = (args.base ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE);

function password() {
  if (process.env.HOST_PASSWORD) return process.env.HOST_PASSWORD;
  if (args['password-file']) return readFileSync(args['password-file'], 'utf8').trim();
  if (IS_LOCAL && existsSync('.dev.vars')) {
    const m = readFileSync('.dev.vars', 'utf8').match(/^HOST_PASSWORD=(.*)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('진행자 비밀번호가 필요합니다 (HOST_PASSWORD 또는 --password-file)');
}

const http = await hostLogin(BASE, password());
const host = args.event ? new Host(http, args.event.toUpperCase()) : await Host.create(http, args.title ?? '축제 퀴즈 (시험)');
if (args.event && (await host.refresh()).status !== 200) throw new Error('행사를 찾을 수 없습니다: ' + args.event);

if (args['export-only'] !== 'true') {
  const plan = [
    ['student', Number(args.students ?? (args.load ? 0 : 500))],
    ['teacher', Number(args.teachers ?? 0)],
    ['load', Number(args.load ?? 0)],
  ];
  for (const [kind, n] of plan) if (n > 0) await host.genCodes(n, kind);
}

const res = await http.get('/api/host/export/codes?event=' + host.event, { timeoutMs: 120000 });
if (res.status !== 200) throw new Error('내보내기 실패 ' + res.status);
mkdirSync('private', { recursive: true });
const file = `private/codes-${host.event}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
writeFileSync(file, res.text);
const lines = res.text.trim().split(/\r?\n/).length - 1;
console.log(`행사 코드: ${host.event}`);
console.log(`참가 코드 ${lines}개 → ${file}  (외부에 공유하지 마세요)`);

// E2E: 빌드 후 실제 `wrangler dev`(workerd)를 새 저장소 폴더로 띄우고, 테스트는 HTTP·WebSocket 으로만 접근한다.
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    base: string;
    password: string;
  }
}

const PORT = Number(process.env.E2E_PORT ?? 8790);
let child: ChildProcess | null = null;
let dir = '';

/**
 * 프로젝트 폴더(OneDrive 등 동기화 폴더일 수 있음)에서 wrangler dev 를 돌리면, 동기화가 감시 중인 파일을 건드릴 때마다
 * 서버가 다시 로드되어 모든 WebSocket 이 끊긴다(실측). 그래서 Worker 를 미리 번들하고 화면 파일과 함께
 * 임시 폴더로 옮겨, 그곳에서 서버를 띄운다. 설정은 wrangler.jsonc 최상위(로컬) 값을 그대로 쓴다.
 */
function prepareIsolatedApp(dir: string): string {
  const root = process.cwd();
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  execSync(`"${process.execPath}" "${wrangler}" deploy --dry-run --outdir "${join(dir, 'bundle')}"`, { stdio: 'ignore', cwd: root });
  cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
  // JSONC: 줄 전체가 주석인 줄만 지운다(문자열 안의 // 는 건드리지 않음)
  const raw = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\/ [^"\n]*$/gm, '');
  const cfg = JSON.parse(raw);
  delete cfg.$schema;
  delete cfg.env;
  cfg.main = 'bundle/index.js';
  const cfgPath = join(dir, 'wrangler.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

export default async function setup(project: TestProject) {
  execSync('npx vite build', { stdio: 'ignore' });
  dir = mkdtempSync(join(tmpdir(), 'quiz-e2e-'));
  const cfgPath = prepareIsolatedApp(dir);
  const password = 'e2e-' + randomBytes(12).toString('base64url');
  const envFile = join(dir, 'test.env');
  writeFileSync(envFile, `HOST_PASSWORD=${password}\nSESSION_SECRET=${randomBytes(32).toString('base64url')}\nDEV_MODE=1\n`);
  child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config', cfgPath,
      '--port', String(PORT),
      '--ip', '127.0.0.1',
      '--inspector-port', String(PORT + 1000),
      '--persist-to', join(dir, 'state'),
      '--env-file', envFile,
      '--show-interactive-dev-session=false',
      '--log-level', 'info',
    ],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  // 진단용: 서버 로그를 임시 폴더에 남긴다 (E2E_LOG 환경변수로 경로 지정 가능)
  const logFile = process.env.E2E_LOG ?? join(tmpdir(), 'quiz-e2e-wrangler.log');
  writeFileSync(logFile, '');
  const keep = (d: Buffer) => {
    log += d;
    try {
      appendFileSync(logFile, d);
    } catch {
      /* 무시 */
    }
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const base = `http://127.0.0.1:${PORT}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(base + '/api/host/session');
      if (r.status === 200) break;
    } catch {
      /* 아직 */
    }
    if (Date.now() - t0 > 90_000) throw new Error('wrangler dev 시작 실패\n' + log.slice(-3000));
    await new Promise((r) => setTimeout(r, 500));
  }
  // 비밀값 파일이 실제로 적용됐는지 확인(.dev.vars 가 우선되는 경우 대비)
  const r = await fetch(base + '/api/host/login', {
    method: 'POST',
    headers: { origin: base, 'x-quiz': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (r.status !== 200) throw new Error('테스트용 비밀값이 적용되지 않았습니다: ' + r.status);
  project.provide('base', base);
  project.provide('password', password);

  return async () => {
    if (child?.pid && process.platform !== 'win32') child.kill();
    else if (child?.pid) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        child.kill();
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 잠긴 파일은 남겨 둔다(임시 폴더) */
    }
  };
}

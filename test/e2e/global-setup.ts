// E2E: 빌드 후 실제 `wrangler dev`(workerd)를 새 저장소 폴더로 띄우고, 테스트는 HTTP·WebSocket 으로만 접근한다.
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

export default async function setup(project: TestProject) {
  execSync('npx vite build', { stdio: 'ignore' });
  dir = mkdtempSync(join(tmpdir(), 'quiz-e2e-'));
  const password = 'e2e-' + randomBytes(12).toString('base64url');
  const envFile = join(dir, 'test.env');
  writeFileSync(envFile, `HOST_PASSWORD=${password}\nSESSION_SECRET=${randomBytes(32).toString('base64url')}\nDEV_MODE=1\n`);
  child = spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--port', String(PORT),
      '--ip', '127.0.0.1',
      '--inspector-port', String(PORT + 1000),
      '--persist-to', join(dir, 'state'),
      '--env-file', envFile,
      '--show-interactive-dev-session=false',
      '--log-level', 'warn',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
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

/**
 * `npm run dev` — runs the game server (auto-restart on change) and the Vite
 * client dev server side by side. Vite proxies /ws and /api to the server.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [];

// Both processes are plain `node` invocations (no shell), so paths with
// spaces and every OS behave the same.
function run(name: string, color: string, args: string[]): void {
  const env = process.env.NO_COLOR ? process.env : { ...process.env, FORCE_COLOR: '1' };
  const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe'], env });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
    let buf = '';
    stream?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (!c.killed) c.kill();
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', '36', ['--watch-path=src/server', '--watch-path=src/shared', 'src/server/main.ts']);
run('client', '35', ['node_modules/vite/bin/vite.js']);

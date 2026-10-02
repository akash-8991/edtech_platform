import { external } from '../platform/trace';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export interface SandboxTest { name: string; stdin?: string; expectedStdout: string; dimension?: string }
export interface SandboxRequest { language: 'python'; files: { path: string; content: string }[]; entry: string; tests: SandboxTest[]; timeoutMs: number }
export interface TestResult { name: string; passed: boolean; dimension?: string; stdout?: string; stderr?: string; timedOut?: boolean; exitCode?: number | null }
export interface SandboxResult { ran: boolean; results: TestResult[]; reason?: string }
/** Pluggable execution backend (TRD: connector framework for coding sandboxes). Untrusted code NEVER runs in the API process. */
export interface SandboxProvider { readonly name: string; readonly enabled: boolean; run(r: SandboxRequest): Promise<SandboxResult> }
export const SANDBOX = Symbol('SANDBOX');

export class DisabledSandbox implements SandboxProvider {
  readonly name = 'disabled'; readonly enabled = false;
  async run(): Promise<SandboxResult> { return { ran: false, results: [], reason: 'sandbox not configured' }; }
}

export const LIMITS = { files: 50, fileBytes: 256 * 1024, outputBytes: 64 * 1024, memory: '256m', cpus: '0.5', pids: 64 };
const safePath = (p: string) => !!p && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0') && p.length <= 120;
export const normOut = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');

/** Every flag here is a security control; tests assert them so they cannot be dropped by accident. */
export function dockerArgs(name: string, image: string, hostDir: string, entry: string, timeoutMs: number): string[] {
  return ['run', '--rm', '-i', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(LIMITS.pids), '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory, '--cpus', LIMITS.cpus, '--user', '65534:65534', '-v', `${hostDir}:/work:ro`, '-w', '/work',
    '--stop-timeout', '1', '-e', `SANDBOX_TIMEOUT_MS=${timeoutMs}`, image, 'python', '-I', '-B', `/work/${entry}`];
}

export type Exec = (cmd: string, args: string[], o: { input?: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;
export const realExec: Exec = (cmd, args, o) => external('sandbox', 'run', () => new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  const cap = (s: string, c: Buffer) => (s.length < LIMITS.outputBytes ? s + c.toString('utf8') : s);
  p.stdout.on('data', (c) => (stdout = cap(stdout, c))); p.stderr.on('data', (c) => (stderr = cap(stderr, c)));
  const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, o.timeoutMs);
  p.on('close', (code) => { clearTimeout(t); resolve({ stdout: stdout.slice(0, LIMITS.outputBytes), stderr: stderr.slice(0, LIMITS.outputBytes), code, timedOut }); });
  p.on('error', () => { clearTimeout(t); resolve({ stdout, stderr: 'spawn failed', code: null, timedOut }); });
  if (o.input) p.stdin.write(o.input); p.stdin.end();
}));

export class DockerSandbox implements SandboxProvider {
  readonly name = 'docker'; readonly enabled = true;
  constructor(private image = process.env.SANDBOX_IMAGE_PYTHON ?? 'python:3.12-alpine', private exec: Exec = realExec) {}
  async run(r: SandboxRequest): Promise<SandboxResult> {
    if (r.language !== 'python') return { ran: false, results: [], reason: 'unsupported language' };
    if (r.files.length > LIMITS.files || r.files.some((f) => !safePath(f.path) || f.content.length > LIMITS.fileBytes)) return { ran: false, results: [], reason: 'files exceed limits or have unsafe paths' };
    if (!safePath(r.entry) || !r.files.some((f) => f.path === r.entry)) return { ran: false, results: [], reason: 'entry file not found in submission' };
    const dir = await mkdtemp(join(tmpdir(), 'sbx-'));
    try {
      for (const f of r.files) { const full = join(dir, f.path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, f.content, { mode: 0o444 }); }
      const results: TestResult[] = [];
      for (const t of r.tests) {
        const name = `sbx-${randomUUID()}`;
        const o = await this.exec('docker', dockerArgs(name, this.image, dir, r.entry, r.timeoutMs), { input: t.stdin, timeoutMs: r.timeoutMs + 3000 });
        if (o.timedOut) await this.exec('docker', ['rm', '-f', name], { timeoutMs: 5000 }).catch(() => undefined); // make sure the container is gone
        results.push({ name: t.name, dimension: t.dimension, passed: !o.timedOut && o.code === 0 && normOut(o.stdout) === normOut(t.expectedStdout), stdout: o.stdout.slice(0, 2000), stderr: o.stderr.slice(0, 1000), timedOut: o.timedOut, exitCode: o.code });
      }
      return { ran: true, results };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

export function buildSandbox(env = process.env): SandboxProvider { return env.SANDBOX_MODE === 'docker' ? new DockerSandbox() : new DisabledSandbox(); }

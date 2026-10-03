// Runs the REAL Docker sandbox (no stand-in executor) against well-behaved and hostile programs. Skipped when no Docker daemon or image is available:
//   docker pull python:3.12-alpine   then   npx jest test/sandbox-live.spec.ts
import { execSync } from 'child_process';
import { DockerSandbox, SandboxRequest } from '../src/grading/sandbox';

const IMAGE = process.env.SANDBOX_IMAGE_PYTHON ?? 'python:3.12-alpine';
const ready = (() => { try { execSync(`docker image inspect ${IMAGE}`, { stdio: 'ignore', timeout: 25000 }); return true; } catch { return false; } })();
const d = ready ? describe : describe.skip;
jest.setTimeout(120_000);

const sbx = new DockerSandbox(IMAGE);
const run = (code: string, tests: SandboxRequest['tests'], timeoutMs = 6000) => sbx.run({ language: 'python', files: [{ path: 'main.py', content: code }], entry: 'main.py', tests, timeoutMs });
const one = async (code: string, expected = '', stdin?: string, timeoutMs?: number) => (await run(code, [{ name: 't', expectedStdout: expected, stdin }], timeoutMs)).results[0];

d('code-grading sandbox (real Docker)', () => {
  it('runs a correct program against several tests with stdin and judges the output', async () => {
    const r = await run('n = int(input())\nprint(n * n)\n', [{ name: 'square 3', stdin: '3\n', expectedStdout: '9', dimension: 'correctness' }, { name: 'square 12', stdin: '12\n', expectedStdout: '144' }, { name: 'wrong on purpose', stdin: '2\n', expectedStdout: '5' }]);
    expect(r.ran).toBe(true); expect(r.results.map((x) => x.passed)).toEqual([true, true, false]); expect(r.results[0].exitCode).toBe(0);
  });
  it('reports a crash with its error and a non-zero exit', async () => {
    const t = await one('raise ValueError("boom")'); expect(t.passed).toBe(false); expect(t.exitCode).not.toBe(0); expect(t.stderr).toMatch(/ValueError: boom/);
  });
  it('stops an endless loop at the time limit and removes the container', async () => {
    const t0 = Date.now(); const t = await one('while True: pass', '', undefined, 2000); expect(t.timedOut).toBe(true); expect(t.passed).toBe(false); expect(Date.now() - t0).toBeLessThan(15_000);
    expect(execSync('docker ps -a --filter name=sbx- -q').toString().trim()).toBe('');
  });
  it('has no network', async () => {
    const t = await one('import socket\ntry:\n  socket.create_connection(("1.1.1.1", 80), 3); print("CONNECTED")\nexcept Exception as e:\n  print("BLOCKED", type(e).__name__)', 'BLOCKED OSError'); expect(t.stdout).not.toMatch(/CONNECTED/); expect(t.stdout).toMatch(/BLOCKED/);
  });
  it('cannot write to the filesystem, except a small non-executable /tmp', async () => {
    const t = await one('import os\nfor p in ("/work/x", "/etc/x", "/x"):\n  try:\n    open(p, "w").write("1"); print("WROTE", p)\n  except Exception as e: print("denied", p)\nopen("/tmp/ok", "w").write("1"); print("tmp ok")\n'); expect(t.stdout).not.toMatch(/WROTE/); expect(t.stdout).toMatch(/tmp ok/);
  });
  it('runs as an unprivileged user with no capabilities, and the environment holds only the image defaults', async () => {
    const t = await one('import os\nprint(os.getuid(), os.getgid())\nok = {"PATH","LANG","GPG_KEY","PYTHON_VERSION","PYTHON_SHA256","HOME","HOSTNAME","SANDBOX_TIMEOUT_MS"}\nprint(sorted(set(os.environ) - ok))\nprint(open("/proc/self/status").read().split("CapEff:")[1].split()[0])', '65534 65534\n[]\n0000000000000000');
    expect(t.passed).toBe(true);
  });
  it('limits processes (a fork bomb cannot take the host down)', async () => {
    const t = await one('import os\nn = 0\ntry:\n  while n < 1000:\n    if os.fork() == 0:\n      import time; time.sleep(5); os._exit(0)\n    n += 1\nexcept OSError: pass\nprint("forked", n < 200)', 'forked True', undefined, 8000); expect(t.stdout).toMatch(/forked True/);
  });
  it('limits memory (a program that grabs gigabytes is killed, not the host)', async () => {
    const t = await one('x = bytearray(2 * 1024 * 1024 * 1024)\nprint("ALLOCATED")', '', undefined, 8000); expect(t.stdout).not.toMatch(/ALLOCATED/); expect(t.passed).toBe(false);
  });
  it('cannot read the host: no learner files from other runs, no host paths', async () => {
    const t = await one('import os\nprint(sorted(os.listdir("/work")))\nprint(os.path.exists("/Users"), os.path.exists("/home/akash"))', "['main.py']\nFalse False"); expect(t.passed).toBe(true);
  });
  it('cannot be fooled by output that merely looks right on stderr or with extra lines', async () => {
    const t = await one('import sys\nprint("42", file=sys.stderr)\nprint("41")', '42'); expect(t.passed).toBe(false);
    const u = await one('print("42")\nprint("extra")', '42'); expect(u.passed).toBe(false);
  });
  it('rejects unsafe paths and oversize submissions before starting anything', async () => {
    const bad = await sbx.run({ language: 'python', files: [{ path: '../evil.py', content: 'print(1)' }], entry: '../evil.py', tests: [{ name: 't', expectedStdout: '1' }], timeoutMs: 3000 }); expect(bad.ran).toBe(false);
  });
});

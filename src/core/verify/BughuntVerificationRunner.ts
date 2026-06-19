/**
 * BughuntVerificationRunner — verified 门的真实执行层（独立于 WorkflowEngine）。
 *
 * compile 层（必）：在 worktree cwd 跑 compile_commands（如 tsc --noEmit / npm test / build），
 *   捕获 exit_code/stdout/stderr，产出 compile_artifacts。无副作用（只 build/test），不需沙箱。
 * blackbox 层（可选，默认关闭，需 Leader 显式授权）：TargetServiceManager 起目标服务 + HTTP probe，
 *   产出 blackbox_artifacts。
 *
 * 编排决策：独立 runner 而非嵌入 WorkflowEngine——验证需确定性/无状态/幂等，WorkflowEngine 面向
 * 用户 Canvas 的通用 DAG 编排过重。直接 child_process + node:net/http 更轻、更易测试。
 *
 * 产出的 artifacts 喂给 BughuntLedger.getBughuntFindingGateGaps 的 verified 门：
 *   compile_artifacts/blackbox_artifacts 非空即认「真实执行产物」（gate 已优先于正则）。
 *
 * 无 Docker；跨平台（Linux/macOS/Windows × x64/arm64）。
 */
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { TargetServiceManager, type TargetServiceConfig } from './TargetServiceManager.js';

export interface CompileCommand {
  command: string;
  args?: string[];
  cwd: string;
}

export interface CompileResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CompileVerificationResult {
  results: CompileResult[];
  allPassed: boolean;
  artifacts: string[];
}

export interface BlackboxProbe {
  cwd: string;
  startCommand: string;
  startArgs?: string[];
  healthPath?: string;
  requestPath: string;        // HTTP probe 的 path
  expectedStatus?: number;    // 缺省 = 接受 < 400
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface BlackboxProbeResult {
  requestPath: string;
  status?: number;
  ok: boolean;
  bodyHead: string;
}

export interface BlackboxVerificationResult {
  started: boolean;
  stdoutTail: string;
  stderrTail: string;
  probes: BlackboxProbeResult[];
  artifacts: string[];
}

const OUT_MAX = 64 * 1024;

function runChild(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const trim = (s: string): string => (s.length > OUT_MAX ? s.slice(s.length - OUT_MAX) : s);
    child.stdout?.on('data', (c: Buffer) => { stdout = trim(stdout + c.toString()); });
    child.stderr?.on('data', (c: Buffer) => { stderr = trim(stderr + c.toString()); });
    child.on('error', (err) => resolveRun({ exitCode: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` }));
    child.on('close', (code) => resolveRun({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/** compile 层：跑命令序列，捕获 exit_code/stdout，产出 compile_artifacts。 */
export async function runCompileVerification(commands: CompileCommand[]): Promise<CompileVerificationResult> {
  const results: CompileResult[] = [];
  for (const cmd of commands) {
    const start = Date.now();
    const r = await runChild(cmd.command, cmd.args ?? [], cmd.cwd, {});
    results.push({
      command: `${cmd.command} ${(cmd.args ?? []).join(' ')}`.trim(),
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Date.now() - start,
    });
  }
  const allPassed = results.length > 0 && results.every((r) => r.exitCode === 0);
  const artifacts = results.map((r) =>
    `[compile] ${r.command} → exit=${r.exitCode} (${r.durationMs}ms)${r.stdout ? `\nstdout: ${r.stdout.slice(0, 512)}` : ''}${r.stderr ? `\nstderr: ${r.stderr.slice(0, 256)}` : ''}`,
  );
  return { results, allPassed, artifacts };
}

function httpGet(host: string, port: number, path: string, timeoutMs: number): Promise<{ status?: number; body: string; ok: boolean }> {
  return new Promise((resolveReq) => {
    const req = get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > OUT_MAX) body = body.slice(body.length - OUT_MAX);
      });
      res.on('end', () => resolveReq({ status: res.statusCode, body, ok: true }));
      res.on('error', () => resolveReq({ status: res.statusCode, body, ok: false }));
    });
    req.on('timeout', () => { req.destroy(); resolveReq({ body: '', ok: false }); });
    req.on('error', () => resolveReq({ body: '', ok: false }));
  });
}

/** blackbox 层（需授权）：起目标服务 + HTTP probe，产出 blackbox_artifacts。 */
export async function runBlackboxVerification(probe: BlackboxProbe): Promise<BlackboxVerificationResult> {
  const manager = new TargetServiceManager();
  const cfg: TargetServiceConfig = {
    cwd: probe.cwd,
    command: probe.startCommand,
    args: probe.startArgs,
    healthPath: probe.healthPath,
    env: probe.env,
    readyTimeoutMs: probe.readyTimeoutMs,
  };
  const handle = await manager.start(cfg);
  try {
    const resp = await httpGet(handle.host, handle.port, probe.requestPath, 5000);
    const expected = probe.expectedStatus;
    const statusOk = expected !== undefined ? resp.status === expected : (resp.status ?? 599) < 400;
    const pr: BlackboxProbeResult = {
      requestPath: probe.requestPath,
      status: resp.status,
      ok: statusOk && resp.ok,
      bodyHead: resp.body.slice(0, 512),
    };
    const artifacts = [
      `[blackbox] ${probe.requestPath} → status=${pr.status} ok=${pr.ok}\nbody: ${pr.bodyHead || '(empty)'}`,
    ];
    return {
      started: true,
      stdoutTail: handle.stdoutTail,
      stderrTail: handle.stderrTail,
      probes: [pr],
      artifacts,
    };
  } finally {
    await manager.stop(`${handle.pid}:${handle.port}`);
  }
}

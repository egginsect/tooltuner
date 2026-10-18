import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FlywheelError, canonicalDigest, type Job, type Grant, type Packet } from "../contracts.js";

const execFileAsync = promisify(execFile);
export interface RunnerConfig {
  id: string;
  executable: string;
  args: readonly string[];
  /** Secret values are resolved by the composition root; never expose this object in readiness. */
  environment: Readonly<Record<string, string>>;
  environmentAllowlist: readonly string[];
  writablePaths: readonly string[];
  readOnlyPaths?: readonly string[];
  checks: readonly { name: string; executable: string; args: readonly string[] }[];
  timeoutMs: number;
  network: boolean;
}
export interface TrustedRepository {
  repoId: string;
  ownerId: string;
  application: string;
  localPath: string;
  allowedBaseShas: readonly string[];
  runnerConfigIds: readonly string[];
}
export interface RunnerLaunch {
  job: Job;
  packet: Packet;
  repository: TrustedRepository;
  config: RunnerConfig;
  developmentGrant: Grant;
  developmentToken: string;
}
export type RunnerObservation =
  | { state: "running"; receipt: NonNullable<Job["external_receipt"]>; workspaceRef: string }
  | { state: "completed"; result: NonNullable<Job["result"]>; workspaceRef: string }
  | { state: "failed" | "cancelled" | "unknown"; error: FlywheelError; result?: NonNullable<Job["result"]>; workspaceRef?: string };
export interface RunnerAdapter {
  launch(input: RunnerLaunch): Promise<RunnerObservation>;
  /** Never relaunches: absence of a live in-process record is uncertainty. */
  reconcile(job: Job): Promise<RunnerObservation>;
  /** Revalidates workspace, source ancestry, clean commit and artifact digest before deployment. */
  verifyArtifact(job: Job): Promise<{ directory: string; digest: string }>;
}

const safeEnvironment = {
  PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
};
const runnerEnvironmentNames = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]);
const reserved = /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|LD_.*|DYLD_.*|GIT_.*|NPM_.*|npm_.*|FLYWHEEL_.*|TOOLTUNER_.*)$|(?:VERCEL|MANAGEMENT|MANAGER|OWNER|PRODUCTION|DEPLOY|BYPASS|PROJECT_ID|ORG_ID)/i;
export function codingEnvironment(config: RunnerConfig, token: string, job: Job): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/home/runner", LANG: "C.UTF-8" };
  for (const [name, value] of Object.entries(config.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.test(name) || !runnerEnvironmentNames.has(name) || !config.environmentAllowlist.includes(name)) {
      throw new FlywheelError("invalid_args", "Runner environment contains a forbidden or non-allowlisted name.");
    }
    env[name] = value;
  }
  env.TOOLTUNER_DEVELOPMENT_TOKEN = token;
  env.TOOLTUNER_JOB_ID = job.job_id;
  env.TOOLTUNER_PACKET_ID = job.packet_id;
  // Temporary aliases for existing runner adapters.
  env.FLYWHEEL_DEVELOPMENT_TOKEN = token;
  env.FLYWHEEL_JOB_ID = job.job_id;
  env.FLYWHEEL_PACKET_ID = job.packet_id;
  return env;
}
export async function git(directory: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", directory, ...args],
    { env: safeEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}
const forbiddenPath = /(^|\/)(?:\.git|\.claude|\.codex|\.agents|\.env[^/]*|\.vercel|\.aws|\.ssh|\.npmrc|\.netrc)(\/|$)/;
function relativePath(value: string): string {
  if (!value || value === "." || path.isAbsolute(value) || value.split("/").some((s) => s === ".." || s === "" || s === ".") || forbiddenPath.test(value)) {
    throw new FlywheelError("invalid_args", "Runner write paths must be explicit repository-relative paths without credential or agent state.");
  }
  return value;
}

/** The wrapper owns stdout; the untrusted CLI never inherits its pipe. Only its real spawn event writes START. */
const entry = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const command=JSON.parse(process.argv[2]);const child=spawn(command.executable,command.args,{cwd:'/workspace',env:process.env,stdio:['ignore','ignore','ignore']});
child.once('spawn',()=>fs.writeSync(1,JSON.stringify({pid:child.pid,started_at:new Date().toISOString()})+'\\n'));
child.once('error',()=>{fs.writeSync(1,JSON.stringify({spawn_failed:true})+'\\n');process.exit(127)});child.once('exit',(code,signal)=>process.exit(signal?125:(code??126)));
`;
interface LocalRun {
  input: RunnerLaunch;
  directory: string;
  receipt: NonNullable<Job["external_receipt"]>;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  timedOut: boolean;
  result?: NonNullable<Job["result"]>;
  finalizing?: Promise<RunnerObservation>;
}
export interface LocalRunnerOptions { workspaceRoot: string; sandboxExecutable?: string }

/** Linux bubblewrap runner. There is deliberately no unsandboxed fallback. */
export function createLocalRunner(options: LocalRunnerOptions): RunnerAdapter {
  if (!path.isAbsolute(options.workspaceRoot)) throw new TypeError("workspaceRoot must be absolute.");
  const runs = new Map<string, LocalRun>();
  const sandbox = options.sandboxExecutable ?? "/usr/bin/bwrap";
  async function prepare(input: RunnerLaunch): Promise<string> {
    const root = await realpath(await mkdir(options.workspaceRoot, { recursive: true }).then(() => options.workspaceRoot));
    const jobRoot = path.join(root, input.job.job_id);
    await mkdir(jobRoot, { mode: 0o700 }); // EEXIST is uncertainty, never reuse an old checkout.
    const repository = await realpath(input.repository.localPath);
    const bare = path.join(jobRoot, "repository.git");
    await execFileAsync("/usr/bin/git", ["init", "--bare", bare], { env: safeEnvironment, timeout: 30_000 });
    await git(bare, ["fetch", "--no-tags", "--depth=1", "--", repository, input.job.base_sha]);
    const directory = path.join(jobRoot, "workspace");
    await git(bare, ["worktree", "add", "-b", `job/${input.job.job_id}`, "--", directory, input.job.base_sha]);
    const files = (await git(directory, ["ls-files", "-z"])).split("\0").filter(Boolean);
    if (files.some((f) => forbiddenPath.test(f))) throw new FlywheelError("forbidden", "Repository contains tracked credential or agent state; remove it before coding jobs.");
    for (const writable of input.config.writablePaths) {
      relativePath(writable);
      const target = path.join(directory, writable);
      if ((await lstat(target)).isSymbolicLink() || !(await realpath(target)).startsWith(`${directory}/`)) {
        throw new FlywheelError("forbidden", "Runner write mount escapes its workspace.");
      }
    }
    await writeFile(path.join(jobRoot, "entry.cjs"), entry, { mode: 0o400, flag: "wx" });
    await writeFile(path.join(jobRoot, "packet.json"), JSON.stringify(input.packet), { mode: 0o400, flag: "wx" });
    return directory;
  }
  function sandboxArgs(config: RunnerConfig, directory: string, command: { executable: string; args: readonly string[] }, wrapper: boolean): string[] {
    if (!path.isAbsolute(command.executable) || config.writablePaths.length === 0 || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 3_600_000) {
      throw new FlywheelError("invalid_args", "Runner requires an absolute executable, write paths and a timeout of at most one hour.");
    }
    const args = ["--die-with-parent", "--new-session", "--unshare-all"];
    if (config.network) args.push("--share-net");
    args.push("--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home/runner", "--ro-bind", directory, "/workspace");
    for (const writable of config.writablePaths) args.push("--bind", path.join(directory, relativePath(writable)), `/workspace/${writable}`);
    for (const mount of config.readOnlyPaths ?? []) {
      if (!path.isAbsolute(mount) || !/^\/(opt\/|etc\/ssl\/certs(?:\/|$)|etc\/resolv\.conf$)/.test(mount)) {
        throw new FlywheelError("invalid_args", "Additional runtime mounts are limited to /opt tools, DNS and public trust certificates.");
      }
      args.push("--ro-bind", mount, mount);
    }
    args.push("--chdir", "/workspace");
    if (wrapper) args.push("--ro-bind", path.join(path.dirname(directory), "entry.cjs"), "/runner/entry.cjs",
      "--ro-bind", path.join(path.dirname(directory), "packet.json"), "/runner/packet.json",
      "/usr/bin/node", "/runner/entry.cjs", JSON.stringify(command));
    else args.push(command.executable, ...command.args);
    return args;
  }
  async function artifact(job: Job): Promise<{ directory: string; digest: string }> {
    if (!job.result || !job.workspace_ref) throw new FlywheelError("invalid_args", "Job has no verified result artifact.");
    const root = await realpath(options.workspaceRoot);
    const expected = path.join(root, job.job_id, "workspace");
    const directory = await realpath(job.workspace_ref);
    if (directory !== expected || job.result.branch !== `job/${job.job_id}`) throw new FlywheelError("forbidden", "Artifact workspace or branch is outside this job.");
    if (await git(directory, ["rev-parse", "HEAD"]) !== job.result.commit_sha || await git(directory, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])) {
      throw new FlywheelError("forbidden", "Artifact commit changed or workspace is dirty.");
    }
    await git(directory, ["merge-base", "--is-ancestor", job.base_sha, job.result.commit_sha]);
    const tree = await git(directory, ["rev-parse", "HEAD^{tree}"]);
    const digest = canonicalDigest({ job_id: job.job_id, repo_id: job.repo_id, base_sha: job.base_sha, commit_sha: job.result.commit_sha, tree });
    if (job.result.artifact_ref !== digest) throw new FlywheelError("forbidden", "Artifact digest does not match the trusted job output.");
    return { directory, digest };
  }
  async function finish(run: LocalRun): Promise<RunnerObservation> {
    if (run.timedOut) return { state: "unknown", error: new FlywheelError("outcome_unknown", "Coding process exceeded its budget and was terminated; inspect job output before any new launch.") };
    if (!run.exit) return { state: "running", receipt: run.receipt, workspaceRef: run.directory };
    if (run.exit.signal || run.exit.code !== 0) return { state: "failed", error: new FlywheelError("upstream_error", `Coding process exited without a successful artifact (exit ${run.exit.code ?? "signal"}).`, { certainty: "executed", retryable: false }) };
    if (run.result) return { state: "completed", result: run.result, workspaceRef: run.directory };
    const changed = (await git(run.directory, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).split("\n").filter(Boolean);
    if (!changed.length) throw new FlywheelError("invalid_args", "Coding process produced no changed artifact.");
    const checks: NonNullable<Job["result"]>["checks"] = [];
    for (const check of run.input.config.checks) {
      try {
        await execFileAsync(sandbox, sandboxArgs(run.input.config, run.directory, check, false), {
          env: codingEnvironment(run.input.config, "", run.input.job), timeout: run.input.config.timeoutMs, maxBuffer: 64 * 1024,
        });
        checks.push({ name: check.name, outcome: "pass" });
      } catch { checks.push({ name: check.name, outcome: "fail" }); }
    }
    if (!checks.length) checks.push({ name: "configured-checks", outcome: "skipped" });
    const files = (await git(run.directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const file of files) {
      const item = await lstat(path.join(run.directory, file)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!item) continue;
      if (forbiddenPath.test(file) || !item.isFile()) throw new FlywheelError("forbidden", "Job output includes forbidden state or a symbolic link.");
    }
    if (await git(run.directory, ["ls-files", "--others", "--ignored", "--exclude-standard"])) throw new FlywheelError("forbidden", "Ignored job output is outside the committed artifact; keep caches and temporary files in /tmp.");
    await git(run.directory, ["add", "--all"]);
    await git(run.directory, ["-c", "user.name=ToolTuner runner", "-c", "user.email=runner@localhost", "commit", "-m", `Job ${run.input.job.job_id}`]);
    const commit = await git(run.directory, ["rev-parse", "HEAD"]);
    const tree = await git(run.directory, ["rev-parse", "HEAD^{tree}"]);
    run.result = { branch: `job/${run.input.job.job_id}`, commit_sha: commit,
      artifact_ref: canonicalDigest({ job_id: run.input.job.job_id, repo_id: run.input.job.repo_id, base_sha: run.input.job.base_sha, commit_sha: commit, tree }),
      change_summary: "Coding output captured from the isolated job worktree.", checks, requested_deployment: null };
    if (checks.some((c) => c.outcome === "fail")) return { state: "failed", result: run.result, workspaceRef: run.directory, error: new FlywheelError("invalid_args", "Job output failed a configured validation check.", { certainty: "executed" }) };
    return { state: "completed", result: run.result, workspaceRef: run.directory };
  }
  return {
    async launch(input) {
      if (runs.has(input.job.job_id)) return { state: "unknown", error: new FlywheelError("outcome_unknown", "This runner already knows the job; reconcile instead of launching.") };
      const environment = codingEnvironment(input.config, input.developmentToken, input.job);
      let directory: string;
      try { directory = await prepare(input); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FlywheelError("outcome_unknown", "Job workspace already exists; reconcile it before any launch."); throw new FlywheelError("operation_unavailable", "Isolated worktree preparation failed. Check repository, base SHA and workspace permissions; do not reuse an existing job directory."); }
      return new Promise<RunnerObservation>((resolve, reject) => {
        const child = spawn(sandbox, sandboxArgs(input.config, directory, input.config, true), {
          env: environment, detached: true, stdio: ["ignore", "pipe", "ignore"],
        });
        let run: LocalRun | undefined;
        let settled = false;
        let buffer = "";
        const settleFailure = (definitelyNotStarted = false) => { if (!settled) { settled = true; reject(new FlywheelError(definitelyNotStarted ? "operation_unavailable" : "outcome_unknown", "Coding CLI did not confirm process start. Install it under /usr or explicitly mounted /opt with independent runner authentication, and permit bubblewrap user/PID/mount namespaces. Host HOME credentials are unavailable; reconcile this workspace before another launch.", { retryable: false })); } };
        const timer = setTimeout(() => {
          if (run) run.timedOut = true;
          if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
          if (!settled) { settled = true; reject(new FlywheelError("outcome_unknown", "Coding start receipt timed out; inspect the isolated workspace before another request.")); }
        }, input.config.timeoutMs);
        const receiptStream = child.stdout;
        if (receiptStream && "on" in receiptStream) receiptStream.on("data", (data: Buffer) => {
          buffer += data.toString("utf8");
          if (settled || !buffer.includes("\n")) return;
          try {
            const receipt = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { pid: number; started_at: string; spawn_failed?: boolean };
            if (receipt.spawn_failed) { settleFailure(true); return; }
            if (!Number.isInteger(receipt.pid) || receipt.pid < 1 || !Number.isFinite(Date.parse(receipt.started_at))) throw new Error("Invalid receipt");
            run = { input: { ...input, developmentToken: "" }, directory, receipt: { runner: "local-bubblewrap", run_id: randomUUID(), ...receipt }, exit: null, timedOut: false };
            runs.set(input.job.job_id, run);
            settled = true;
            resolve({ state: "running", receipt: run.receipt, workspaceRef: directory });
          } catch { settleFailure(); }
        });
        child.once("error", () => { clearTimeout(timer); settleFailure(true); });
        child.once("close", (code, signal) => { clearTimeout(timer); if (run) run.exit = { code, signal }; else settleFailure(); });
      });
    },
    async reconcile(job) {
      const run = runs.get(job.job_id);
      if (!run || (job.external_receipt && run.receipt.run_id !== job.external_receipt.run_id)) {
        return { state: "unknown", error: new FlywheelError("outcome_unknown", "Runner memory no longer contains trusted process evidence. Reconcile the recorded run/workspace manually; no process was relaunched.") };
      }
      if (!run.exit && !run.timedOut) return { state: "running", receipt: run.receipt, workspaceRef: run.directory };
      run.finalizing ??= finish(run).catch((error: unknown): RunnerObservation => ({ state: "failed", error: error instanceof FlywheelError ? error : new FlywheelError("outcome_unknown", "Artifact collection failed; inspect the saved workspace.") }));
      return run.finalizing;
    },
    verifyArtifact: artifact,
  };
}

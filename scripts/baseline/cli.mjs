import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, relative, resolve } from "node:path";
import { root, outputRoot, sha256, readJson, writeJson, runId, prepareEnvironment, isolatedEnv, npmCli, inspectTests, serverArgs, supportsBaselineNode, currentCommit, inspectReferenceFiles, migrationLockChecks, upgradeLockChecks, upgradeEvidenceCheck, inspectInstalledDependencies } from "./common.mjs";

const mode = process.argv[2];
const argumentsAfterMode = process.argv.slice(3);
function option(name) {
  const index = argumentsAfterMode.indexOf(name);
  return index < 0 ? undefined : argumentsAfterMode[index + 1];
}
function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function log(message) { console.log(`[baseline] ${message}`); }

async function command(id, executable, args, env, runDir, { timeoutMs = 15 * 60_000 } = {}) {
  const started = Date.now();
  const logPath = join(runDir, `${id}.log`);
  const output = createWriteStream(logPath);
  log(`Running ${id}; log: ${relative(root, logPath)}`);
  // A private POSIX process group keeps npm, Vitest and their child servers
  // together without ever signalling the shell that launched this runner.
  const ownsProcessGroup = process.platform !== "win32";
  const child = spawn(executable, args, { cwd: root, env, detached: ownsProcessGroup, stdio: ["ignore", "pipe", "pipe"] });
  let error;
  let timedOut = false;
  let interrupted = false;
  let interruptSignal;
  let forcedKill = false;
  let termination;
  let forceTimer;
  const stopChildren = (signal) => {
    if (!child.pid) return;
    try {
      if (ownsProcessGroup) process.kill(-child.pid, signal);
      else if (signal === "SIGKILL") {
        // Windows has no negative-PID process-group signalling.
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
      } else child.kill(signal);
    } catch (err) {
      // ESRCH means the entire owned group is already gone. Windows taskkill
      // also returns an error for an already-exited process.
      if (err.code !== "ESRCH" && ownsProcessGroup) error ??= `Could not send ${signal} to child group: ${err.message}`;
    }
  };
  const terminate = () => {
    if (termination) return;
    stopChildren("SIGTERM");
    // Do not cancel this timer merely because the group leader exits: a child
    // can ignore SIGTERM and retain npm's stdout pipe after npm has exited.
    termination = new Promise((resolveStopped) => {
      forceTimer = setTimeout(() => {
        forcedKill = true;
        stopChildren("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        resolveStopped();
      }, 5000);
    });
  };
  const onInterrupt = (signal) => {
    interrupted = true;
    interruptSignal ??= signal;
    terminate();
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  child.on("error", (err) => { error = err.message; });
  output.on("error", (err) => { error ??= `Could not write command log: ${err.message}`; terminate(); });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  let code = null;
  let signal = null;
  try {
    // Await close even on spawn errors; Node emits close after error, and this
    // avoids returning while stdio teardown is still pending.
    [code, signal] = await new Promise((resolveClosed) => child.once("close", (...result) => resolveClosed(result)));
    clearTimeout(timer);
    if (termination) await termination;
    if (!output.destroyed) {
      const finished = once(output, "finish");
      if (error) output.write(`\n${error}\n`);
      output.end();
      await finished.catch((err) => { error ??= err.message; });
    }
  } finally {
    clearTimeout(timer);
    // A signal or log failure can arrive while the log is being flushed.
    if (termination) await termination;
    clearTimeout(forceTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  const result = { id, status: code === 0 && !error && !timedOut && !interrupted ? "passed" : "failed", command: [executable, ...args], exitCode: code,
    signal, timedOut, interrupted, interruptSignal, forcedKill, error, durationMs: Date.now() - started, log: relative(runDir, logPath) };
  log(`${id}: ${result.status}`);
  return result;
}

async function verify() {
  const id = runId();
  const runDir = join(outputRoot, "runs", id);
  mkdirSync(runDir, { recursive: true });
  const environment = prepareEnvironment(join(runDir, "environment"));
  const env = isolatedEnv(environment);
  const reference = readJson(join(root, "docs/baseline/reference.json"));
  const migrationPath = join(root, "docs/migration/source-manifest.json");
  const migration = existsSync(migrationPath) ? readJson(migrationPath) : undefined;
  const upgradePath = join(root, "docs/upgrades/pi-0.99.2.json");
  const upgrade = existsSync(upgradePath) ? readJson(upgradePath) : undefined;
  const report = {
    schemaVersion: 1, id, startedAt: new Date().toISOString(), status: "running",
    referenceCommit: reference.commit, currentCommit: currentCommit(),
    environment: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch, timezone: env.TZ,
      npm: execFileSync(process.execPath, [npmCli(), "--version"], { encoding: "utf8", env }).trim() },
    migration: migration ? { manifest: relative(root, migrationPath), manifestSha256: sha256(readFileSync(migrationPath)),
      name: migration.name, sourceCommit: migration.sourceCommit, sourceHasUncommittedChanges: migration.sourceHasUncommittedChanges,
      sourceLockfileSha256: migration.sourceLockfileSha256, targetLockfileSha256: migration.targetLockfileSha256 } : undefined,
    upgrade: upgrade ? { manifest: relative(root, upgradePath), manifestSha256: sha256(readFileSync(upgradePath)),
      id: upgrade.id, upstream: upgrade.upstream, previousLockfileSha256: upgrade.previousLockfileSha256,
      targetLockfileSha256: upgrade.targetLockfileSha256 } : undefined,
    source: inspectReferenceFiles(reference, root,
      git("ls-files", "--cached", "--others", "--exclude-standard", "apps").split("\n"), migration?.pathMappings),
    checks: [], manualAcceptance: { status: "not_run", reason: "No real provider configured; see docs/baseline/acceptance.md." },
  };
  const fingerprint = (directory) => readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? fingerprint(path) : [{ path, sha256: sha256(readFileSync(join(root, path))) }];
  });
  report.harness = fingerprint("scripts/baseline").sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(join(runDir, "working-tree-status.txt"), git("status", "--short") + "\n");
  const save = () => writeJson(join(runDir, "report.json"), report);
  save();
  report.checks.push({ id: "node-engine", status: supportsBaselineNode(process.version) ? "passed" : "failed",
    actual: process.version, required: "^22.22.2 || ^24.15.0 || >=26 (locked jsdom test dependency); verified on Node 24.19.0" });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try { db.exec("CREATE VIRTUAL TABLE probe USING fts5(content)"); } finally { db.close(); }
    report.checks.push({ id: "sqlite-fts5", status: "passed" });
  } catch (err) { report.checks.push({ id: "sqlite-fts5", status: "failed", error: err.message }); }
  const lockBytes = readFileSync(join(root, "package-lock.json"));
  if (migration) {
    if (upgrade) {
      report.checks.push(...upgradeLockChecks(lockBytes, migration, upgrade), upgradeEvidenceCheck(upgrade, root));
    } else {
      report.checks.push(...migrationLockChecks(lockBytes, migration, readJson(join(root, "docs/migration/dependency-lock-reference.json"))));
    }
    const history = migration.files.filter((file) => file.sourcePath === "docs/baseline/reference.json" || file.sourcePath.startsWith("docs/baseline/results/"));
    const changed = history.filter((file) => !existsSync(join(root, file.targetPath)) || sha256(readFileSync(join(root, file.targetPath))) !== file.sourceSha256)
      .map((file) => file.targetPath);
    report.checks.push({ id: "historical-evidence-preserved", status: history.length > 0 && !changed.length ? "passed" : "failed", checkedFiles: history.length, changedFiles: changed });
  } else {
    if (upgrade) report.checks.push({ id: "dependency-upgrade-lineage", status: "failed", error: "An upstream upgrade requires the preserved migration source manifest." });
    const actual = sha256(lockBytes);
    report.checks.push({ id: "lockfile-unchanged", status: actual === reference.lockfileSha256 ? "passed" : "failed", expected: reference.lockfileSha256, actual });
  }
  if (!existsSync(join(root, "node_modules/typescript/bin/tsc"))) {
    report.checks.push({ id: "dependencies-installed", status: "failed", error: "Run npm ci with a supported Node version before baseline:verify." });
  } else {
    const lock = readJson(join(root, "package-lock.json"));
    const packages = ["typescript", "vite", "vitest", "jsdom", "node-pty"];
    const backendPackages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "pi-mcp-adapter",
      "@gotgenes/pi-permission-system", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo",
      "pi-subagents", "pi-web-access"];
    const versions = [...inspectInstalledDependencies(lock, packages),
      ...inspectInstalledDependencies(lock, backendPackages, join(root, "apps/clario"))];
    report.checks.push({ id: "key-dependency-versions", status: versions.every((item) => item.installed && item.installed === item.locked) ? "passed" : "failed", packages: versions });
    const npm = npmCli();
    for (const [name, args] of [
      ["harness-tests", ["--test", "scripts/baseline/common.test.mjs"]],
      ["build", [npm, "run", "build"]],
      ["tests", [npm, "test", "--", "--reporter=default", "--reporter=json", `--outputFile=${join(runDir, "vitest.json")}`]],
      ["l2-retrieval", [npm, "run", "eval:l2-retrieval"]],
      ["core-fixtures", ["--import", "tsx", "scripts/baseline/verify-core.ts", "--output", join(runDir, "core-fixtures.json")]],
      ["web-pty", ["scripts/baseline/verify-web.mjs", "--output", join(runDir, "web-pty.json")]],
    ]) {
      report.checks.push(await command(name, process.execPath, args, env, runDir));
      save();
      if (report.checks.at(-1).interrupted) break;
    }
    try {
      report.tests = inspectTests(readJson(join(runDir, "vitest.json")));
      report.checks.push({ id: "required-suites-executed", status: report.tests.passed ? "passed" : "failed", ...report.tests });
    } catch (err) { report.checks.push({ id: "required-suites-executed", status: "failed", error: err.message }); }
  }
  report.status = report.checks.every((c) => c.status === "passed") ? "passed" : "failed";
  report.finishedAt = new Date().toISOString();
  save();
  const markdown = ["# Clario可验证基线执行报告", "", `- 时间：${report.startedAt}`, `- 原版提交：\`${reference.commit}\``,
    `- 当前提交：\`${report.currentCommit}\``, `- Node：${report.environment.node}；npm：${report.environment.npm}`,
    `- 原版应用文件保持一致（按迁移路径映射比较）：${report.source.referenceApplicationUnchanged}`,
    ...(migration ? [`- 迁移映射：${migration.pathMappings.map(({ from, to }) => `\`${from}\` → \`${to}\``).join("；")}`,
      ...(upgrade ? [`- 当前依赖升级：\`${upgrade.id}\`；上游提交 \`${upgrade.upstream?.commit}\`。`,
        "- 原迁移与历史证据保留；当前锁文件按升级 SHA 固定，并与已记录的新版上游依赖比较。"] :
        ["- 锁文件按迁移后的 SHA 固定，同时核对原外部依赖；不宣称原锁文件字节未变。"]) ] : []),
    `- 自动检查：**${report.status}**`, `- 真实模型 / 人工验收：**not_run**`, "",
    "| 检查 | 状态 | 日志 |", "|---|---|---|", ...report.checks.map((c) => `| ${c.id} | ${c.status} | ${c.log ? `[log](${c.log})` : c.error ?? "—"} |`), "",
    "## 与原版的差异", "", ...report.source.changedReferenceFiles.map((p) => `- 修改：\`${p}\``), ...report.source.missingReferenceFiles.map((p) => `- 缺失：\`${p}\``), "",
    "原始 Vitest JSON、日志及合成环境与此报告保存在同一目录。通过表示固定环境中的工程检查通过，不表示真实教学效果或多端交付已验证。", ""].join("\n");
  writeFileSync(join(runDir, "report.md"), markdown);
  writeJson(join(outputRoot, "latest.json"), { id, report: relative(root, join(runDir, "report.json")) });
  log(`Report: ${join(runDir, "report.md")}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}

if (mode === "prepare") {
  const path = prepareEnvironment(join(outputRoot, "environments", runId()));
  log(`Isolated environment: ${path}`);
  log("The dummy provider cannot answer questions. Configure a real provider ONLY in this environment to run manual acceptance.");
  log(`Start with: npm run baseline:web -- --environment ${JSON.stringify(path)} --port 3100`);
} else if (mode === "verify") {
  await verify();
} else if (mode === "serve") {
  const requested = option("--environment");
  if (!requested) throw new Error("Pass --environment <path printed by baseline:prepare>.");
  const path = resolve(requested);
  if (!existsSync(join(path, "baseline-environment.json"))) throw new Error("Not a prepared baseline environment.");
  const port = Number(option("--port") ?? 3100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port.");
  const child = spawn(process.execPath, serverArgs(path, port), { cwd: root, env: isolatedEnv(path, { offline: false }), stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const [code] = await once(child, "close");
  process.exitCode = code ?? 1;
} else {
  throw new Error("Usage: cli.mjs prepare | verify | serve --environment <path> [--port 3100]");
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join, relative, resolve } from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const outputRoot = join(root, "runtime", "baseline");
export const sha256 = (content) => createHash("sha256").update(content).digest("hex");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`;
}

export function prepareEnvironment(path) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite an existing environment: ${path}`);
  for (const part of ["config", "data", "skills", "workspace"]) mkdirSync(join(path, part), { recursive: true });
  writeJson(join(path, "config", "config.json"), {
    experience: "learning", defaultProvider: "baseline-dummy", defaultModel: "baseline-dummy-model",
    providers: { "baseline-dummy": {
      baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "baseline-placeholder",
      models: [{ id: "baseline-dummy-model", name: "Baseline (no real model)", contextWindow: 32768, maxTokens: 2048 }],
    } },
    memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
    channels: { feishu: { enabled: false }, wechat: { enabled: false }, qq: { enabled: false } },
    subagents: { enabled: false }, mcp: { enabled: false },
    plugins: { todo: { enabled: false }, webAccess: { enabled: false }, computerUse: { enabled: false }, permissionSystem: { enabled: true, mode: "default" } },
    contentHub: { type: "bundle", baseUrl: "http://127.0.0.1:9" },
    scheduler: { timezone: "Asia/Shanghai" }, server: { port: 3100 },
  });
  writeJson(join(path, "config", "settings.json"), { enableInstallTelemetry: false, defaultProjectTrust: "never" });
  writeJson(join(path, "baseline-environment.json"), { schemaVersion: 1, createdAt: new Date().toISOString(), synthetic: true });
  writeFileSync(join(path, "workspace", "agent.md"), "# 基线工作区\n这里只使用合成学习材料。模型配置尚未填写时，不应宣称已完成真实教学验证。\n");
  return path;
}

// No provider credentials or inherited runtime paths enter the test subprocesses.
// Do not set INNO_CONFIG_FILE/CONFIG_DIR here: server.smoke.test creates its own
// --home, which these environment variables would otherwise silently override.
export function isolatedEnv(path, { offline = true } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(INNO_|PI_)/.test(key) || /API_KEY|TOKEN|KEY_ID|SECRET|PASSWORD|CREDENTIAL/i.test(key) || /^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  if (offline) env.NODE_OPTIONS = `--import=${pathToFileURL(join(root, "scripts/baseline/offline.mjs")).href}`;
  return { ...env, PATH: dirname(process.execPath) + delimiter + (env.PATH ?? ""),
    INNO_HOME: path, INNO_DATA_DIR: join(path, "data"), INNO_DESKTOP: "0", PI_CODING_AGENT_DIR: join(path, "config"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TZ: "Asia/Shanghai" };
}

// The locked jsdom requires this range; the project's root engines alone
// do not cover its test dependencies. Also probe SQLite/FTS5 at runtime.
export function supportsBaselineNode(version) {
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  return major >= 26 || (major === 24 && minor >= 15) ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)));
}

export function npmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) return realpathSync(process.env.npm_execpath);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
    if (existsSync(path) && process.platform !== "win32") return realpathSync(path);
  }
  throw new Error("Run this command through npm (npm run baseline:verify).");
}

export const requiredSuites = [
  "apps/clario/src/memory/learner/state-engine.test.ts",
  "apps/clario/src/agent/teaching-entry-agent.test.ts",
  "apps/clario/src/agent/pi-runner-context.test.ts",
  "apps/clario/src/mcp/mcp-config-store.test.ts",
  "apps/clario/src/mcp/cli-mcp.test.ts",
  "apps/clario/src/memory/l2/l2-tools.test.ts",
  "apps/clario/src/memory/l2/l2-search.test.ts",
  "apps/clario/src/memory/l3/l3.test.ts",
  "apps/clario/src/chat/stream-registry.test.ts",
  "apps/clario/src/server.smoke.test.ts",
  "apps/clario/src/scheduler/cron-utils.test.ts",
  "apps/clario/src/checkins/check-in-store.test.ts",
];

export function inspectTests(report, required = requiredSuites) {
  const results = report.testResults ?? [];
  const missing = [], incomplete = [];
  for (const name of required) {
    const suites = results.filter((r) => r.name.replaceAll("\\", "/").endsWith("/" + name) || r.name === name);
    const assertions = suites.flatMap((r) => r.assertionResults ?? []);
    if (!assertions.length) missing.push(name);
    else if (suites.some((r) => r.status !== "passed") || assertions.some((r) => r.status !== "passed")) incomplete.push(name);
  }
  return {
    passed: report.success === true && report.numFailedTests === 0 && report.numTotalTests > 0 && !missing.length && !incomplete.length,
    total: report.numTotalTests, passedTests: report.numPassedTests, failedTests: report.numFailedTests,
    skippedTests: report.numPendingTests, todoTests: report.numTodoTests, missing, incomplete,
  };
}

export function serverArgs(path, port) {
  return [join(root, "apps/clario/dist/server.js"), "--home", path,
    "--config", join(path, "config/config.json"), "--config-dir", join(path, "config"),
    "--data-dir", join(path, "data"), "--skills-dir", join(path, "skills"),
    "--workspace", join(path, "workspace"), "--port", String(port)];
}

export function currentCommit(directory = root) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // An initialized repository with no commits has exit status 1. Other Git
    // failures (e.g. not a repository) must remain visible to the verifier.
    if (error.status === 1) return "uncommitted";
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Fingerprint Clario dependency metadata and workspace declarations.
export function dependencyFingerprint(lock) {
  const external = {}, declarations = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const targetPath = path;
    if (/(^|\/)node_modules\//.test(path)) {
      if (!entry.link) external[targetPath] = entry;
    } else {
      declarations[targetPath] = Object.fromEntries(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "overrides"]
        .filter((key) => key in entry).map((key) => [key, entry[key]]));
    }
  }
  return { externalPackageCount: Object.keys(external).length,
    externalPackagesSha256: sha256(JSON.stringify(canonical(external))),
    dependencyDeclarationsSha256: sha256(JSON.stringify(canonical(declarations))) };
}

// Node may install a different Pi version for the web UI at the root. Resolve
// each backend package from its own workspace before comparing with the lock.
export function inspectInstalledDependencies(lock, names, fromDirectory = root, lockDirectory = root) {
  return names.map((name) => {
    try {
      const manifestPath = findPackageJSON(name, pathToFileURL(join(fromDirectory, "package.json")));
      if (!manifestPath) throw new Error("Package manifest could not be resolved");
      const lockPath = relative(lockDirectory, dirname(manifestPath)).replaceAll("\\", "/");
      return { name, resolvedFrom: relative(lockDirectory, fromDirectory) || ".", lockPath,
        locked: lock.packages[lockPath]?.version, installed: readJson(manifestPath).version };
    } catch (error) {
      return { name, resolvedFrom: relative(lockDirectory, fromDirectory) || ".", installed: null, error: error.message };
    }
  });
}


export function projectLockChecks(lockBytes, reference) {
  const actual = sha256(lockBytes);
  const fingerprint = dependencyFingerprint(JSON.parse(lockBytes.toString()));
  const expected = reference.dependencyFingerprint ?? {};
  const fields = ["externalPackageCount", "externalPackagesSha256", "dependencyDeclarationsSha256"];
  const valid = reference.schemaVersion === 1 && reference.project === "clario" &&
    /^[a-f0-9]{64}$/.test(reference.lockfileSha256 ?? "") &&
    Number.isInteger(expected.externalPackageCount) && expected.externalPackageCount > 0 &&
    fields.slice(1).every((key) => /^[a-f0-9]{64}$/.test(expected[key] ?? ""));
  return [
    { id: "clario-lockfile-pinned", status: valid && actual === reference.lockfileSha256 ? "passed" : "failed", expected: reference.lockfileSha256, actual },
    { id: "clario-dependencies-matched", status: valid && fields.every((key) => fingerprint[key] === expected[key]) ? "passed" : "failed", expected, actual: fingerprint },
  ];
}

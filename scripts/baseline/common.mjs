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
    defaultProvider: "baseline-dummy", defaultModel: "baseline-dummy-model",
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

// No provider credentials or inherited Inno paths enter the test subprocesses.
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

// Migration comparison always keeps the original reference manifest unchanged.
export function mapReferencePath(path, mappings = []) {
  const mapping = [...mappings].sort((a, b) => b.from.length - a.from.length)
    .find(({ from }) => path === from || path.startsWith(from + "/"));
  return mapping ? mapping.to + path.slice(mapping.from.length) : path;
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

export function inspectReferenceFiles(reference, directory, applicationPaths, mappings = []) {
  const source = { originalTree: reference.tree, pathMappings: mappings,
    changedReferenceFiles: [], changedSourceFiles: [], missingReferenceFiles: [] };
  for (const file of reference.files) {
    const path = join(directory, mapReferencePath(file.path, mappings));
    if (!existsSync(path)) source.missingReferenceFiles.push(file.path);
    else if (sha256(readFileSync(path)) !== file.sha256) {
      source.changedReferenceFiles.push(file.path);
      if (file.path.startsWith("apps/")) source.changedSourceFiles.push(file.path);
    }
  }
  const referencePaths = new Set(reference.files.map((file) => mapReferencePath(file.path, mappings)));
  source.addedApplicationFiles = [...new Set(applicationPaths)].filter((path) => path && !referencePaths.has(path));
  source.referenceApplicationUnchanged = !source.changedSourceFiles.length &&
    !source.missingReferenceFiles.some((path) => path.startsWith("apps/")) && !source.addedApplicationFiles.length;
  return source;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Workspace names/links can change during migration. Every external package's
// complete lock metadata (not only version) and local dependency declarations
// must retain the original content. Normalize only migrated directory prefixes.
export function dependencyFingerprint(lock, mappings = []) {
  const external = {}, declarations = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const targetPath = mapReferencePath(path, mappings);
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

export function migrationLockChecks(lockBytes, migration, dependencyReference) {
  const actual = sha256(lockBytes);
  const fingerprint = dependencyFingerprint(JSON.parse(lockBytes.toString()), migration.pathMappings);
  const fields = ["externalPackageCount", "externalPackagesSha256", "dependencyDeclarationsSha256"];
  return [
    { id: "lockfile-migration-pinned", status: actual === migration.targetLockfileSha256 ? "passed" : "failed",
      expected: migration.targetLockfileSha256, actual, original: migration.sourceLockfileSha256,
      note: "The lockfile was renamed for Clario; this does not assert original lockfile bytes are unchanged." },
    { id: "external-dependencies-unchanged", status: dependencyReference.sourceLockfileSha256 === migration.sourceLockfileSha256 &&
        fields.every((key) => fingerprint[key] === dependencyReference[key]) ? "passed" : "failed",
      originalLockfileSha256: dependencyReference.sourceLockfileSha256, expected: Object.fromEntries(fields.map((key) => [key, dependencyReference[key]])), actual: fingerprint },
  ];
}

// The migration snapshot remains historical evidence. An explicitly recorded
// upgrade pins the next lockfile and its normalized upstream dependency graph.
export function upgradeLockChecks(lockBytes, migration, upgrade) {
  const actual = sha256(lockBytes);
  const fingerprint = dependencyFingerprint(JSON.parse(lockBytes.toString()), upgrade.pathMappings ?? []);
  const fields = ["externalPackageCount", "externalPackagesSha256", "dependencyDeclarationsSha256"];
  const expected = upgrade.upstream?.dependencyFingerprint ?? {};
  const validSha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
  const validReference = upgrade.schemaVersion === 1 && typeof upgrade.id === "string" && upgrade.id.length > 0 &&
    validSha(upgrade.previousLockfileSha256, 64) && validSha(upgrade.targetLockfileSha256, 64) &&
    validSha(upgrade.upstream?.commit, 40) && validSha(upgrade.upstream?.lockfileSha256, 64) &&
    Number.isInteger(expected.externalPackageCount) && expected.externalPackageCount > 0 &&
    validSha(expected.externalPackagesSha256, 64) && validSha(expected.dependencyDeclarationsSha256, 64);
  return [
    { id: "dependency-upgrade-lineage", status: validReference &&
        upgrade.previousLockfileSha256 === migration.targetLockfileSha256 &&
        JSON.stringify(canonical(upgrade.pathMappings)) === JSON.stringify(canonical(migration.pathMappings)) ? "passed" : "failed",
      previousLockfileSha256: upgrade.previousLockfileSha256, migrationLockfileSha256: migration.targetLockfileSha256,
      upstreamCommit: upgrade.upstream?.commit, upstreamLockfileSha256: upgrade.upstream?.lockfileSha256,
      note: "The original migration lock remains a historical baseline; current dependencies follow this recorded upstream upgrade." },
    { id: "lockfile-upgrade-pinned", status: actual === upgrade.targetLockfileSha256 ? "passed" : "failed",
      expected: upgrade.targetLockfileSha256, actual },
    { id: "upstream-dependencies-matched", status: fields.every((key) => fingerprint[key] === expected[key]) ? "passed" : "failed",
      upstreamLockfileSha256: upgrade.upstream?.lockfileSha256, expected, actual: fingerprint,
      note: "Compares all external lock metadata and dependency declarations with the recorded upstream version, allowing only workspace path renames." },
  ];
}

export function upgradeEvidenceCheck(upgrade, directory) {
  const required = ["docs/migration/source-manifest.json", "docs/migration/dependency-lock-reference.json"];
  const evidence = upgrade.preservedEvidence ?? [];
  const missing = required.filter((path) => !evidence.some((file) => file.path === path));
  const changed = evidence.filter((file) => !existsSync(join(directory, file.path)) ||
    sha256(readFileSync(join(directory, file.path))) !== file.sha256).map((file) => file.path);
  return { id: "migration-evidence-preserved", status: !missing.length && !changed.length ? "passed" : "failed",
    checkedFiles: evidence.length, missingReferences: missing, changedFiles: changed };
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

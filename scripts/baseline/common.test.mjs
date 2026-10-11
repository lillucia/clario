import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTests, isolatedEnv, supportsBaselineNode, dependencyFingerprint, projectLockChecks, inspectInstalledDependencies, currentCommit, sha256 } from "./common.mjs";

const file = "apps/clario/src/memory/l3/l3.test.ts";
function report(status = "passed") {
  return { success: true, numFailedTests: 0, numTotalTests: 2, numPassedTests: 2, numPendingTests: 0,
    testResults: [{ name: `/checkout/${file}`, status: "passed", assertionResults: [{ status: "passed" }, { status }] }] };
}
test("accepts completed required suites", () => assert.equal(inspectTests(report(), [file]).passed, true));
test("rejects an otherwise green run whose L3 assertions skipped", () => {
  const result = inspectTests(report("pending"), [file]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.incomplete, [file]);
});
test("rejects missing or empty required suites", () => {
  assert.equal(inspectTests({ ...report(), testResults: [] }, [file]).passed, false);
  assert.equal(inspectTests({ ...report(), numTotalTests: 0 }, []).passed, false);
});
test("rejects failed test process report", () => assert.equal(inspectTests({ ...report(), success: false }, [file]).passed, false));

test("rejects Node versions outside the locked dependency engine range", () => {
  for (const version of ["20.20.0", "22.16.0", "22.22.1", "24.14.0", "25.2.1"]) assert.equal(supportsBaselineNode(version), false, version);
  for (const version of ["22.22.2", "22.23.0", "24.15.0", "v24.19.0", "26.0.0"]) assert.equal(supportsBaselineNode(version), true, version);
});

test("isolates data and removes inherited credentials and Node preload flags", () => {
  const values = { GH_TOKEN: "synthetic", GITHUB_TOKEN: "synthetic", AWS_ACCESS_KEY_ID: "synthetic", AWS_SESSION_TOKEN: "synthetic", NODE_OPTIONS: "--require=/synthetic/user-code.cjs", INNO_CONFIG_FILE: "/synthetic/personal/config.json" };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const env = isolatedEnv("/synthetic/baseline");
    for (const key of Object.keys(values).filter((key) => key !== "NODE_OPTIONS")) assert.equal(env[key], undefined, key);
    assert.equal(env.INNO_DATA_DIR, "/synthetic/baseline/data");
    assert.match(env.NODE_OPTIONS, /\/scripts\/baseline\/offline\.mjs$/);
    assert.equal(isolatedEnv("/synthetic/baseline", { offline: false }).NODE_OPTIONS, undefined);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("new Git repositories without HEAD report uncommitted but invalid repositories still fail", () => {
  const directory = mkdtempSync(join(tmpdir(), "clario-git-"));
  try {
    assert.throws(() => currentCommit(directory));
    execFileSync("git", ["init", "--quiet", directory], { stdio: "pipe" });
    assert.equal(currentCommit(directory), "uncommitted");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("dependency verification resolves the backend's nested package instead of the root UI dependency", () => {
  const directory = mkdtempSync(join(tmpdir(), "clario-installed-deps-"));
  try {
    const workspace = join(directory, "apps/clario");
    mkdirSync(workspace, { recursive: true });
    for (const dir of [directory, workspace]) writeFileSync(join(dir, "package.json"), "{}");
    const packagePaths = ["node_modules/sdk-fixture", "apps/clario/node_modules/sdk-fixture"];
    packagePaths.forEach((path, index) => {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, "package.json"), JSON.stringify({ name: "sdk-fixture", version: `${index + 1}.0.0`, main: "index.js" }));
      writeFileSync(join(directory, path, "index.js"), "");
    });
    const lock = { packages: Object.fromEntries(packagePaths.map((path, index) => [path, { version: `${index + 1}.0.0` }])) };
    const [resolved] = inspectInstalledDependencies(lock, ["sdk-fixture"], workspace, directory);
    assert.equal(resolved.lockPath, packagePaths[1]);
    assert.equal(resolved.installed, "2.0.0");
    assert.equal(resolved.locked, "2.0.0");
    assert.equal(inspectInstalledDependencies(lock, ["not-installed-fixture"], workspace, directory)[0].installed, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Clario baseline detects byte drift, dependency drift and invalid project references", () => {
  const lock = { packages: { "": { dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0", integrity: "sha512-fixture" } } };
  const bytes = JSON.stringify(lock);
  const reference = { schemaVersion: 1, project: "clario", lockfileSha256: sha256(bytes), dependencyFingerprint: dependencyFingerprint(lock) };
  assert.deepEqual(projectLockChecks(bytes, reference).map(({ status }) => status), ["passed", "passed"]);
  assert.deepEqual(projectLockChecks(bytes + " ", reference).map(({ status }) => status), ["failed", "passed"]);
  lock.packages["node_modules/fixture"].version = "2.0.0";
  const changed = JSON.stringify(lock);
  assert.deepEqual(projectLockChecks(changed, { ...reference, lockfileSha256: sha256(changed) }).map(({ status }) => status), ["passed", "failed"]);
  assert.deepEqual(projectLockChecks(bytes, { ...reference, project: "other" }).map(({ status }) => status), ["failed", "failed"]);
});

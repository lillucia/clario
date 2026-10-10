import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTests, isolatedEnv, supportsBaselineNode, mapReferencePath, inspectReferenceFiles, dependencyFingerprint, migrationLockChecks, upgradeLockChecks, upgradeEvidenceCheck, inspectInstalledDependencies, currentCommit, sha256 } from "./common.mjs";

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

const mappings = [{ from: "apps/inno-agent", to: "apps/clario" }];
test("migration remaps directory boundaries and prefers the most specific mapping", () => {
  assert.equal(mapReferencePath("apps/inno-agent/src/file.ts", mappings), "apps/clario/src/file.ts");
  assert.equal(mapReferencePath("apps/inno-agent", mappings), "apps/clario");
  assert.equal(mapReferencePath("apps/inno-agent-other/file.ts", mappings), "apps/inno-agent-other/file.ts");
  assert.equal(mapReferencePath("apps/inno-agent/web/file.ts", [...mappings, { from: "apps/inno-agent/web", to: "ui" }]), "ui/file.ts");
});

test("source comparison follows migrated paths without hiding source changes or additions", () => {
  const directory = mkdtempSync(join(tmpdir(), "clario-reference-"));
  try {
    mkdirSync(join(directory, "apps/clario/src"), { recursive: true });
    writeFileSync(join(directory, "apps/clario/src/file.ts"), "original");
    const reference = { tree: "original-tree", files: [{ path: "apps/inno-agent/src/file.ts", sha256: sha256("original") }] };
    const paths = ["apps/clario/src/file.ts"];
    assert.equal(inspectReferenceFiles(reference, directory, paths, mappings).referenceApplicationUnchanged, true);
    writeFileSync(join(directory, paths[0]), "modified");
    const changed = inspectReferenceFiles(reference, directory, [...paths, "apps/clario/src/new.ts"], mappings);
    assert.deepEqual(changed.changedSourceFiles, ["apps/inno-agent/src/file.ts"]);
    assert.deepEqual(changed.addedApplicationFiles, ["apps/clario/src/new.ts"]);
    assert.deepEqual(changed.missingReferenceFiles, []);
    assert.equal(changed.referenceApplicationUnchanged, false);
    rmSync(join(directory, paths[0]));
    assert.deepEqual(inspectReferenceFiles(reference, directory, [], mappings).missingReferenceFiles, ["apps/inno-agent/src/file.ts"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const originalLock = { name: "inno-agent", packages: {
  "": { name: "inno-agent", workspaces: ["apps/inno-agent"], devDependencies: { vitest: "^3.2.4" } },
  "apps/inno-agent": { dependencies: { "some-package": "^1.0.0" } },
  "node_modules/inno-agent": { link: true, resolved: "apps/inno-agent" },
  "node_modules/some-package": { version: "1.0.1", integrity: "sha512-original", resolved: "https://registry.example/package.tgz" },
  "apps/inno-agent/node_modules/nested-package": { version: "2.0.0", optional: true },
} };
function renamedLock() {
  const lock = structuredClone(originalLock);
  lock.name = "clario";
  lock.packages[""].name = "clario";
  lock.packages[""].workspaces = ["apps/clario"];
  for (const path of Object.keys(lock.packages)) {
    const renamed = mapReferencePath(path, mappings);
    if (renamed !== path) { lock.packages[renamed] = lock.packages[path]; delete lock.packages[path]; }
  }
  lock.packages["node_modules/clario"] = { link: true, resolved: "apps/clario" };
  delete lock.packages["node_modules/inno-agent"];
  return lock;
}

test("dependency fingerprints allow workspace renames and JSON key reordering", () => {
  const renamed = renamedLock();
  renamed.packages = Object.fromEntries(Object.entries(renamed.packages).reverse());
  assert.deepEqual(dependencyFingerprint(originalLock, mappings), dependencyFingerprint(renamed, mappings));
});

test("dependency fingerprints detect versions, integrity, metadata, additions and declaration drift", () => {
  const original = dependencyFingerprint(originalLock, mappings);
  for (const change of [
    (lock) => { lock.packages["node_modules/some-package"].version = "2.0.0"; },
    (lock) => { lock.packages["node_modules/some-package"].integrity = "sha512-replaced"; },
    (lock) => { lock.packages["node_modules/some-package"].resolved = "https://different.example/package.tgz"; },
    (lock) => { lock.packages["apps/clario/node_modules/nested-package"].optional = false; },
    (lock) => { lock.packages["node_modules/new"] = { version: "1.0.0" }; },
    (lock) => { lock.packages["apps/clario"].dependencies["some-package"] = "^2.0.0"; },
  ]) {
    const lock = renamedLock(); change(lock);
    assert.notDeepEqual(dependencyFingerprint(lock, mappings), original);
  }
});

test("migration lock checks pin target bytes separately from unchanged external dependencies", () => {
  const originalBytes = JSON.stringify(originalLock), bytes = JSON.stringify(renamedLock());
  const migration = { pathMappings: mappings, sourceLockfileSha256: sha256(originalBytes), targetLockfileSha256: sha256(bytes) };
  const dependencyReference = { sourceLockfileSha256: migration.sourceLockfileSha256, ...dependencyFingerprint(originalLock, mappings) };
  const checks = migrationLockChecks(bytes, migration, dependencyReference);
  assert.equal(checks[0].id, "lockfile-migration-pinned");
  assert.notEqual(checks[0].original, checks[0].actual);
  assert.deepEqual(checks.map(({ status }) => status), ["passed", "passed"]);
  assert.deepEqual(migrationLockChecks(bytes + " ", migration, dependencyReference).map(({ status }) => status), ["failed", "passed"]);
  assert.equal(migrationLockChecks(bytes, migration, { ...dependencyReference, sourceLockfileSha256: "wrong-source" })[1].status, "failed");
  const drift = renamedLock(); drift.packages["node_modules/some-package"].version = "9.0.0";
  const changedBytes = JSON.stringify(drift);
  assert.deepEqual(migrationLockChecks(changedBytes, { ...migration, targetLockfileSha256: sha256(changedBytes) }, dependencyReference).map(({ status }) => status), ["passed", "failed"]);
});

test("new Git repositories without HEAD report uncommitted but invalid repositories still fail", () => {
  const directory = mkdtempSync(join(tmpdir(), "clario-git-"));
  try {
    assert.throws(() => currentCommit(directory));
    execFileSync("git", ["init", "--quiet", directory], { stdio: "pipe" });
    assert.equal(currentCommit(directory), "uncommitted");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function upgradedFixture() {
  const previousBytes = JSON.stringify(renamedLock());
  const upstreamLock = structuredClone(originalLock);
  upstreamLock.packages["node_modules/some-package"].version = "2.0.0";
  upstreamLock.packages["node_modules/some-package"].integrity = "sha512-upstream-upgrade";
  upstreamLock.packages["apps/inno-agent"].dependencies["some-package"] = "^2.0.0";
  const lock = renamedLock();
  lock.packages["node_modules/some-package"] = structuredClone(upstreamLock.packages["node_modules/some-package"]);
  lock.packages["apps/clario"].dependencies["some-package"] = "^2.0.0";
  const bytes = JSON.stringify(lock);
  const migration = { pathMappings: mappings, sourceLockfileSha256: sha256(JSON.stringify(originalLock)), targetLockfileSha256: sha256(previousBytes) };
  const upgrade = { schemaVersion: 1, id: "pi-0.99.2", previousLockfileSha256: migration.targetLockfileSha256,
    targetLockfileSha256: sha256(bytes), pathMappings: mappings, upstream: { commit: "a".repeat(40),
      lockfileSha256: sha256(JSON.stringify(upstreamLock)), dependencyFingerprint: dependencyFingerprint(upstreamLock, mappings) } };
  return { migration, upgrade, bytes, lock };
}

test("recorded upgrades accept upstream changes while preserving the original migration baseline", () => {
  const { migration, upgrade, bytes } = upgradedFixture();
  assert.deepEqual(upgradeLockChecks(bytes, migration, upgrade).map(({ status }) => status), ["passed", "passed", "passed"]);
  const originalReference = { sourceLockfileSha256: migration.sourceLockfileSha256, ...dependencyFingerprint(originalLock, mappings) };
  assert.deepEqual(migrationLockChecks(bytes, migration, originalReference).map(({ status }) => status), ["failed", "failed"]);
  assert.equal(upgradeLockChecks(bytes, migration, upgrade).some(({ id }) => id === "external-dependencies-unchanged"), false);
});

test("recorded upgrades reject a broken chain, path remapping drift, or incomplete provenance", () => {
  const { migration, upgrade, bytes } = upgradedFixture();
  for (const invalid of [
    { ...upgrade, previousLockfileSha256: "b".repeat(64) },
    { ...upgrade, pathMappings: [] },
    { ...upgrade, schemaVersion: 999 },
    { ...upgrade, upstream: { ...upgrade.upstream, commit: undefined } },
    { ...upgrade, upstream: { ...upgrade.upstream, lockfileSha256: undefined } },
  ]) assert.equal(upgradeLockChecks(bytes, migration, invalid)[0].status, "failed");
});

test("recorded upgrades detect lock-byte and external-metadata drift independently", () => {
  const { migration, upgrade, bytes, lock } = upgradedFixture();
  assert.deepEqual(upgradeLockChecks(bytes + " ", migration, upgrade).map(({ status }) => status), ["passed", "failed", "passed"]);
  lock.packages["node_modules/some-package"].integrity = "sha512-unapproved";
  const drift = JSON.stringify(lock);
  assert.deepEqual(upgradeLockChecks(drift, migration, { ...upgrade, targetLockfileSha256: sha256(drift) }).map(({ status }) => status), ["passed", "passed", "failed"]);
});

test("upgrade evidence requires and verifies both historical migration manifests", () => {
  const directory = mkdtempSync(join(tmpdir(), "clario-upgrade-evidence-"));
  try {
    mkdirSync(join(directory, "docs/migration"), { recursive: true });
    const paths = ["docs/migration/source-manifest.json", "docs/migration/dependency-lock-reference.json"];
    for (const path of paths) writeFileSync(join(directory, path), "original migration evidence");
    const preservedEvidence = paths.map((path) => ({ path, sha256: sha256("original migration evidence") }));
    assert.equal(upgradeEvidenceCheck({ preservedEvidence }, directory).status, "passed");
    assert.equal(upgradeEvidenceCheck({ preservedEvidence: preservedEvidence.slice(0, 1) }, directory).status, "failed");
    writeFileSync(join(directory, paths[0]), "rewritten baseline");
    assert.deepEqual(upgradeEvidenceCheck({ preservedEvidence }, directory).changedFiles, [paths[0]]);
    rmSync(join(directory, paths[1]));
    assert.deepEqual(upgradeEvidenceCheck({ preservedEvidence }, directory).changedFiles, paths);
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

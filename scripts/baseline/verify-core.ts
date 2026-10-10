/**
 * Offline, synthetic-data acceptance checks against the unmodified Inno source.
 * Run: node --import tsx scripts/baseline/verify-core.ts --output /tmp/core.json
 *
 * L2 deliberately exercises the existing no-model Markdown ingest branch. It
 * verifies storage, provenance, deduplication and indexed retrieval; it does
 * not claim to evaluate LLM summaries or teaching quality. No SDK mocks are used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CheckResult = {
	id: string;
	status: "pass" | "fail";
	details?: unknown;
	error?: { name: string; message: string };
};
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean };
type CallableTool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
	console.error("Usage: node --import tsx scripts/baseline/verify-core.ts --output <report.json>");
	process.exit(2);
}
const outputPath = resolve(args[1]);
const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "inno-core-baseline-"));
const results: CheckResult[] = [];
const closers: Array<() => void> = [];
const savedEnv = new Map<string, string | undefined>();
for (const [key, value] of Object.entries({
	INNO_HOME: tempRoot,
	INNO_DATA_DIR: join(tempRoot, "data"),
	INNO_CONFIG_DIR: join(tempRoot, "config"),
	INNO_CONFIG_FILE: join(tempRoot, "config", "config.json"),
	INNO_WORKSPACE_DIR: join(tempRoot, "workspace"),
	INNO_SKILLS_DIR: join(tempRoot, "skills"),
	PI_CODING_AGENT_DIR: join(tempRoot, "config"),
	PI_CODING_AGENT_SESSION_DIR: join(tempRoot, "sessions"),
	LOG_LEVEL: "silent",
})) {
	savedEnv.set(key, process.env[key]);
	process.env[key] = value;
}

// A future accidental provider call must fail, even if its error is swallowed.
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = async () => {
	fetchAttempts += 1;
	throw new Error("Network fetch is forbidden in the offline core baseline");
};

function errorData(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "Error", message: String(error) };
}

async function check(id: string, run: () => unknown | Promise<unknown>): Promise<void> {
	try {
		results.push({ id, status: "pass", details: await run() });
	} catch (error) {
		results.push({ id, status: "fail", error: errorData(error) });
	}
}

function findTool(tools: unknown, name: string): CallableTool {
	const tool = (tools as CallableTool[]).find((entry) => entry.name === name);
	assert.ok(tool, `Production tool ${name} was not registered`);
	return tool;
}

async function invoke(tool: CallableTool, params: unknown): Promise<ToolResult> {
	const result = await tool.execute("baseline-call", params, undefined, undefined, {
		model: undefined,
		modelRegistry: undefined,
	});
	assert.notEqual(result.isError, true, `${tool.name} returned isError`);
	assert.equal(result.details?.error, undefined, `${tool.name} returned an error detail`);
	return result;
}

const fixedTime = new Date("2026-08-10T00:00:00.000Z");
const conceptId = "baseline.spaced_retrieval";

try {
	await check("runtime.sqlite_fts5", () => {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (path: string) => {
				exec(sql: string): void;
				prepare(sql: string): { get(): { count: number } };
				close(): void;
			};
		};
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE VIRTUAL TABLE baseline_fts USING fts5(content)");
			db.exec("INSERT INTO baseline_fts(content) VALUES ('baseline retrieval')");
			const hit = db.prepare("SELECT count(*) AS count FROM baseline_fts WHERE baseline_fts MATCH 'retrieval'").get();
			assert.equal(hit.count, 1);
			return { sqlite: true, fts5CreateAndMatch: true };
		} finally {
			db.close();
		}
	});

	await check("l1.exposure_does_not_increase_mastery", async () => {
		const { createLearningEvidenceEvent } = await import("../../apps/clario/src/memory/learner/evidence.js");
		const { projectKnowledgeState } = await import("../../apps/clario/src/memory/learner/state-engine.js");
		const baseline = projectKnowledgeState(undefined, conceptId, [], { asOf: fixedTime });
		const exposure = createLearningEvidenceEvent("baseline-learner", {
			concept_id: conceptId, kind: "exposure", result: "correct", score: 1,
			evaluator: "deterministic", evaluator_confidence: 1,
		}, fixedTime);
		assert.ok(exposure.evidence);
		const state = projectKnowledgeState(undefined, conceptId, [exposure.evidence], { asOf: fixedTime });
		assert.equal(state.mastery, baseline.mastery);
		assert.equal(state.exposure_count, 1);
		assert.equal(state.retrieval_count, 0);
		assert.equal(state.last_successful_retrieval_at, undefined);
		assert.equal(state.state_label, "learning");
		return { initialMastery: baseline.mastery, afterExposure: state.mastery, exposureCount: state.exposure_count, state: state.state_label };
	});

	await check("l1.evidence_tool_deduplicates_retries", async () => {
		const { createLearnerTools } = await import("../../apps/clario/src/memory/learner/learner-tools.js");
		const { loadEvents, loadProfile } = await import("../../apps/clario/src/memory/learner/profile-store.js");
		const dataDir = join(tempRoot, "l1-dedupe");
		const tool = findTool(createLearnerTools(dataDir, "baseline-learner"), "record_learning_evidence");
		const params = {
			concept_id: conceptId, kind: "free_recall", result: "correct", hint_level: 0,
			evaluator: "model", evaluator_confidence: 1, dedupe_key: "baseline-retrieval-1",
		};
		// The model-facing tool may not claim trusted programmatic grading.
		// Internal projection fixtures below still exercise deterministic evidence.
		await assert.rejects(invoke(tool, { ...params, evaluator: "deterministic" }), /evaluator/);
		assert.equal(loadEvents(dataDir).length, 0);
		await invoke(tool, params);
		const firstProfile = loadProfile(dataDir);
		const duplicate = await invoke(tool, params);
		const events = loadEvents(dataDir);
		assert.equal(duplicate.details?.duplicate, true);
		assert.equal(events.length, 1);
		assert.deepEqual(loadProfile(dataDir), firstProfile);
		assert.equal(firstProfile.knowledge_states[0]?.retrieval_count, 1);
		return { eventCount: events.length, duplicateReported: true, profileUnchanged: true, retrievalCount: 1 };
	});

	await check("l1.persisted_projection_is_idempotent_and_decays", async () => {
		const { createLearningEvidenceEvent } = await import("../../apps/clario/src/memory/learner/evidence.js");
		const { recordEventAndUpdateProfile, loadEvents, loadProfile, saveProfile } = await import("../../apps/clario/src/memory/learner/profile-store.js");
		const { applyDerivedKnowledgeState, projectLearnerKnowledge } = await import("../../apps/clario/src/memory/learner/state-engine.js");
		const dataDir = join(tempRoot, "l1-projection");
		const event = createLearningEvidenceEvent("baseline-learner", {
			concept_id: conceptId, kind: "application", result: "correct", hint_level: 0,
			evaluator: "deterministic", evaluator_confidence: 1, dedupe_key: "baseline-projection-1",
		}, fixedTime);
		const profile = recordEventAndUpdateProfile(dataDir, event);
		const events = loadEvents(dataDir);
		const state = projectLearnerKnowledge(profile, events, fixedTime).find((item) => item.concept_id === conceptId);
		assert.ok(state);
		assert.ok(state.mastery > 0.05);
		assert.equal(state.retrieval_count, 1);
		assert.equal(applyDerivedKnowledgeState(profile, state), true);
		saveProfile(dataDir, profile);
		const reloaded = loadProfile(dataDir);
		const repeated = projectLearnerKnowledge(reloaded, loadEvents(dataDir), fixedTime).find((item) => item.concept_id === conceptId);
		assert.deepEqual(repeated, state);
		const later = projectLearnerKnowledge(reloaded, events, new Date("2026-09-10T00:00:00.000Z"))
			.find((item) => item.concept_id === conceptId);
		assert.ok(later);
		assert.ok(later.retrievability! < state.retrievability!);
		assert.equal(later.mastery, state.mastery);
		assert.equal(later.state_label, "review_due");
		return { mastery: state.mastery, replayUnchanged: true, immediateRetrievability: state.retrievability, laterRetrievability: later.retrievability, laterState: later.state_label };
	});

	// Cache one real archive operation, then inspect it through independent checks.
	let archivePromise: Promise<{
		dataDir: string; content: string; tools: CallableTool[];
		memory: import("../../apps/clario/src/memory/l2/l2-memory.js").L2Memory;
	}> | undefined;
	const archivedSource = () => archivePromise ??= (async () => {
		const { createL2Tools } = await import("../../apps/clario/src/memory/l2/l2-tools.js");
		const { L2Memory } = await import("../../apps/clario/src/memory/l2/l2-memory.js");
		const dataDir = join(tempRoot, "l2");
		const memory = new L2Memory(dataDir);
		closers.push(() => memory.close());
		const tools = createL2Tools(dataDir, undefined, memory) as unknown as CallableTool[];
		const content = readFileSync(join(fixtureDir, "learning-source.md"), "utf8");
		await invoke(findTool(tools, "l2_archive"), {
			title: "Baseline Learning Source", sourceIdentity: "learning-source.md", content,
			sourceType: "markdown", tags: ["baseline"], origin: "user_upload",
		});
		return { dataDir, content, tools, memory };
	})();

	await check("l2.archive_preserves_raw_and_source_chain", async () => {
		const { dataDir, content } = await archivedSource();
		const { readManifest } = await import("../../apps/clario/src/memory/l2/manifest-store.js");
		const { parseFrontmatter } = await import("../../apps/clario/src/memory/l2/wiki-maintainer.js");
		const entries = readManifest(dataDir);
		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.equal(entry.status, "indexed");
		assert.equal(entry.source.identity, "learning-source.md");
		const hash = createHash("sha256").update(content).digest("hex");
		assert.equal(entry.contentHash, hash.slice(0, 16));
		const raw = readFileSync(join(dataDir, entry.rawPath), "utf8");
		assert.ok(raw.endsWith(content), "Raw payload must preserve the entire fixture");
		assert.ok(raw.includes(hash), "Raw metadata must contain the source hash");
		assert.ok(entry.extractedPath);
		const extracted = readFileSync(join(dataDir, entry.extractedPath), "utf8");
		assert.ok(extracted.includes("baseline_retrieval_marker"));
		assert.ok(entry.wikiPages.length >= 1);
		for (const pagePath of entry.wikiPages) {
			const page = readFileSync(join(dataDir, pagePath), "utf8");
			assert.ok(parseFrontmatter(page).frontmatter?.source_ids.includes(entry.id), `${pagePath} lost its source ID`);
		}
		return { mode: "production-no-model-markdown-ingest", rawPayloadPreserved: true, sha256: hash, sourceCount: entries.length, wikiPageCount: entry.wikiPages.length, allPagesTraceable: true };
	});

	await check("l2.query_uses_index_and_returns_provenance", async () => {
		const { dataDir, tools, memory } = await archivedSource();
		assert.ok(await memory.getStore(), "L2 SQLite index unavailable: substring fallback is not accepted by this baseline");
		const result = await invoke(findTool(tools, "l2_query"), { query: "baseline_retrieval_marker" });
		const { readManifest } = await import("../../apps/clario/src/memory/l2/manifest-store.js");
		const sourceId = readManifest(dataDir)[0].id;
		const hits = result.details?.hits as Array<{ path: string; sourceIds: string[]; via: string[] }> | undefined;
		assert.equal(result.details?.mode, "indexed");
		assert.ok(hits?.length);
		assert.ok(hits.some((hit) => hit.sourceIds.includes(sourceId)));
		assert.ok(result.content.some((block) => block.text?.includes("baseline_retrieval_marker")));
		return { mode: result.details.mode, hitCount: hits.length, sourceIdResolved: true, retrievalPaths: hits.map((hit) => ({ path: hit.path, via: hit.via })) };
	});

	await check("l2.repeated_archive_is_deduplicated", async () => {
		const { dataDir, content, tools } = await archivedSource();
		const { readManifest } = await import("../../apps/clario/src/memory/l2/manifest-store.js");
		const before = readManifest(dataDir);
		const result = await invoke(findTool(tools, "l2_archive"), {
			title: "Baseline Learning Source", sourceIdentity: "learning-source.md", content,
			sourceType: "markdown", tags: ["baseline"], origin: "user_upload",
		});
		assert.equal(result.details?.duplicate, true);
		assert.deepEqual(readManifest(dataDir), before);
		return { sourceCount: before.length, duplicateReported: true, manifestUnchanged: true };
	});

	let l3Promise: Promise<{
		store: import("../../apps/clario/src/memory/l3/sqlite-store.js").L3Store;
		sessionDir: string;
	}> | undefined;
	const indexedSessions = () => l3Promise ??= (async () => {
		const { openL3Store } = await import("../../apps/clario/src/memory/l3/sqlite-store.js");
		const { indexAllSessions } = await import("../../apps/clario/src/memory/l3/indexer.js");
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		for (const name of ["history.jsonl", "current.jsonl", "unrelated.jsonl"]) {
			copyFileSync(join(fixtureDir, name), join(sessionDir, name));
		}
		const store = await openL3Store(join(tempRoot, "l3"));
		assert.ok(store, "L3 SQLite/FTS5 store unavailable: disabled recall is a baseline failure");
		closers.push(() => store.close());
		const indexed = indexAllSessions(store, sessionDir);
		assert.equal(indexed.sessions, 3);
		assert.ok(indexed.chunks >= 3);
		return { store, sessionDir };
	})();

	await check("l3.cross_session_recall_excludes_current", async () => {
		const { store } = await indexedSessions();
		const { recall } = await import("../../apps/clario/src/memory/l3/recall.js");
		assert.ok(store.searchLexical("机器学习").some((hit) => hit.sessionId === "current.jsonl"), "Fixture must contain a matching current session");
		const hits = recall(store, "机器学习", { excludeSessionId: "current.jsonl" });
		assert.ok(hits.length > 0);
		assert.ok(hits.every((hit) => hit.sessionId === "history.jsonl"));
		assert.ok(hits.every((hit) => hit.score >= 0.5));
		return { hitCount: hits.length, sessionIds: [...new Set(hits.map((hit) => hit.sessionId))], activeSessionExcluded: true };
	});

	await check("l3.unrelated_and_below_threshold_queries_are_filtered", async () => {
		const { store } = await indexedSessions();
		const { recall, formatRecallForPrompt } = await import("../../apps/clario/src/memory/l3/recall.js");
		const partialQuery = "机器学习 海洋潜水摄影 跳伞";
		const candidates = store.searchLexical(partialQuery);
		assert.ok(candidates.length > 0, "Partial-overlap fixture must exercise the coverage filter");
		const partial = recall(store, partialQuery);
		const absent = recall(store, "海洋潜水摄影");
		assert.equal(partial.length, 0);
		assert.equal(absent.length, 0);
		assert.equal(formatRecallForPrompt(partial), "");
		return { partialOverlapCandidateCount: candidates.length, afterCoverageFilter: partial.length, unrelatedHitCount: absent.length, injectedText: "" };
	});

	await check("l3.index_ignores_tool_noise_and_is_idempotent", async () => {
		const { store, sessionDir } = await indexedSessions();
		const { indexSession } = await import("../../apps/clario/src/memory/l3/indexer.js");
		const before = store.chunkCount();
		assert.equal(store.searchLexical("baseline_tool_only_sentinel").length, 0);
		assert.equal(store.searchLexical("baseline_thinking_only_sentinel").length, 0);
		assert.equal(indexSession(store, join(sessionDir, "history.jsonl")), 0);
		assert.equal(store.chunkCount(), before);
		return { chunkCount: before, unchangedFileReindexedChunks: 0, toolAndThinkingNoiseExcluded: true };
	});

	await check("isolation.no_fetch_requests", () => {
		assert.equal(fetchAttempts, 0, "An offline check attempted a network fetch");
		return { fetchAttempts, inputData: "committed synthetic fixtures only" };
	});
} finally {
	for (const close of closers.reverse()) {
		try { close(); } catch (error) { results.push({ id: "cleanup.close_store", status: "fail", error: errorData(error) }); }
	}
	try { rmSync(tempRoot, { recursive: true, force: true }); }
	catch (error) { results.push({ id: "cleanup.temp_directory", status: "fail", error: errorData(error) }); }
	globalThis.fetch = originalFetch;
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const passed = results.filter((result) => result.status === "pass").length;
	const failed = results.length - passed;
	const report = {
		schemaVersion: 1,
		kind: "inno-offline-core-baseline",
		generatedAt: new Date().toISOString(),
		status: failed === 0 ? "pass" : "fail",
		runtime: { node: process.version, platform: process.platform, arch: process.arch },
		scope: {
			implementation: "existing source modules; no business-code changes or SDK mocks",
			l2: "existing no-model Markdown archive branch; no LLM quality evaluation",
			data: "synthetic fixtures in an isolated temporary directory",
			sqlitePolicy: "node:sqlite plus a real FTS5 CREATE/MATCH probe required; never skip",
		},
		summary: { total: results.length, passed, failed },
		checks: results,
	};
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(JSON.stringify({ status: report.status, ...report.summary, output: outputPath }));
	process.exitCode = failed === 0 ? 0 : 1;
}

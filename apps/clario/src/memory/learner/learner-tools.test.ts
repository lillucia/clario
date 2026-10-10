import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLearningEvidenceEvent } from "./evidence.js";
import { createLearnerTools } from "./learner-tools.js";
import { loadEvents, loadProfile, recordEvent, recordEventAndUpdateProfile } from "./profile-store.js";
import { createLearningEvent } from "./types.js";

let root: string;
let dataDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "inno-learner-tools-"));
	dataDir = join(root, "learner");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const validParams = {
	concept_id: "python.binary_search_half_open",
	kind: "application",
	result: "correct",
	hint_level: 0,
	evaluator: "rubric",
	evaluator_confidence: 0.8,
	dedupe_key: "session-1:exercise-1:answer-1",
};

function evidenceTool(isEnabled?: () => boolean): ToolDefinition {
	return createLearnerTools(dataDir, "synthetic-learner", isEnabled)
		.find((tool) => tool.name === "record_learning_evidence")!;
}

// Deliberately bypass SDK schema validation to exercise the execute boundary
// used by direct callers and stale argument replay.
function execute(tool: ToolDefinition, overrides: Record<string, unknown> = {}) {
	return tool.execute("test-call", { ...validParams, ...overrides }, undefined, undefined, {} as never);
}

function storedFiles() {
	return {
		profile: readFileSync(join(dataDir, "profile.json"), "utf8"),
		events: readFileSync(join(dataDir, "events.jsonl"), "utf8"),
	};
}

describe("record_learning_evidence evaluator boundary", () => {
	it("advertises only evaluator sources a model may assert", () => {
		const schema = evidenceTool().parameters as unknown as { properties: { evaluator: { enum: string[] } } };
		expect(schema.properties.evaluator.enum).toEqual(["rubric", "model", "self"]);
	});

	it.each(["deterministic", "teacher", "external-checker", undefined])(
		"rejects an unsupported evaluator %s before creating any learner data",
		async (evaluator) => {
			await expect(execute(evidenceTool(), { evaluator })).rejects.toThrow("evaluator 仅允许 rubric、model 或 self");
			expect(existsSync(dataDir)).toBe(false);
		},
	);

	it.each(["deterministic", "teacher"])(
		"does not let a duplicate key bypass rejection of %s",
		async (evaluator) => {
			const tool = evidenceTool();
			await execute(tool);
			const before = storedFiles();
			await expect(execute(tool, { evaluator })).rejects.toThrow("evaluator 仅允许");
			expect(storedFiles()).toEqual(before);
		},
	);

	it.each(["rubric", "model", "self"])(
		"stores and reports the allowed evaluator %s",
		async (evaluator) => {
			const result = await execute(evidenceTool(), { evaluator });
			const events = loadEvents(dataDir);
			expect(events).toHaveLength(1);
			expect(events[0].evidence?.evaluator).toBe(evaluator);
			expect(result.details).toMatchObject({
				event_id: events[0].event_id,
				evidence_id: events[0].evidence?.evidence_id,
				evaluator,
			});
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining(`已存储评分来源：${evaluator}`) }));
			expect(loadProfile(dataDir).knowledge_states[0].evidence_ids).toContain(events[0].evidence?.evidence_id);
		},
	);

	it("returns the stored evaluator on a retry without changing the event or profile", async () => {
		const tool = evidenceTool();
		await execute(tool, { evaluator: "rubric" });
		const first = loadEvents(dataDir)[0];
		const before = storedFiles();
		const duplicate = await execute(tool, { evaluator: "model" });
		expect(duplicate.details).toMatchObject({
			duplicate: true,
			event_id: first.event_id,
			evidence_id: first.evidence?.evidence_id,
			evaluator: "rubric",
		});
		expect(duplicate.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("已存储评分来源：rubric") }));
		expect(storedFiles()).toEqual(before);
		expect(loadEvents(dataDir)).toHaveLength(1);
	});

	it.each(["deterministic", "teacher"] as const)(
		"preserves internal %s evidence and reports its stored source when deduplicating",
		async (evaluator) => {
			const event = createLearningEvidenceEvent("synthetic-learner", {
				concept_id: validParams.concept_id,
				kind: "application",
				result: "correct",
				evaluator,
				evaluator_confidence: 1,
				dedupe_key: validParams.dedupe_key,
			});
			recordEventAndUpdateProfile(dataDir, event);
			const before = storedFiles();
			const duplicate = await execute(evidenceTool());
			expect(duplicate.details).toMatchObject({
				duplicate: true,
				event_id: event.event_id,
				evidence_id: event.evidence?.evidence_id,
				evaluator,
			});
			expect(duplicate.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining(`已存储评分来源：${evaluator}`) }));
			expect(storedFiles()).toEqual(before);
		},
	);

	it("does not attribute the requested evaluator to an older event without evidence metadata", async () => {
		const event = createLearningEvent("synthetic-learner", "exercise_attempt", {}, { correct: true });
		event.dedupe_key = validParams.dedupe_key;
		recordEvent(dataDir, event);
		const duplicate = await execute(evidenceTool());
		expect(duplicate.details).toMatchObject({ duplicate: true, event_id: event.event_id, evaluator: null });
		expect(duplicate.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("已存储评分来源：未记录") }));
		expect(loadEvents(dataDir)).toEqual([event]);
		expect(existsSync(join(dataDir, "profile.json"))).toBe(false);
	});

	it("keeps the disabled layer inert even for forbidden evaluator arguments", async () => {
		const result = await execute(evidenceTool(() => false), { evaluator: "teacher" });
		expect(result.details).toEqual({ disabled: true });
		expect(existsSync(dataDir)).toBe(false);
	});

	it("does not change existing data when the layer is disabled at runtime", async () => {
		let enabled = true;
		const tool = evidenceTool(() => enabled);
		await execute(tool);
		const before = storedFiles();
		enabled = false;
		const result = await execute(tool, { evaluator: "self", dedupe_key: "a-new-answer" });
		expect(result.details).toEqual({ disabled: true });
		expect(storedFiles()).toEqual(before);
	});
});

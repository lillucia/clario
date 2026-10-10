import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { learnerStore } from "../stores/learner-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import type { LearnerProfile, LearningGoal } from "../types/learner.js";
import { DEFAULT_UPLOAD_MAX_BYTES } from "./upload-limits.js";
import { createLearningStartDraft, prepareLearningStart, type LearningStartInput } from "./learning-start.js";

const goal: LearningGoal = {
	goal_id: "goal_existing", title: "理解二分查找", type: "skill", priority: 0.8,
	status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-10-04T00:00:00Z",
};
const workspace = { id: "ws_learning", name: "学习空间", relPath: "ws_learning", isTemp: false };
const input: LearningStartInput = { goal: goal.title, material: { kind: "none" } };

function profile(goals: LearningGoal[] = []): LearnerProfile {
	return {
		learner_id: "test", version: 0, updated_at: "", goals, knowledge_states: [], misconceptions: [],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] }, profile_summary: "",
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { existingGoals?: LearningGoal[]; workspaces?: unknown[]; wiki?: { path: string; content: string } } = {}) {
	const requests: Array<{ path: string; method: string; body: Record<string, any> | undefined }> = [];
	const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : undefined;
		requests.push({ path, method, body });
		if (path === "/api/learner/profile" && method === "GET") return json(profile(options.existingGoals));
		if (path === "/api/learner/profile/goals" && method === "POST") return json({ ...goal, ...body, goal_id: "goal_created" }, 201);
		if (path === "/api/workspaces" && method === "GET") return json(options.workspaces ?? [workspace]);
		if (path === "/api/workspaces" && method === "POST") return json({ ...workspace, ...body }, 201);
		if (path.startsWith("/api/wiki/page?")) return json(options.wiki ?? { path: "wiki/concepts/binary.md", content: "来源明确的二分查找笔记" });
		if (path === "/api/workspace/upload") return json({ uploaded: body!.files.map((file: { path: string }) => ({ path: file.path, type: "file" })) }, 201);
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, requests };
}

describe("prepareLearningStart", () => {
	beforeEach(() => {
		learnerStore.profile = null;
		learnerStore.error = null;
		workspacesStore.workspaces = [];
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

	it("saves an explicitly declared goal and durable workspace without starting a session or changing mastery", async () => {
		const { requests } = mockApi();
		const result = await prepareLearningStart(input, createLearningStartDraft());
		expect(requests).toEqual([
			{ path: "/api/learner/profile", method: "GET", body: undefined },
			{ path: "/api/learner/profile/goals", method: "POST", body: { title: goal.title, type: "skill", status: "active", priority: 0.8 } },
			{ path: "/api/workspaces", method: "POST", body: { name: `学习：${goal.title}`, isTemp: false } },
		]);
		expect(result).toMatchObject({ goalId: "goal_created", workspaceId: workspace.id });
		expect(result.prompt).toContain('"event_type":"goal_declared"');
		expect(result.prompt).toContain('"context":{"goal_id":"goal_created"}');
		expect(result.prompt).toContain("前置知识");
		expect(result.prompt).toContain("不代表已经掌握");
		expect(learnerStore.profile?.knowledge_states).toEqual([]);
	});

	it("reuses an active goal and selected durable workspace instead of creating duplicates", async () => {
		const { requests } = mockApi({ existingGoals: [{ ...goal, title: ` ${goal.title} ` }] });
		const draft = createLearningStartDraft();
		const selected = { ...input, workspaceId: workspace.id };
		const first = await prepareLearningStart(selected, draft);
		const second = await prepareLearningStart(selected, draft);
		expect(first).toEqual(second);
		expect(first.goalId).toBe(goal.goal_id);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it("does not reuse a completed goal as a new active goal", async () => {
		const { requests } = mockApi({ existingGoals: [{ ...goal, status: "completed" }] });
		const result = await prepareLearningStart(input, createLearningStartDraft());
		expect(result.goalId).toBe("goal_created");
		expect(requests.filter((request) => request.path === "/api/learner/profile/goals")).toHaveLength(1);
	});

	it("does not read or save a profile when L1 persistence is disabled", async () => {
		const { requests } = mockApi();
		const result = await prepareLearningStart({ ...input, persistGoal: false }, createLearningStartDraft());
		expect(requests.some((request) => request.path.includes("learner"))).toBe(false);
		expect(result.goalId).toBeUndefined();
		expect(result.prompt).toContain("不保存学习者画像或学习事件");
		expect(result.prompt).not.toContain("record_learning_event");
	});

	it("does not mistake a failed profile load and stale local profile for an empty successful response", async () => {
		learnerStore.profile = profile([goal]);
		const fetchMock = vi.fn(async () => json({ error: "profile unavailable" }, 503));
		vi.stubGlobal("fetch", fetchMock);
		await expect(prepareLearningStart(input, createLearningStartDraft())).rejects.toThrow("profile unavailable");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["empty goal", { ...input, goal: " " }],
		["empty text", { ...input, material: { kind: "text", content: " " } }],
		["empty wiki selection", { ...input, material: { kind: "wiki", path: "", title: "" } }],
		["empty upload", { ...input, material: { kind: "upload", file: new File([], "empty.md") } }],
	] satisfies Array<[string, LearningStartInput]>)("rejects %s before API side effects", async (_name, candidate) => {
		const { requests } = mockApi();
		await expect(prepareLearningStart(candidate, createLearningStartDraft())).rejects.toThrow();
		expect(requests).toEqual([]);
	});

	it("rejects oversized files before allocating their arrayBuffer or creating resources", async () => {
		const { requests } = mockApi();
		const file = new File(["one"], "large.pdf");
		Object.defineProperty(file, "size", { value: DEFAULT_UPLOAD_MAX_BYTES + 1 });
		const read = vi.spyOn(file, "arrayBuffer");
		await expect(prepareLearningStart({ ...input, material: { kind: "upload", file } }, createLearningStartDraft())).rejects.toThrow("32 MB");
		expect(read).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});

	it.each([false, true])("wiki lookup failure cannot silently remove selected material (empty=%s)", async (empty) => {
		const fetchMock = vi.fn(async () => empty ? json({ path: "wiki/absent.md", content: " " }) : json({ error: "Page not found" }, 404));
		vi.stubGlobal("fetch", fetchMock);
		await expect(prepareLearningStart({ ...input, material: { kind: "wiki", path: "wiki/absent.md", title: "材料" } }, createLearningStartDraft())).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("checks a wiki source but asks the real agent to retrieve and attribute it instead of injecting its whole body", async () => {
		const { requests } = mockApi({ wiki: { path: "wiki/concepts/binary.md", content: "RAW_BODY_SHOULD_NOT_BE_INJECTED" } });
		const result = await prepareLearningStart({ ...input, material: { kind: "wiki", path: "wiki/concepts/binary.md", title: "二分查找" } }, createLearningStartDraft());
		expect(requests[0].path).toBe("/api/wiki/page?path=wiki%2Fconcepts%2Fbinary.md");
		expect(result.prompt).toContain("l2_query");
		expect(result.prompt).toContain("wiki/concepts/binary.md");
		expect(result.prompt).toContain("来源");
		expect(result.prompt).not.toContain("RAW_BODY_SHOULD_NOT_BE_INJECTED");
	});

	it("saves pasted material intact as UTF-8 Markdown and references its persistent attachment", async () => {
		const { requests } = mockApi();
		const content = 'while left < right:\n    right = mid\n材料包含 "引号"';
		const candidate: LearningStartInput = { ...input, material: { kind: "text", title: "课堂笔记", content } };
		const draft = createLearningStartDraft();
		const result = await prepareLearningStart(candidate, draft);
		await prepareLearningStart(candidate, draft);
		const uploads = requests.filter((request) => request.path === "/api/workspace/upload");
		expect(uploads).toHaveLength(1);
		const file = uploads[0].body!.files[0];
		expect(Buffer.from(file.dataBase64, "base64").toString("utf8")).toBe(content);
		expect(file.path).toMatch(/^learning-materials\/[\w-]+\/课堂笔记\.md$/);
		expect(result.prompt).toContain(JSON.stringify({ title: "课堂笔记", path: file.path }));
		expect(result.prompt).not.toContain(content);
		expect(result.attachments).toEqual({ bindings: [], loose: [{ path: file.path, source: "upload", kind: "doc" }] });
	});

	it.each([
		["missing", []],
		["temporary", [{ ...workspace, isTemp: true }]],
	])("rejects a %s selected workspace", async (_reason, workspaces) => {
		const { requests } = mockApi({ workspaces });
		await expect(prepareLearningStart({ ...input, workspaceId: workspace.id }, createLearningStartDraft())).rejects.toThrow("工作区");
		expect(requests.some((request) => request.path === "/api/workspaces" && request.method === "POST")).toBe(false);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("retries a failed upload at the same safe path without recreating resources; a successful retry is cached", async () => {
		const { fetchMock, requests } = mockApi();
		const normalFetch = fetchMock.getMockImplementation()!;
		let uploads = 0;
		fetchMock.mockImplementation(async (path, init) => {
			const result = await normalFetch(path, init);
			return path === "/api/workspace/upload" && ++uploads === 1 ? json({ error: "upload unavailable" }, 503) : result;
		});
		const file = new File(["半开区间学习资料"], "../../outside\\unsafe?.pdf");
		const candidate: LearningStartInput = { ...input, material: { kind: "upload", file } };
		const draft = createLearningStartDraft();
		await expect(prepareLearningStart(candidate, draft)).rejects.toThrow("upload unavailable");
		const result = await prepareLearningStart(candidate, draft);
		await prepareLearningStart(candidate, draft);
		const uploadRequests = requests.filter((request) => request.path === "/api/workspace/upload");
		expect(uploadRequests).toHaveLength(2);
		const path = uploadRequests[0].body!.files[0].path;
		expect(path).toMatch(/^learning-materials\/[\w-]+\/unsafe_\.pdf$/);
		expect(uploadRequests[1].body).toEqual(uploadRequests[0].body);
		expect(Buffer.from(uploadRequests[0].body!.files[0].dataBase64, "base64").toString()).toBe("半开区间学习资料");
		expect(result.attachments).toEqual({ bindings: [], loose: [{ path, source: "upload", kind: "pdf" }] });
		expect(requests.filter((request) => request.path === "/api/learner/profile/goals")).toHaveLength(1);
		expect(requests.filter((request) => request.path === "/api/workspaces")).toHaveLength(1);
	});

	it("requires upload acknowledgement for the exact file path", async () => {
		const { fetchMock } = mockApi();
		const normalFetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (path, init) => path === "/api/workspace/upload" ? json({ uploaded: [] }) : normalFetch(path, init));
		const draft = createLearningStartDraft();
		await expect(prepareLearningStart({ ...input, material: { kind: "upload", file: new File(["note"], "note.md") } }, draft)).rejects.toThrow("未确认");
		expect(draft.uploaded).not.toBe(true);
	});

	it("coalesces concurrent preparations of the same draft", async () => {
		const { requests } = mockApi();
		const draft = createLearningStartDraft();
		const [first, second] = await Promise.all([prepareLearningStart(input, draft), prepareLearningStart(input, draft)]);
		expect(first).toEqual(second);
		expect(requests).toHaveLength(3);
	});

	it("rejects reuse of a draft after form input changes", async () => {
		const { requests } = mockApi();
		const draft = createLearningStartDraft();
		await prepareLearningStart(input, draft);
		await expect(prepareLearningStart({ ...input, goal: "JavaScript Promise" }, draft)).rejects.toThrow("新的学习草稿");
		await expect(prepareLearningStart({ ...input, persistGoal: false }, draft)).rejects.toThrow("新的学习草稿");
		expect(requests).toHaveLength(3);
	});

	it("does not mistake a replacement File with identical metadata for the already uploaded contents", async () => {
		const { requests } = mockApi();
		const draft = createLearningStartDraft();
		const first = new File(["aaa"], "note.md", { lastModified: 1 });
		const second = new File(["bbb"], "note.md", { lastModified: 1 });
		await prepareLearningStart({ ...input, material: { kind: "upload", file: first } }, draft);
		await expect(prepareLearningStart({ ...input, material: { kind: "upload", file: second } }, draft)).rejects.toThrow("新的学习草稿");
		expect(requests.filter((request) => request.path === "/api/workspace/upload")).toHaveLength(1);
	});
});

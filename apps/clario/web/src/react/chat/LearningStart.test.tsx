// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningStart } from "./LearningStart.js";

const mocks = vi.hoisted(() => ({ listPages: vi.fn(), loadProfile: vi.fn(), page: vi.fn(), settings: vi.fn() }));
vi.mock("../../api/wiki.js", () => ({ listWikiPages: mocks.listPages }));
vi.mock("../../stores/learner-store.js", () => ({ learnerStore: {
	profile: { goals: [{ goal_id: "goal-1", title: "理解二分查找", status: "active" }] }, error: null,
	load: mocks.loadProfile, on: () => () => {},
} }));
vi.mock("../../stores/workspaces-store.js", () => ({ workspacesStore: {
	workspaces: [{ id: "ws-1", name: "Python学习", isTemp: false }], on: () => () => {},
} }));
vi.mock("../../stores/app-store.js", () => ({ appStore: { setPage: mocks.page, openSettings: mocks.settings } }));
const page = { path: "wiki/sources/python.md", frontmatter: { title: "Python 笔记" }, bodyPreview: "Python 学习材料" };
function setup(overrides: Record<string, unknown> = {}) {
	const onStart = vi.fn().mockResolvedValue(undefined);
	const onDraftChange = vi.fn();
	render(<LearningStart onStart={onStart} onDraftChange={onDraftChange} busy={false} modelReady modelName="Test model" l1Enabled l2Enabled {...overrides} />);
	return { onStart, onDraftChange };
}
const goal = () => fireEvent.change(screen.getByLabelText("学习目标"), { target: { value: "学会 Python 二分查找" } });
const start = () => fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.listPages.mockResolvedValue([page]); mocks.loadProfile.mockResolvedValue(undefined); });

describe("learning start", () => {
	it("honors the workspace selected from the sidebar", async () => {
		const { onStart } = setup({ initialWorkspaceId: "ws-1", l2Enabled: false });
		goal(); start();
		expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
	});
	it("requires an explicit goal and material before submitting", async () => {
		const { onStart } = setup();
		await screen.findByLabelText("选择知识库材料");
		start();
		expect(screen.getByRole("alert").textContent).toContain("请先写下");
		goal(); start();
		expect(screen.getByRole("alert").textContent).toContain("请选择一份");
		expect(onStart).not.toHaveBeenCalled();
	});
	it("submits the chosen goal, wiki and workspace through one entry", async () => {
		const { onStart } = setup();
		await screen.findByLabelText("选择知识库材料");
		fireEvent.click(screen.getByRole("button", { name: "理解二分查找" }));
		fireEvent.change(screen.getByLabelText("选择知识库材料"), { target: { value: page.path } });
		fireEvent.change(screen.getByLabelText("保存到"), { target: { value: "ws-1" } });
		start();
		expect(onStart).toHaveBeenCalledWith({ goal: "理解二分查找", material: { kind: "wiki", path: page.path, title: "Python 笔记" }, workspaceId: "ws-1", persistGoal: true });
	});
	it("retains the selected upload when preparation fails, and retries the same file", async () => {
		const onStart = vi.fn().mockRejectedValueOnce(new Error("上传失败，请重试")).mockResolvedValue(undefined);
		setup({ onStart }); goal();
		fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
		const file = new File(["binary search"], "note.md", { type: "text/markdown" });
		fireEvent.change(screen.getByLabelText("上传学习材料"), { target: { files: [file] } });
		start();
		await screen.findByText("上传失败，请重试");
		expect(screen.getByText("note.md")).toBeTruthy();
		start();
		await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));
		expect(onStart.mock.calls[0][0].material.file).toBe(file);
		expect(onStart.mock.calls[1][0].material.file).toBe(file);
	});
	it("prevents duplicate submissions while preparation is pending", async () => {
		let resolve!: () => void;
		const onStart = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r; }));
		setup({ onStart }); goal();
		fireEvent.click(screen.getByRole("button", { name: "从目标开始" }));
		const form = screen.getByRole("button", { name: "开始学习" }).closest("form")!;
		fireEvent.submit(form); fireEvent.submit(form);
		expect(onStart).toHaveBeenCalledTimes(1);
		resolve();
		await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "开始学习" }).disabled).toBe(false));
	});
	it("does not read disabled memory and marks the goal as conversation-only", async () => {
		const { onStart } = setup({ l1Enabled: false, l2Enabled: false });
		goal(); start();
		expect(mocks.listPages).not.toHaveBeenCalled();
		expect(mocks.loadProfile).not.toHaveBeenCalled();
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "知识库" }).disabled).toBe(true);
		expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ persistGoal: false, material: { kind: "none" } }));
	});
	it("does not silently fall back when the wiki list fails", async () => {
		mocks.listPages.mockRejectedValue(new Error("offline"));
		const { onStart } = setup();
		await screen.findByRole("alert"); goal(); start();
		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText("重新加载")).toBeTruthy();
	});
	it("keeps a model setup action available when no model is selected", () => {
		const { onStart } = setup({ modelReady: false });
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "开始学习" }).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: /设置模型/ }));
		expect(mocks.settings).toHaveBeenCalledWith("models");
		expect(onStart).not.toHaveBeenCalled();
	});
	it("passes pasted material instead of losing it in a generic starter prompt", async () => {
		const { onStart } = setup(); goal();
		fireEvent.click(screen.getByRole("button", { name: "粘贴内容" }));
		fireEvent.change(screen.getByLabelText("粘贴笔记或题目"), { target: { value: "left < right 才继续循环" } });
		start();
		expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ material: { kind: "text", content: "left < right 才继续循环", title: "学会 Python 二分查找" } }));
	});
});

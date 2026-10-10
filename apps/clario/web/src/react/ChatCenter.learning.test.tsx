// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => {
	const t = (key: string, fallback?: unknown) => typeof fallback === "string" ? fallback : key;
	return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});
vi.mock("../api/workspace.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../api/workspace.js")>(),
	uploadWorkspaceFileWithProgress: vi.fn(),
}));

import { uploadWorkspaceFileWithProgress } from "../api/workspace.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { ChatCenter } from "./ChatCenter.js";

const preset = { id: "python", name: "Python 入门", description: "从变量与函数开始" };
const workspace = { id: "learning-workspace", name: "学习工作区", relPath: "learning-workspace", createdAt: "", updatedAt: "", isTemp: true };
const requests: Array<{ path: string; method: string; body?: unknown }> = [];
let createResponse: () => Promise<Response>;

function json(body: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function input(text: string) {
	fireEvent.input(screen.getByRole("textbox"), { target: { value: text } });
}

function send() {
	fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
}

function file(name: string) {
	const result = new File(["learning material"], name, { type: "text/plain" });
	// jsdom's File omits this browser API; keep the actual file input and chips.
	Object.defineProperty(result, "arrayBuffer", { value: async () => new TextEncoder().encode("learning material").buffer });
	return result;
}

function selectFiles(container: HTMLElement, files: File[]) {
	const picker = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])');
	expect(picker).toBeTruthy();
	fireEvent.change(picker!, { target: { files } });
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.mocked(uploadWorkspaceFileWithProgress).mockReset();
	localStorage.clear();
	requests.length = 0;
	vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
	vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
	vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const path = String(url);
		const method = init?.method ?? "GET";
		requests.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		if (path === "/api/commands") return json({ commands: [] });
		if (path.startsWith("/api/preset-library")) return json([preset]);
		if (path === "/api/sessions" && method === "POST") return createResponse();
		if (path === "/api/sessions") return json([]);
		if (path === "/api/workspaces") return json([workspace]);
		if (path.startsWith("/api/workspace/tree")) return json({ name: "workspace", path: "", type: "directory", root: "workspace", children: [] });
		if (path.includes("/context-usage")) return json({ sessionId: "new-session", status: "ready", source: "sdk", tokens: 0, contextWindow: 4096, percent: 0, breakdown: [] });
		throw new Error(`Unexpected request: ${method} ${path}`);
	}));
	createResponse = () => json({ id: "new-session", active: true, workspaceId: workspace.id });
	chatStore.clear();
	Object.assign(sessionsStore, { currentSessionId: null, openingSessionId: null, pendingNewSession: true, preselectedWorkspaceId: null, busyBlocker: null, sessions: [], isLoading: false });
	Object.assign(workspaceStore, { activeWorkspaceId: workspace.id, tree: null, error: "", isLoadingTree: false });
	workspacesStore.workspaces = [workspace];
	settingsStore.settings = {
		experience: "learning", defaultModel: "model", defaultProvider: "test", providers: {},
		availableModels: [{ id: "model", name: "Test model", provider: "test", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }],
	};
	Object.assign(appStore, { page: "chat", workspaceMode: "collapsed", sidebarCollapsed: false });
	vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("learning home conversation entry", () => {
	it("offers the existing composer and preset cards without requiring a goal or material form", async () => {
		const { container } = render(<ChatCenter onOpenPresetPanels={vi.fn()} onPreviewFile={vi.fn()} />);
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(screen.getByRole("button", { name: "chat.send" })).toBeTruthy();
		expect(await screen.findByRole("button", { name: /Python 入门/ })).toBeTruthy();
		expect(container.querySelectorAll("textarea, input:not([type=file])")).toHaveLength(1);
		expect(screen.queryByLabelText(/目标名称|目标描述|材料路径|学习目标/)).toBeNull();
		const catalogRequests = requests.filter(({ path }) => path.startsWith("/api/preset-library"));
		expect(catalogRequests.map(({ path }) => path)).toEqual(["/api/preset-library"]);
		fireEvent.click(screen.getByRole("button", { name: "presets.refresh" }));
		await waitFor(() => expect(requests.some(({ path }) => path === "/api/preset-library?refresh=1")).toBe(true));
	});

	it("sends the learner's own words directly and leaves goal collection to the conversation", async () => {
		render(<ChatCenter onOpenPresetPanels={vi.fn()} onPreviewFile={vi.fn()} />);
		const prompt = "我想学 Python，先帮我判断从哪里开始。";
		input(prompt);
		send();
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(prompt, undefined, "new-session", undefined));
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
		expect(requests.filter(({ method }) => method !== "GET").map(({ path }) => path)).toEqual(["/api/sessions"]);
	});

	it.each([503, 409])("keeps the draft and attachments when session creation fails with %s without sending to the previous session", async (status) => {
		sessionsStore.currentSessionId = "old-session";
		createResponse = () => json(status === 409
			? { error: "session_busy", blocking: { sessionId: "other-session", turnId: "turn-1" } }
			: { error: "Session unavailable" }, status);
		const { container } = render(<ChatCenter onOpenPresetPanels={vi.fn()} onPreviewFile={vi.fn()} />);
		const prompt = "根据这份笔记开始学习";
		input(prompt);
		selectFiles(container, [file("notes.txt")]);
		send();
		await waitFor(() => expect(sessionsStore.isLoading).toBe(false));
		await waitFor(() => expect((screen.getByRole("button", { name: "chat.send" }) as HTMLButtonElement).disabled).toBe(false));
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(prompt);
		expect(screen.getByTitle("notes.txt")).toBeTruthy();
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(uploadWorkspaceFileWithProgress).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBe("old-session");
	});

	it("keeps failed material retryable and reuses successful uploads without sending an incomplete learning request", async () => {
		const upload = vi.mocked(uploadWorkspaceFileWithProgress);
		upload.mockResolvedValueOnce({ name: "notes.txt", path: "materials/notes.txt", type: "file" });
		upload.mockRejectedValueOnce(new Error("Network unavailable"));
		upload.mockResolvedValueOnce({ name: "exercise.txt", path: "materials/exercise.txt", type: "file" });
		const { container } = render(<ChatCenter onOpenPresetPanels={vi.fn()} onPreviewFile={vi.fn()} />);
		const prompt = "结合两份材料教我";
		input(prompt);
		selectFiles(container, [file("notes.txt"), file("exercise.txt")]);
		expect(upload).not.toHaveBeenCalled();
		send();
		await screen.findByText("chat.learningUploadFailed");
		expect(chatStore.send).not.toHaveBeenCalled();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(prompt);
		expect(upload).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("button", { name: "重试上传（随下次发送）" }));
		send();
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledTimes(1));
		expect(upload).toHaveBeenCalledTimes(3);
		expect(upload.mock.calls[2][0].path).toBe("exercise.txt");
		expect(upload.mock.calls.every((call) => call[1] === workspace.id)).toBe(true);
		expect(chatStore.send).toHaveBeenCalledWith(prompt, undefined, "new-session", {
			bindings: [],
			loose: [
				{ path: "materials/notes.txt", kind: "doc", source: "workspace" },
				{ path: "materials/exercise.txt", kind: "doc", source: "upload" },
			],
		});
		expect(requests.filter(({ path, method }) => path === "/api/sessions" && method === "POST")).toHaveLength(1);
	});

	it("opens preset panels only after the preset session has been created successfully", async () => {
		const openPanels = vi.fn();
		createResponse = () => json({ error: "Preset download unavailable" }, 503);
		render(<ChatCenter onOpenPresetPanels={openPanels} onPreviewFile={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: /Python 入门/ }));
		await screen.findByText("Preset download unavailable");
		expect(openPanels).not.toHaveBeenCalled();
		createResponse = () => json({ id: "new-session", active: true, workspaceId: workspace.id });
		fireEvent.click(screen.getByRole("button", { name: /Python 入门/ }));
		await waitFor(() => expect(openPanels).toHaveBeenCalledTimes(1));
		expect(sessionsStore.currentSessionId).toBe("new-session");
		expect(requests.filter(({ method }) => method === "POST").map(({ body }) => body)).toEqual([{ presetId: "python" }, { presetId: "python" }]);
		expect(chatStore.send).not.toHaveBeenCalled();
	});

	it("does not send into a session selected while a new conversation is being created", async () => {
		let resolveCreate!: (response: Response) => void;
		createResponse = () => new Promise((resolve) => { resolveCreate = resolve; });
		render(<ChatCenter onOpenPresetPanels={vi.fn()} onPreviewFile={vi.fn()} />);
		input("保留这份新会话草稿");
		send();
		await waitFor(() => expect(requests.some(({ path, method }) => path === "/api/sessions" && method === "POST")).toBe(true));
		await act(async () => {
			sessionsStore.selectSession("other-session");
			resolveCreate(await json({ id: "new-session", active: true, workspaceId: workspace.id }));
		});
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBe("other-session");
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保留这份新会话草稿");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	getSession: vi.fn(),
	createSession: vi.fn(),
	activateSession: vi.fn(),
	getChatStatus: vi.fn(),
	preloadMermaidMarkdownRuntime: vi.fn(),
	abortChat: vi.fn(),
	chatDetach: vi.fn(),
	chatClear: vi.fn(),
	chatLoadHistory: vi.fn(),
	chatSetLoadingHistory: vi.fn(),
	chatShowError: vi.fn(),
}));

vi.mock("../api/sessions.js", () => ({
	listSessions: mocks.listSessions,
	getSession: mocks.getSession,
	createSession: mocks.createSession,
	activateSession: mocks.activateSession,
	archiveSession: vi.fn(),
	deleteSession: vi.fn(),
	generateSessionName: vi.fn(),
	unarchiveSession: vi.fn(),
	updateSessionName: vi.fn(),
}));
vi.mock("../api/chat.js", () => ({ getChatStatus: mocks.getChatStatus, abortChat: mocks.abortChat }));
vi.mock("../api/workspaces.js", () => ({ getSessionWorkspace: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }) }));
vi.mock("./chat-store.js", () => ({
	chatStore: {
		messages: [],
		isLoadingHistory: false,
		isSending: false,
		detach: mocks.chatDetach,
		clear: mocks.chatClear,
		loadHistory: mocks.chatLoadHistory,
		setLoadingHistory: mocks.chatSetLoadingHistory,
		showError: mocks.chatShowError,
		resumeStream: vi.fn(),
	},
}));
vi.mock("./workspace-store.js", () => ({ workspaceStore: { setActiveWorkspace: vi.fn() } }));
vi.mock("./workspaces-store.js", () => ({ workspacesStore: { load: vi.fn() } }));
vi.mock("./terminal-store.js", () => ({ terminalStore: { disconnect: vi.fn() } }));
vi.mock("../utils/mermaid-runtime.js", () => ({
	hasMermaidFence: (content: string) => /```mermaid\b/i.test(content),
	preloadMermaidMarkdownRuntime: mocks.preloadMermaidMarkdownRuntime,
}));

import { SessionsStoreImpl } from "./sessions-store.js";
import { ApiError } from "../api/client.js";
import { chatStore } from "./chat-store.js";
import { workspaceStore } from "./workspace-store.js";

function session(id: string) {
	return {
		id,
		name: id,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
		messageCount: 0,
		preview: "",
		channels: [],
		messages: [],
		sessionRevision: "0:0",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SessionsStore navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createSession.mockReset();
		chatStore.messages = [];
		chatStore.isLoadingHistory = false;
		chatStore.isSending = false;
		mocks.chatClear.mockImplementation(() => { chatStore.messages = []; });
		mocks.chatLoadHistory.mockImplementation((messages) => { chatStore.messages = messages; });
		mocks.chatSetLoadingHistory.mockImplementation((loading) => { chatStore.isLoadingHistory = loading; });
		mocks.chatShowError.mockImplementation((content) => { chatStore.messages.push({ role: "assistant", content, timestamp: Date.now() }); });
		let href = "http://localhost/";
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: { get href() { return href; }, set href(value: string) { href = value; } },
				history: {
					pushState: vi.fn((_state, _title, url: URL) => { href = url.toString(); }),
					replaceState: vi.fn((_state, _title, url: URL) => { href = url.toString(); }),
				},
			},
		});
		mocks.listSessions.mockResolvedValue([]);
		mocks.activateSession.mockResolvedValue({ active: true });
		mocks.getChatStatus.mockResolvedValue({ found: false });
		mocks.preloadMermaidMarkdownRuntime.mockResolvedValue(undefined);
	});
	afterEach(() => { vi.unstubAllGlobals(); });

	it("writes the created session to the URL before the first send can continue", async () => {
		mocks.createSession.mockResolvedValue({ id: "created.jsonl", active: true, workspaceId: "workspace-1" });
		const store = new SessionsStoreImpl();
		expect(await store.createSessionWith({ workspaceId: "workspace-1" })).toBe("created.jsonl");
		expect(store.currentSessionId).toBe("created.jsonl");
		expect(new URL(window.location.href).searchParams.get("session")).toBe("created.jsonl");
		expect(window.history.replaceState).toHaveBeenCalled();
	});

	it("signals context usage after the session runtime is activated", async () => {
		mocks.getSession.mockResolvedValue(session("active.jsonl"));
		const store = new SessionsStoreImpl();
		await store.openSession("active.jsonl", { historyMode: "none" });
		expect(store.contextUsageRevision).toBe(1);
	});

	it("keeps refreshing while a preview topic waits for its upgrade", async () => {
		vi.useFakeTimers();
		try {
			const preview = { ...session("topic.jsonl"), hasTopic: true, topicPendingUpgrade: true };
			mocks.listSessions
				.mockResolvedValueOnce([preview])
				.mockResolvedValueOnce([{ ...preview, topicPendingUpgrade: false }]);
			const store = new SessionsStoreImpl();
			const refreshing = store.refreshUntilTopic("topic.jsonl");

			await Promise.resolve();
			await Promise.resolve();
			expect(mocks.listSessions).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(2_000);
			await refreshing;

			expect(mocks.listSessions).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns to the welcome page on a popstate URL without a session", () => {
		const store = new SessionsStoreImpl();
		store.currentSessionId = "a.jsonl";
		store.showWelcomeFromHistory();
		expect(store.currentSessionId).toBeNull();
		expect(store.pendingNewSession).toBe(true);
		expect(mocks.chatDetach).toHaveBeenCalled();
		expect(window.history.replaceState).not.toHaveBeenCalled();
	});

	it("does not let a stale open request overwrite a newer session", async () => {
		let resolveA!: (value: ReturnType<typeof session>) => void;
		const a = new Promise<ReturnType<typeof session>>((resolve) => { resolveA = resolve; });
		mocks.getSession.mockImplementation((id: string) => id === "a.jsonl" ? a : Promise.resolve(session("b.jsonl")));
		const store = new SessionsStoreImpl();
		const openingA = store.openSession("a.jsonl", { historyMode: "none" });
		await Promise.resolve();
		await store.openSession("b.jsonl", { historyMode: "none" });
		resolveA(session("a.jsonl"));
		await openingA;
		expect(store.currentSessionId).toBe("b.jsonl");
		expect(mocks.chatLoadHistory).toHaveBeenLastCalledWith([], "b.jsonl");
	});

	it("waits for the Mermaid runtime before publishing Mermaid history", async () => {
		const messages = [{
			role: "assistant" as const,
			content: "```mermaid\nflowchart LR\nA-->B\n```",
			timestamp: Date.now(),
		}];
		mocks.getSession.mockResolvedValue({ ...session("mermaid.jsonl"), messages });

		let resolveRuntime!: () => void;
		mocks.preloadMermaidMarkdownRuntime.mockReturnValue(new Promise<void>((resolve) => { resolveRuntime = resolve; }));
		const store = new SessionsStoreImpl();
		const opening = store.openSession("mermaid.jsonl", { historyMode: "none" });
		await vi.waitFor(() => expect(mocks.preloadMermaidMarkdownRuntime).toHaveBeenCalled());
		expect(mocks.chatLoadHistory).toHaveBeenLastCalledWith([], "mermaid.jsonl");

		resolveRuntime();
		await opening;
		expect(mocks.chatLoadHistory).toHaveBeenLastCalledWith(messages, "mermaid.jsonl");
	});

	it("publishes cached Mermaid history after the runtime preload instead of clearing the view", async () => {
		const messages = [{
			role: "assistant" as const,
			content: "```mermaid\nflowchart LR\nA-->B\n```",
			timestamp: Date.now(),
		}];
		mocks.getSession.mockResolvedValue({ ...session("mermaid.jsonl"), messages });
		mocks.preloadMermaidMarkdownRuntime.mockResolvedValue(undefined);
		const store = new SessionsStoreImpl();
		await store.openSession("mermaid.jsonl", { historyMode: "none" });
		expect(mocks.chatLoadHistory).toHaveBeenLastCalledWith(messages, "mermaid.jsonl");

		// Re-opening the same session hits the message cache. The cached history
		// must wait for the Mermaid runtime, but the view is never cleared into
		// the empty loading state and no refetch is needed to get the ordering.
		mocks.chatLoadHistory.mockClear();
		mocks.chatSetLoadingHistory.mockClear();
		let resolveRuntime!: () => void;
		mocks.preloadMermaidMarkdownRuntime.mockReturnValue(new Promise<void>((resolve) => { resolveRuntime = resolve; }));
		const reopening = store.openSession("mermaid.jsonl", { historyMode: "none" });
		await vi.waitFor(() => expect(mocks.preloadMermaidMarkdownRuntime).toHaveBeenCalledTimes(2));
		expect(mocks.chatLoadHistory).not.toHaveBeenCalled();
		expect(mocks.chatSetLoadingHistory).not.toHaveBeenCalledWith(true);

		resolveRuntime();
		await vi.waitFor(() => expect(mocks.chatLoadHistory).toHaveBeenCalledWith(messages, "mermaid.jsonl"));
		await reopening;
	});

	it("beginNewSession invalidates an in-flight openSession", async () => {
		let resolveA!: (value: ReturnType<typeof session>) => void;
		const a = new Promise<ReturnType<typeof session>>((resolve) => { resolveA = resolve; });
		mocks.getSession.mockImplementation((id: string) => id === "a.jsonl" ? a : Promise.resolve(session(id)));
		const store = new SessionsStoreImpl();
		store.currentSessionId = "x.jsonl";
		const openingA = store.openSession("a.jsonl", { historyMode: "none" });
		await Promise.resolve();
		store.beginNewSession();
		resolveA(session("a.jsonl"));
		await openingA;
		expect(store.currentSessionId).toBeNull();
		expect(store.pendingNewSession).toBe(true);
		expect(mocks.chatSetLoadingHistory).toHaveBeenCalledWith(false);
	});

	it("surfaces a busy blocker when session creation hits a queue-blocked 409", async () => {
		mocks.createSession.mockRejectedValue(
			new ApiError(409, "session_busy", { error: "session_busy", blocking: { sessionId: "old.jsonl", turnId: "t-1", questionPending: true } }),
		);
		const store = new SessionsStoreImpl();
		expect(await store.createSessionWith({ workspaceId: "workspace-1" })).toBeNull();
		expect(store.busyBlocker).toEqual({ sessionId: "old.jsonl", turnId: "t-1", questionPending: true });
		expect(store.currentSessionId).toBeNull();
		expect(mocks.chatShowError).not.toHaveBeenCalled();
	});

	it("stopBusyBlockerAndRetry aborts the blocking turn and retries creation", async () => {
		mocks.createSession
			.mockRejectedValueOnce(new ApiError(409, "session_busy", { error: "session_busy", blocking: { sessionId: "old.jsonl", turnId: "t-1" } }))
			.mockResolvedValueOnce({ id: "new.jsonl", active: true, workspaceId: "workspace-1" });
		mocks.abortChat.mockResolvedValue(undefined);
		const store = new SessionsStoreImpl();
		await store.createSessionWith({ workspaceId: "workspace-1" });
		expect(store.busyBlocker?.turnId).toBe("t-1");
		await store.stopBusyBlockerAndRetry();
		expect(mocks.abortChat).toHaveBeenCalledWith("old.jsonl", "t-1");
		expect(store.currentSessionId).toBe("new.jsonl");
		expect(store.busyBlocker).toBeNull();
	});

	it("keeps the learning welcome form mounted after a real API 500 and opens it only after a successful retry", async () => {
		const actual = await vi.importActual<typeof import("../api/sessions.js")>("../api/sessions.js");
		mocks.createSession.mockImplementation(actual.createSession);
		const response = deferred<Response>();
		const fetchMock = vi.fn().mockReturnValueOnce(response.promise)
			.mockResolvedValueOnce(json({ id: "learn.jsonl", workspaceId: "workspace-1", active: true }, 201));
		vi.stubGlobal("fetch", fetchMock);
		const store = new SessionsStoreImpl();
		store.beginNewSessionIn("workspace-1");
		const views: boolean[] = [];
		store.on("change", () => views.push(store.isWelcomeView));
		const creating = store.createSessionWith({ workspaceId: "workspace-1" }, { preserveWelcomeOnError: true });
		expect(store.pendingNewSession).toBe(true);
		expect(store.preselectedWorkspaceId).toBe("workspace-1");
		response.resolve(json({ error: "session creation unavailable" }, 500));
		await expect(creating).rejects.toThrow("session creation unavailable");
		expect(views.every(Boolean)).toBe(true);
		expect(store.isWelcomeView).toBe(true);
		expect(store.preselectedWorkspaceId).toBe("workspace-1");
		expect(store.isLoading).toBe(false);
		expect(chatStore.messages).toEqual([]);
		expect(mocks.chatShowError).not.toHaveBeenCalled();
		expect(await store.createSessionWith({ workspaceId: "workspace-1" }, { preserveWelcomeOnError: true })).toBe("learn.jsonl");
		expect(store.currentSessionId).toBe("learn.jsonl");
		expect(store.isWelcomeView).toBe(false);
		expect(store.preselectedWorkspaceId).toBeNull();
		expect(fetchMock.mock.calls.map(([path, options]) => [path, options.method, JSON.parse(options.body)])).toEqual([
			["/api/sessions", "POST", { workspaceId: "workspace-1" }],
			["/api/sessions", "POST", { workspaceId: "workspace-1" }],
		]);
	});

	it("preserves learning-form ownership for API 409 and its subsequent busy-blocker retry", async () => {
		const actual = await vi.importActual<typeof import("../api/sessions.js")>("../api/sessions.js");
		mocks.createSession.mockImplementation(actual.createSession);
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(json({ error: "session_busy", blocking: { sessionId: "old.jsonl", turnId: "turn-1", questionPending: true } }, 409))
			.mockResolvedValueOnce(json({ error: "retry unavailable" }, 500)));
		const store = new SessionsStoreImpl();
		store.beginNewSessionIn("workspace-1");
		expect(await store.createSessionWith({ workspaceId: "workspace-1" }, { preserveWelcomeOnError: true })).toBeNull();
		expect(store.busyBlocker).toEqual({ sessionId: "old.jsonl", turnId: "turn-1", questionPending: true });
		expect(store.isWelcomeView).toBe(true);
		expect(store.preselectedWorkspaceId).toBe("workspace-1");
		await expect(store.stopBusyBlockerAndRetry()).rejects.toThrow("retry unavailable");
		expect(mocks.abortChat).toHaveBeenCalledWith("old.jsonl", "turn-1");
		expect(store.isWelcomeView).toBe(true);
		expect(store.preselectedWorkspaceId).toBe("workspace-1");
		expect(mocks.chatShowError).not.toHaveBeenCalled();
	});

	it("keeps the legacy chat-error behavior when preservation is not requested", async () => {
		mocks.createSession.mockRejectedValue(new ApiError(500, "legacy failure"));
		const store = new SessionsStoreImpl();
		store.beginNewSessionIn("workspace-1");
		expect(await store.createSessionWith({ workspaceId: "workspace-1" })).toBeNull();
		expect(store.pendingNewSession).toBe(false);
		expect(store.preselectedWorkspaceId).toBeNull();
		expect(mocks.chatShowError).toHaveBeenCalledWith("legacy failure");
		expect(store.isWelcomeView).toBe(false);
	});

	it("does not let a delayed create overwrite a session opened after creation started", async () => {
		const response = deferred<{ id: string; active: boolean; workspaceId: string }>();
		mocks.createSession.mockReturnValue(response.promise);
		mocks.getSession.mockResolvedValue(session("chosen.jsonl"));
		const store = new SessionsStoreImpl();
		store.beginNewSession();
		const creating = store.createSessionWith({}, { preserveWelcomeOnError: true });
		await store.openSession("chosen.jsonl");
		const clearCount = mocks.chatClear.mock.calls.length;
		response.resolve({ id: "late.jsonl", active: true, workspaceId: "late-workspace" });
		expect(await creating).toBeNull();
		expect(store.currentSessionId).toBe("chosen.jsonl");
		expect(new URL(window.location.href).searchParams.get("session")).toBe("chosen.jsonl");
		expect(mocks.chatClear).toHaveBeenCalledTimes(clearCount);
		expect(workspaceStore.setActiveWorkspace).not.toHaveBeenCalledWith("late-workspace");
	});

	it("does not replace a newer learning draft when navigation happens during the post-create list refresh", async () => {
		mocks.createSession.mockResolvedValue({ id: "late.jsonl", active: true });
		const listing = deferred<ReturnType<typeof session>[]>();
		mocks.listSessions.mockReturnValue(listing.promise);
		const store = new SessionsStoreImpl();
		store.beginNewSessionIn("original-workspace");
		const creating = store.createSessionWith({}, { preserveWelcomeOnError: true });
		await vi.waitFor(() => expect(mocks.listSessions).toHaveBeenCalled());
		store.beginNewSessionIn("new-workspace");
		listing.resolve([session("late.jsonl")]);
		expect(await creating).toBeNull();
		expect(store.isWelcomeView).toBe(true);
		expect(store.currentSessionId).toBeNull();
		expect(store.preselectedWorkspaceId).toBe("new-workspace");
		expect(new URL(window.location.href).searchParams.has("session")).toBe(false);
	});

	it("ignores a stale create rejection after the user returns to welcome via history", async () => {
		const response = deferred<never>();
		mocks.createSession.mockReturnValue(response.promise);
		const store = new SessionsStoreImpl();
		const creating = store.createSessionWith({}, { preserveWelcomeOnError: true });
		store.showWelcomeFromHistory();
		response.reject(new ApiError(500, "stale error"));
		expect(await creating).toBeNull();
		expect(store.isWelcomeView).toBe(true);
		expect(mocks.chatShowError).not.toHaveBeenCalled();
	});

	it("does not let an older create clear the loading state or result of a newer creation", async () => {
		const first = deferred<{ id: string; active: boolean }>();
		const second = deferred<{ id: string; active: boolean }>();
		mocks.createSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const store = new SessionsStoreImpl();
		const oldCreate = store.createSessionWith({}, { preserveWelcomeOnError: true });
		const newCreate = store.createSessionWith({}, { preserveWelcomeOnError: true });
		first.resolve({ id: "old.jsonl", active: true });
		expect(await oldCreate).toBeNull();
		expect(store.isLoading).toBe(true);
		expect(store.currentSessionId).toBeNull();
		second.resolve({ id: "new.jsonl", active: true });
		expect(await newCreate).toBe("new.jsonl");
		expect(store.isLoading).toBe(false);
		expect(store.currentSessionId).toBe("new.jsonl");
	});

	it("does not resume an old session stream after a newer create invalidates its activation", async () => {
		const activation = deferred<{ active: boolean }>();
		mocks.activateSession.mockReturnValue(activation.promise);
		mocks.getSession.mockResolvedValue(session("old.jsonl"));
		mocks.getChatStatus.mockResolvedValue({ stream: { status: "running", turnId: "old-turn" } });
		mocks.createSession.mockResolvedValue({ id: "new.jsonl", active: true });
		const store = new SessionsStoreImpl();
		const opening = store.openSession("old.jsonl");
		await vi.waitFor(() => expect(mocks.activateSession).toHaveBeenCalled());
		expect(await store.createSessionWith()).toBe("new.jsonl");
		activation.resolve({ active: true });
		await opening;
		expect(store.currentSessionId).toBe("new.jsonl");
		expect(chatStore.resumeStream).not.toHaveBeenCalled();
	});
});

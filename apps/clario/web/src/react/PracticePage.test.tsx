// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => typeof fallback === "string" ? fallback : key }) }));
vi.mock("../stores/app-store.js", () => ({ appStore: { setPage: vi.fn(), setRightPanelTab: vi.fn(), setWorkspaceWidth: vi.fn(), setWorkspaceMode: vi.fn() } }));
vi.mock("../stores/sessions-store.js", () => ({ sessionsStore: { sessions: [], currentSessionId: null, isLoading: false, openSession: vi.fn(), beginNewSessionIn: vi.fn(), on: () => () => {} } }));
vi.mock("../stores/workspaces-store.js", () => ({ workspacesStore: { workspaces: [], isLoading: false, error: "", on: () => () => {} } }));
vi.mock("../stores/workspace-store.js", () => ({ workspaceStore: { setActiveWorkspace: vi.fn() } }));
vi.mock("../stores/notebook-store.js", () => ({ notebookStore: { loadAll: vi.fn() } }));
vi.mock("../api/terminal.js", () => ({ listRuns: vi.fn(), getRun: vi.fn(), archiveRun: vi.fn() }));

import { listRuns, getRun } from "../api/terminal.js";
import { appStore } from "../stores/app-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { PracticePage } from "./PracticePage.js";

beforeEach(() => {
	vi.clearAllMocks();
	sessionsStore.sessions = ["one", "two"].map((id) => ({ id, name: `lesson-${id}`, preview: "", channels: ["web"], createdAt: "", updatedAt: "2026-10-04T00:00:00Z", messageCount: 1, archived: id === "two" }));
	sessionsStore.currentSessionId = "one";
	sessionsStore.isLoading = false;
	workspacesStore.workspaces = ["one", "two"].map((id) => ({ id: `ws-${id}`, name: `workspace-${id}`, relPath: id, sessionIds: [id], createdAt: "", updatedAt: "", isTemp: false }));
	workspacesStore.isLoading = false;
	workspacesStore.error = "";
	vi.mocked(sessionsStore.openSession).mockImplementation(async (id) => { sessionsStore.currentSessionId = id; });
	vi.mocked(listRuns).mockImplementation(async (sessionId) => [{ id: `run-${sessionId}`, sessionId, workspaceId: `ws-${sessionId}`, logPath: "/practice/log", outputBytes: 12, command: `echo ${sessionId}`, cwd: "/practice", startedAt: "2026-10-04T00:00:00Z", endedAt: "2026-10-04T00:00:01Z", exitCode: 0 }]);
	vi.mocked(getRun).mockImplementation(async (runId) => ({ id: runId, sessionId: runId.slice(4), workspaceId: `ws-${runId.slice(4)}`, logPath: "/practice/log", outputBytes: 12, command: `echo ${runId.slice(4)}`, cwd: "/practice", startedAt: "2026-10-04T00:00:00Z", exitCode: 0, outputTail: `output:${runId}` }));
});
afterEach(cleanup);

describe("practice records page", () => {
	it("browses archived sessions and resets run detail without activating the chat", async () => {
		render(<PracticePage />);
		expect(await screen.findByText("output:run-one")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("练习记录"), { target: { value: "two" } });
		expect(screen.queryByText("output:run-one")).toBeNull();
		expect(await screen.findByText("output:run-two")).toBeTruthy();
		expect(listRuns).toHaveBeenCalledWith("two", 30);
		expect((screen.getByLabelText("学习工作区") as HTMLSelectElement).value).toBe("ws-two");
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBe("one");
		expect(appStore.setPage).not.toHaveBeenCalled();
	});

	it("opens the selected workspace and offers the separate learner evidence page", async () => {
		render(<PracticePage />);
		await screen.findByText("output:run-one");
		fireEvent.change(screen.getByLabelText("学习工作区"), { target: { value: "ws-two" } });
		fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
		await waitFor(() => expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("ws-two"));
		expect(appStore.setPage).toHaveBeenCalledWith("chat");
		expect(appStore.setWorkspaceMode).toHaveBeenCalledWith("half");
		expect(sessionsStore.openSession).toHaveBeenCalledWith("two");
		expect(sessionsStore.currentSessionId).toBe("two");
		expect(screen.getByText(/退出码 0 仅表示命令正常结束/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "查看学习状态与证据" }));
		expect(appStore.setPage).toHaveBeenCalledWith("learner");
	});

	it("prepares a new conversation when the chosen workspace has no linked session", async () => {
		workspacesStore.workspaces[1].sessionIds = [];
		render(<PracticePage />);
		await screen.findByText("output:run-one");
		fireEvent.change(screen.getByLabelText("学习工作区"), { target: { value: "ws-two" } });
		fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
		expect(sessionsStore.beginNewSessionIn).toHaveBeenCalledWith("ws-two");
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
		expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("ws-two");
	});

	it("prefers the selected record session when a workspace has several conversations", async () => {
		workspacesStore.workspaces[0].sessionIds = ["one", "two"];
		sessionsStore.sessions[1].updatedAt = "2026-10-05T00:00:00Z";
		render(<PracticePage />);
		await screen.findByText("output:run-one");
		fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
		await waitFor(() => expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("ws-one"));
		expect(sessionsStore.openSession).toHaveBeenCalledWith("one");
	});

	it("does not replace workspace after a failed or superseded session open", async () => {
		vi.mocked(sessionsStore.openSession).mockImplementation(async () => { sessionsStore.currentSessionId = null; });
		render(<PracticePage />);
		await screen.findByText("output:run-one");
		fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
		await waitFor(() => expect(sessionsStore.currentSessionId).toBeNull());
		expect(workspaceStore.setActiveWorkspace).not.toHaveBeenCalled();
		expect(appStore.setWorkspaceMode).not.toHaveBeenCalled();
	});

	it("shows an empty state without querying a made-up session", () => {
		sessionsStore.sessions = [];
		sessionsStore.currentSessionId = null;
		workspacesStore.workspaces = [];
		render(<PracticePage />);
		expect(screen.getByText(/还没有学习会话/)).toBeTruthy();
		expect(screen.queryByLabelText("练习记录")).toBeNull();
		expect(listRuns).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
		expect(appStore.setPage).toHaveBeenCalledWith("chat");
	});

	it("surfaces a failed record load instead of presenting it as mastery evidence", async () => {
		vi.mocked(listRuns).mockRejectedValue(new Error("records unavailable"));
		render(<PracticePage />);
		expect(await screen.findByText("records unavailable")).toBeTruthy();
		await waitFor(() => expect(getRun).not.toHaveBeenCalled());
	});
});

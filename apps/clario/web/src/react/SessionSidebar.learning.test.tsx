// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../api/sessions.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
	t: (key: string, fallback?: unknown) => typeof fallback === "string" ? fallback : key,
	i18n: { language: "zh-CN" },
}) }));
vi.mock("../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("../stores/chat-store.js", () => ({ chatStore: { clear: vi.fn() } }));
vi.mock("../stores/settings-store.js", () => ({ settingsStore: { settings: {}, on: () => () => {} } }));
vi.mock("../stores/theme-store.js", () => ({ themeStore: { current: "light", save: vi.fn(), on: () => () => {} } }));
vi.mock("../stores/workspace-store.js", () => ({ workspaceStore: { activeWorkspaceId: null, setActiveWorkspace: vi.fn(), on: () => () => {} } }));
vi.mock("../stores/workspaces-store.js", () => ({ workspacesStore: { workspaces: [], on: () => () => {} } }));
vi.mock("../stores/app-store.js", () => ({ appStore: { page: "chat", setPage: vi.fn(), setSidebarCollapsed: vi.fn(), setRightPanelTab: vi.fn(), setWorkspaceWidth: vi.fn(), setWorkspaceMode: vi.fn(), on: () => () => {} } }));
vi.mock("../stores/sessions-store.js", () => ({ sessionsStore: {
	sessions: [], currentSessionId: null, isLoading: false, openingSessionId: null,
	channelFilter: null, searchQuery: "", availableChannels: ["web", "cli"], filteredSessions: [],
	on: () => () => {}, openSession: vi.fn(), beginNewSessionIn: vi.fn(), setChannelFilter: vi.fn(),
} }));

import { appStore } from "../stores/app-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { SessionSidebar } from "./SessionSidebar.js";

const session = (id: string, channel: "web" | "cli"): SessionMeta => ({
	id, name: `${id} 历史课`, preview: "", channels: [channel],
	createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", messageCount: 2,
});

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
	settingsStore.settings = { defaultModel: "", defaultProvider: "", providers: {} };
	sessionsStore.sessions = [session("网页", "web"), session("命令行", "cli")];
	sessionsStore.currentSessionId = null;
	workspacesStore.workspaces = [];
	vi.mocked(sessionsStore.openSession).mockImplementation(async (id) => { sessionsStore.currentSessionId = id; });
	Object.assign(sessionsStore, { filteredSessions: sessionsStore.sessions, channelFilter: null, searchQuery: "" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("learning sidebar", () => {
	it("keeps the full navigation and channel filters when experience is omitted", () => {
		const { container } = render(<SessionSidebar collapsed={false} />);
		const nav = within(screen.getByRole("navigation"));
		expect(nav.getByRole("button", { name: "nav.skills" })).toBeTruthy();
		expect(nav.getByRole("button", { name: "nav.jobs" })).toBeTruthy();
		expect(nav.queryByRole("button", { name: "工作区与练习" })).toBeNull();
		expect(container.querySelectorAll(".inno-channel-filter-chip").length).toBe(3);
	});

	it("offers all learning destinations and preserves history across a hidden channel filter", () => {
		settingsStore.settings!.experience = "learning";
		Object.assign(sessionsStore, { channelFilter: "web", filteredSessions: [sessionsStore.sessions[0]] });
		const { container } = render(<SessionSidebar collapsed={false} />);
		const nav = within(screen.getByRole("navigation"));
		for (const name of ["开始学习", "知识库", "技能管理", "学习状态", "工作区与练习", "学习计划"]) expect(nav.getByRole("button", { name })).toBeTruthy();
		expect(nav.queryByRole("button", { name: "nav.skills" })).toBeNull();
		expect(nav.queryByRole("button", { name: "nav.jobs" })).toBeNull();
		expect(container.querySelectorAll(".inno-channel-filter-chip")).toHaveLength(0);
		expect(screen.getAllByText("网页 历史课").length).toBeGreaterThan(0);
		expect(screen.getAllByText("命令行 历史课").length).toBeGreaterThan(0);
		expect(sessionsStore.setChannelFilter).not.toHaveBeenCalled();
		for (const [name, page] of [["技能管理", "skills"], ["学习计划", "jobs"], ["工作区与练习", "practice"]]) {
			fireEvent.click(nav.getByRole("button", { name }));
			expect(appStore.setPage).toHaveBeenLastCalledWith(page);
		}
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
	});

	it("still narrows historical sessions by text in learning mode", () => {
		settingsStore.settings!.experience = "learning";
		sessionsStore.searchQuery = "命令行";
		render(<SessionSidebar collapsed={false} />);
		expect(screen.queryByText("网页 历史课")).toBeNull();
		expect(screen.getAllByText("命令行 历史课").length).toBeGreaterThan(0);
	});

	it("opens the latest linked session even when search hides it", async () => {
		settingsStore.settings!.experience = "learning";
		workspacesStore.workspaces = [{ id: "project", name: "项目工作区", relPath: "project", createdAt: "", updatedAt: "", isTemp: false, sessionIds: ["网页", "命令行"] }];
		sessionsStore.sessions[1].updatedAt = "2026-10-05T00:00:00Z";
		sessionsStore.searchQuery = "网页";
		render(<SessionSidebar collapsed={false} />);
		fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
		await waitFor(() => expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("project"));
		expect(sessionsStore.openSession).toHaveBeenCalledWith("命令行");
		expect(appStore.setWorkspaceMode).toHaveBeenCalledWith("half");
	});

	it("keeps the current linked conversation ahead of a newer one", async () => {
		settingsStore.settings!.experience = "learning";
		workspacesStore.workspaces = [{ id: "project", name: "项目工作区", relPath: "project", createdAt: "", updatedAt: "", isTemp: false, sessionIds: ["网页", "命令行"] }];
		sessionsStore.currentSessionId = "网页";
		sessionsStore.sessions[1].updatedAt = "2026-10-05T00:00:00Z";
		render(<SessionSidebar collapsed={false} />);
		fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
		await waitFor(() => expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("project"));
		expect(sessionsStore.openSession).toHaveBeenCalledWith("网页");
	});

	it("prepares an empty workspace for a new learning session", () => {
		settingsStore.settings!.experience = "learning";
		workspacesStore.workspaces = [{ id: "project", name: "项目工作区", relPath: "project", createdAt: "", updatedAt: "", isTemp: false, sessionIds: [] }];
		render(<SessionSidebar collapsed={false} />);
		fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
		expect(sessionsStore.beginNewSessionIn).toHaveBeenCalledWith("project");
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
		expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("project");
	});

	it("does not open files after a failed or superseded conversation load", async () => {
		settingsStore.settings!.experience = "learning";
		workspacesStore.workspaces = [{ id: "project", name: "项目工作区", relPath: "project", createdAt: "", updatedAt: "", isTemp: false, sessionIds: ["网页"] }];
		vi.mocked(sessionsStore.openSession).mockImplementation(async () => { sessionsStore.currentSessionId = null; });
		render(<SessionSidebar collapsed={false} />);
		fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
		await waitFor(() => expect(sessionsStore.openSession).toHaveBeenCalledWith("网页"));
		expect(workspaceStore.setActiveWorkspace).not.toHaveBeenCalled();
		expect(appStore.setWorkspaceMode).not.toHaveBeenCalled();
	});

	it("retains the old file-only workspace action in full mode", () => {
		workspacesStore.workspaces = [{ id: "project", name: "项目工作区", relPath: "project", createdAt: "", updatedAt: "", isTemp: false, sessionIds: ["网页"] }];
		render(<SessionSidebar collapsed={false} />);
		fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
		expect(workspaceStore.setActiveWorkspace).toHaveBeenCalledWith("project");
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
		expect(sessionsStore.beginNewSessionIn).not.toHaveBeenCalled();
	});
});

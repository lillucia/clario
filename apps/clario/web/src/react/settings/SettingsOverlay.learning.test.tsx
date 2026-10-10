// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: "zh-CN" } }) }));
vi.mock("../../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("../../stores/app-store.js", () => ({ appStore: { settingsOpen: true, activeSettingsTab: "general", setSettingsTab: vi.fn(), closeSettings: vi.fn(), on: () => () => {} } }));
vi.mock("../../stores/settings-store.js", () => ({ settingsStore: { settings: {}, isLoading: false, load: vi.fn(), on: () => () => {} } }));
vi.mock("../../stores/theme-store.js", () => ({ themeStore: { current: "light", on: () => () => {} }, THEME_IDS: ["light"], THEME_PREVIEW_COLORS: { light: "#fff" } }));
vi.mock("./ModelsSettings.js", () => ({ ModelsSettings: () => <div>models-content</div> }));
vi.mock("./MemorySettings.js", () => ({ MemorySettings: () => <div>memory-content</div> }));
vi.mock("./IntegrationsSettings.js", () => ({ IntegrationsSettings: () => <div>integrations-content</div> }));
vi.mock("./ChannelsSettings.js", () => ({ ChannelsSettings: () => <div>channels-content</div> }));
vi.mock("./McpSettings.js", () => ({ McpSettings: () => <div>mcp-content</div> }));
vi.mock("./AboutSettings.js", () => ({ AboutSettings: () => <div>about-content</div> }));
vi.mock("./SmartInputSettings.js", () => ({ SmartInputSettings: () => <div>lab-content</div> }));

import { appStore } from "../../stores/app-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { SettingsOverlay } from "./SettingsOverlay.js";

beforeEach(() => {
	vi.clearAllMocks();
	appStore.activeSettingsTab = "general";
	settingsStore.settings = { experience: "learning", defaultProvider: "", defaultModel: "", providers: {} };
});
afterEach(cleanup);

describe("learning settings", () => {
	it("keeps general/model/memory tabs and omits desktop controls", () => {
		const { container } = render(<SettingsOverlay />);
		const tabs = within(container.querySelector("aside")!);
		expect(tabs.getAllByRole("button")).toHaveLength(3);
		for (const tab of ["general", "models", "memory"]) expect(tabs.getByRole("button", { name: `settings.tabs.${tab}` })).toBeTruthy();
		expect(screen.getByText("settings.theme")).toBeTruthy();
		expect(screen.getByText("settings.language")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "settings.markdownMath.title" })).toBeTruthy();
		expect(screen.queryByText("settings.closeBehavior.title")).toBeNull();
		expect(screen.queryByRole("switch", { name: "settings.computerUse.title" })).toBeNull();
		fireEvent.click(tabs.getByRole("button", { name: "settings.tabs.models" }));
		expect(appStore.setSettingsTab).toHaveBeenCalledWith("models");
	});

	it.each(["integrations", "channels", "mcp", "lab", "about"] as const)("replaces a stale %s tab before mounting its content", (tab) => {
		appStore.activeSettingsTab = tab;
		render(<SettingsOverlay />);
		expect(screen.queryByText(`${tab}-content`)).toBeNull();
		expect(screen.getByText("settings.theme")).toBeTruthy();
		expect(appStore.setSettingsTab).toHaveBeenCalledWith("general");
	});

	it.each(["models", "memory"] as const)("keeps the %s editor accessible", (tab) => {
		appStore.activeSettingsTab = tab;
		render(<SettingsOverlay />);
		expect(screen.getByText(`${tab}-content`)).toBeTruthy();
		expect(appStore.setSettingsTab).not.toHaveBeenCalled();
	});

	it("preserves all old tabs and desktop controls when experience is omitted", () => {
		delete settingsStore.settings!.experience;
		const { container } = render(<SettingsOverlay />);
		expect(within(container.querySelector("aside")!).getAllByRole("button")).toHaveLength(8);
		expect(screen.getByText("settings.closeBehavior.title")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "settings.computerUse.title" })).toBeTruthy();
	});
});

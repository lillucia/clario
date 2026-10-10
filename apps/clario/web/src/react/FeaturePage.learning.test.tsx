// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock("react-dnd", () => ({ useDragDropManager: vi.fn() }));
vi.mock("../stores/settings-store.js", () => ({ settingsStore: { settings: {}, on: () => () => {} } }));
vi.mock("../stores/app-store.js", () => ({ appStore: { setPage: vi.fn() } }));
vi.mock("./SkillsPanel.js", () => ({ SkillsPanel: () => <div>full-skills</div> }));
vi.mock("./JobsPanel.js", () => ({ JobsPanel: () => <div>full-jobs</div> }));
vi.mock("./Notebook.js", () => ({ Notebook: () => <div>knowledge-content</div> }));
vi.mock("./LearnerProfilePanel.js", () => ({ LearnerProfilePanel: () => <div>learner-content</div> }));
vi.mock("./PracticePage.js", () => ({ PracticePage: () => <div>practice-records</div> }));

import { settingsStore } from "../stores/settings-store.js";
import { FeaturePage } from "./FeaturePage.js";

beforeEach(() => { vi.clearAllMocks(); settingsStore.settings = { experience: "learning", defaultModel: "", defaultProvider: "", providers: {} }; });
afterEach(cleanup);

describe("learning feature page navigation", () => {
	it.each([["skills", "技能管理"], ["jobs", "学习计划"]] as const)("mounts %s from a direct URL with its learning title", async (page, title) => {
		render(<FeaturePage page={page} />);
		expect(screen.getByRole("heading", { name: title })).toBeTruthy();
		expect(await screen.findByText(`full-${page}`)).toBeTruthy();
	});
	it.each(["skills", "jobs"] as const)("keeps %s accessible when experience is omitted", async (page) => {
		delete settingsStore.settings!.experience;
		render(<FeaturePage page={page} />);
		expect(screen.getByRole("heading", { name: `${page}.title` })).toBeTruthy();
		expect(await screen.findByText(`full-${page}`)).toBeTruthy();
	});
	it("mounts the practice page", async () => {
		render(<FeaturePage page="practice" />);
		expect(screen.getByRole("heading", { name: "工作区与练习" })).toBeTruthy();
		expect(await screen.findByText("practice-records")).toBeTruthy();
	});
});

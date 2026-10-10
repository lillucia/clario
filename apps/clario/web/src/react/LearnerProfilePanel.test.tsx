// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { learnerStore } from "../stores/learner-store.js";
import { LearnerProfilePanel } from "./LearnerProfilePanel.js";

vi.mock("../stores/learner-store.js", () => ({
	learnerStore: {
		profile: null,
		isLoading: false,
		isSaving: false,
		error: null,
		on: () => () => {},
		load: vi.fn().mockResolvedValue(undefined),
		addGoal: vi.fn().mockResolvedValue(undefined),
		patchGoal: vi.fn().mockResolvedValue(undefined),
	},
}));

const copy = (key: string) => i18n.t(key);
function openGoalForm() {
	render(<LearnerProfilePanel />);
	fireEvent.click(screen.getByRole("button", { name: copy("profile.goals.addNew") }));
	return screen.getByRole("dialog", { name: copy("profile.goals.newTitle") });
}

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.profile = {
		learner_id: "learner-1", version: 1, updated_at: "2026-10-04T00:00:00Z",
		profile_summary: "", goals: [], knowledge_states: [], misconceptions: [],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	};
});
afterEach(cleanup);

describe("learner goal details", () => {
	it("keeps multiline criteria while typing and saves the existing L1 goal contract", async () => {
		const dialog = openGoalForm();
		const form = within(dialog);
		expect(form.getByRole<HTMLButtonElement>("button", { name: copy("common.save") }).disabled).toBe(true);
		fireEvent.change(form.getByLabelText(copy("profile.goals.title")), { target: { value: "  掌握二分查找  " } });
		fireEvent.change(form.getByLabelText(copy("profile.goals.type")), { target: { value: "project" } });
		fireEvent.change(form.getByLabelText(copy("profile.goals.status")), { target: { value: "paused" } });
		fireEvent.change(form.getByRole("slider"), { target: { value: "70" } });
		const criteria = form.getByLabelText<HTMLTextAreaElement>(copy("profile.goals.successCriteria"));
		fireEvent.change(criteria, { target: { value: "解释循环条件\n" } });
		expect(criteria.value).toBe("解释循环条件\n");
		fireEvent.change(criteria, { target: { value: "解释循环条件\n\n 独立完成一道题 \n" } });
		fireEvent.submit(dialog);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(learnerStore.addGoal).toHaveBeenCalledWith({
			title: "掌握二分查找", type: "project", status: "paused", priority: 0.7,
			success_criteria: ["解释循环条件", "独立完成一道题"],
		});
	});

	it("shows a save failure inside the dialog and retains the draft for retry", async () => {
		vi.mocked(learnerStore.addGoal).mockRejectedValueOnce(new Error("保存服务暂时不可用"));
		const dialog = openGoalForm();
		const form = within(dialog);
		fireEvent.change(form.getByLabelText(copy("profile.goals.title")), { target: { value: "理解递归" } });
		fireEvent.change(form.getByLabelText(copy("profile.goals.successCriteria")), { target: { value: "说明终止条件\n" } });
		fireEvent.submit(dialog);
		expect((await form.findByRole("alert")).textContent).toContain("保存服务暂时不可用");
		expect(form.getByLabelText<HTMLInputElement>(copy("profile.goals.title")).value).toBe("理解递归");
		expect(form.getByLabelText<HTMLTextAreaElement>(copy("profile.goals.successCriteria")).value).toBe("说明终止条件\n");
		fireEvent.submit(dialog);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(learnerStore.addGoal).toHaveBeenCalledTimes(2);
		expect(vi.mocked(learnerStore.addGoal).mock.calls[1]).toEqual(vi.mocked(learnerStore.addGoal).mock.calls[0]);
	});

	it("prevents duplicate creation and accidental dismissal while saving", async () => {
		let finish!: () => void;
		vi.mocked(learnerStore.addGoal).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({} as never); }));
		const dialog = openGoalForm();
		fireEvent.change(within(dialog).getByLabelText(copy("profile.goals.title")), { target: { value: "理解数组" } });
		fireEvent.submit(dialog);
		fireEvent.submit(dialog);
		fireEvent.click(dialog.parentElement!);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(learnerStore.addGoal).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("dialog")).toBe(dialog);
		finish();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("edits existing goal details without losing newline input or changing provenance", async () => {
		learnerStore.profile!.goals = [{
			goal_id: "goal-1", title: "理解数组", type: "concept", status: "active", priority: 0.5,
			success_criteria: ["解释索引"], source: "agent_inferred", updated_at: "2026-10-04T00:00:00Z",
		}];
		render(<LearnerProfilePanel />);
		fireEvent.click(screen.getByRole("button", { name: copy("common.edit") }));
		const criteria = screen.getByLabelText<HTMLTextAreaElement>(copy("profile.goals.successCriteria"));
		fireEvent.change(criteria, { target: { value: "解释索引\n" } });
		expect(criteria.value).toBe("解释索引\n");
		fireEvent.change(criteria, { target: { value: "解释索引\n 遍历数组 \n" } });
		fireEvent.click(screen.getByRole("button", { name: copy("common.save") }));
		await waitFor(() => expect(screen.queryByLabelText(copy("profile.goals.successCriteria"))).toBeNull());
		expect(learnerStore.patchGoal).toHaveBeenCalledWith("goal-1", {
			title: "理解数组", type: "concept", status: "active", priority: 0.5,
			success_criteria: ["解释索引", "遍历数组"],
		});
	});
});

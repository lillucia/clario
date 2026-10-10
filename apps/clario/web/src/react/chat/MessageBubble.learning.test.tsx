// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types/chat.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
	t: (key: string, fallback?: string, options?: { goal?: string }) => (fallback ?? key).replace("{{goal}}", options?.goal ?? ""),
	i18n: { language: "zh-CN" },
}) }));

import { MessageBubble } from "./MessageBubble.js";

const prompt = "我想开始一轮学习。\n\n学习目标：理解二分查找\n\n该目标已由我在页面中保存，goal_id 为 \"goal-1\"。请调用 record_learning_event 记录本次声明，参数为 {\"event_type\":\"goal_declared\"}。";
const message: ChatMessage = { role: "user", channel: "web", content: prompt, timestamp: 1, entryId: "learning-entry" };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("learning-entry user message", () => {
	it("shows a natural goal summary and lets the user expand and collapse the full original text", () => {
		const { container } = render(<MessageBubble message={message} />);
		const summary = screen.getByRole("button", { name: "开始学习：理解二分查找" });
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("goal_id");
		expect(container.textContent).not.toContain("record_learning_event");
		fireEvent.click(summary);
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText(prompt, { normalizer: (text) => text }).textContent).toBe(prompt);
		fireEvent.click(summary);
		expect(container.textContent).not.toContain("goal_id");
	});

	it("keeps attachments visible and openable while the prompt is collapsed", () => {
		const file = { path: "lessons.pdf", kind: "pdf" as const, source: "workspace" as const };
		const onOpenAttachment = vi.fn();
		render(<MessageBubble message={{ ...message, attachments: { bindings: [], loose: [file] } }} onOpenAttachment={onOpenAttachment} />);
		fireEvent.click(screen.getByTitle("lessons.pdf"));
		expect(onOpenAttachment).toHaveBeenCalledWith(file);
		expect(screen.queryByText(/goal_id/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "开始学习：理解二分查找" }));
		expect(screen.getByTitle("lessons.pdf")).toBeTruthy();
		expect(screen.getByText(/goal_id/)).toBeTruthy();
	});

	it.each([
		"我想学习二分查找。\n请先解释边界条件。",
		"我想开始一轮学习。\n学习目标：理解二分查找\n这是普通输入。",
	])("keeps ordinary or near-matching user messages unchanged: %s", (content) => {
		render(<MessageBubble message={{ ...message, content }} />);
		expect(screen.getByText(content, { normalizer: (text) => text }).textContent).toBe(content);
		expect(screen.queryByRole("button", { name: /^开始学习：/ })).toBeNull();
	});

	it("preserves existing first-line scheduler presentation", () => {
		const content = "复习提醒\n内部任务参数";
		render(<MessageBubble message={{ ...message, channel: "scheduler", content }} />);
		expect(screen.getByText("复习提醒").getAttribute("title")).toBe(content);
		expect(screen.queryByRole("button", { name: /^开始学习：/ })).toBeNull();
	});

	it("copies and edits the original prompt even when only its summary is visible", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		const previousClipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		try {
			const onEdit = vi.fn();
			render(<MessageBubble message={message} onEdit={onEdit} />);
			fireEvent.click(screen.getByRole("button", { name: "common.copy" }));
			await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
			fireEvent.click(screen.getByRole("button", { name: "chat.editAndResend" }));
			expect(onEdit).toHaveBeenCalledWith(message);
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: previousClipboard });
		}
	});
});

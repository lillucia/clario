import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsStore } from "./settings-store.js";
import type { InnoSettings } from "../types/settings.js";

const learningSettings: InnoSettings = { experience: "learning", defaultProvider: "test", defaultModel: "dummy", providers: {} };

beforeEach(() => {
	settingsStore.settings = null;
	settingsStore.error = null;
	settingsStore.isLoading = false;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("settings reload", () => {
	it("preserves the last learning configuration through an HTTP 500", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json(learningSettings))
			.mockResolvedValueOnce(Response.json({ error: "settings unavailable" }, { status: 500 }));
		await settingsStore.load();
		const loaded = settingsStore.settings;
		const changes: { experience?: string; loading: boolean; error: string | null }[] = [];
		const unsubscribe = settingsStore.on("change", () => changes.push({ experience: settingsStore.settings?.experience, loading: settingsStore.isLoading, error: settingsStore.error }));
		try {
			await settingsStore.load();
		} finally {
			unsubscribe();
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.every(([url]) => url === "/api/settings")).toBe(true);
		expect(settingsStore.settings).toBe(loaded);
		expect(settingsStore.settings?.experience).toBe("learning");
		expect(settingsStore.error).toBe("settings unavailable");
		expect(changes).toEqual([
			{ experience: "learning", loading: true, error: null },
			{ experience: "learning", loading: false, error: "settings unavailable" },
		]);
	});

	it("keeps settings unknown after an initial failure and accepts a later recovery", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json({ error: "startup failed" }, { status: 500 }))
			.mockResolvedValueOnce(Response.json(learningSettings));
		await settingsStore.load();
		expect(settingsStore.settings).toBeNull();
		expect(settingsStore.error).toBe("startup failed");
		expect(settingsStore.isLoading).toBe(false);
		await settingsStore.load();
		expect(settingsStore.settings).toEqual(learningSettings);
		expect(settingsStore.error).toBeNull();
		expect(settingsStore.isLoading).toBe(false);
	});

	it("replaces the cached mode when a successful response explicitly changes it", async () => {
		settingsStore.settings = learningSettings;
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ...learningSettings, experience: "full" }));
		await settingsStore.load();
		expect(settingsStore.settings?.experience).toBe("full");
	});
});

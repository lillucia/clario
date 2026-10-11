import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getEffectiveConfig, getExperience,
	isComputerUseEnabled, loadConfig, normalizeConfig, saveConfig, type InnoConfig,
} from "./config.js";

const temporaryRoots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): InnoConfig {
	return {
		experience: "learning",
		defaultProvider: "test", defaultModel: "test-model",
		providers: { test: { apiKey: "test-only", baseUrl: "http://127.0.0.1:9", models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }] } },
		channels: { feishu: { enabled: true }, qq: { enabled: true, mode: "bridge", sidecarBaseUrl: "http://127.0.0.1:9" }, wechat: { enabled: true, mode: "ilink" }, wecom: { enabled: true } },
		subagents: { enabled: true }, mcp: { enabled: true },
		plugins: { todo: { enabled: true }, webAccess: { enabled: true }, computerUse: { enabled: true }, permissionSystem: { enabled: true, mode: "default" } },
		memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
	};
}

describe("experience configuration", () => {
	it("keeps existing configurations in full mode and rejects invalid profile names", () => {
		const oldConfig = config();
		delete oldConfig.experience;
		expect(getExperience(oldConfig)).toBe("full");
		expect(normalizeConfig(oldConfig).experience).toBe("full");
		expect(getEffectiveConfig(oldConfig).subagents?.enabled).toBe(true);
		expect(() => normalizeConfig({ ...oldConfig, experience: "learnng" } as unknown as InnoConfig)).toThrow("experience must be");
	});

	it("disables complex features without mutating stored opt-ins or learning and permission settings", () => {
		const stored = config();
		const before = JSON.stringify(stored);
		const effective = getEffectiveConfig(stored);
		expect(Object.values(effective.channels ?? {}).every(channel => channel?.enabled === false)).toBe(true);
		expect(effective.subagents?.enabled).toBe(false);
		expect(effective.mcp?.enabled).toBe(false);
		for (const name of ["todo", "webAccess", "computerUse"] as const) expect(effective.plugins?.[name]?.enabled).toBe(false);
		expect(effective.memory).toEqual(stored.memory);
		expect(effective.plugins?.permissionSystem).toEqual(stored.plugins?.permissionSystem);
		expect(JSON.stringify(stored)).toBe(before);
	});

	it("preserves preferences across saves and restores them on a full-mode restart", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-experience-config-"));
		temporaryRoots.push(root);
		const path = join(root, "config.json");
		const stored = saveConfig(path, config());
		getEffectiveConfig(stored);
		saveConfig(path, { ...stored, ui: { theme: "dark", closeBehavior: "ask", mathSingleDollar: false } });
		const persisted = JSON.parse(readFileSync(path, "utf8")) as InnoConfig;
		expect(persisted.channels?.feishu?.enabled).toBe(true);
		expect(persisted.plugins?.computerUse?.enabled).toBe(true);
		expect(persisted.mcp?.enabled).toBe(true);
		saveConfig(path, { ...loadConfig(path), experience: "full" });
		const restored = getEffectiveConfig(loadConfig(path));
		expect(Object.values(restored.channels ?? {}).every(channel => channel?.enabled === true)).toBe(true);
		expect(restored.subagents?.enabled).toBe(true);
		expect(restored.mcp?.enabled).toBe(true);
		for (const name of ["todo", "webAccess", "computerUse"] as const) expect(restored.plugins?.[name]?.enabled).toBe(true);
	});

	it("disables computer-use opt-ins in learning mode and ignores legacy desktop defaults", () => {
		vi.stubEnv("INNO_DESKTOP", "1");
		expect(isComputerUseEnabled(config())).toBe(false);
		expect(isComputerUseEnabled({ ...config(), plugins: undefined })).toBe(false);
		expect(isComputerUseEnabled({ ...config(), experience: "full", plugins: undefined })).toBe(false);
	});

});

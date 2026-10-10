import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/pi-runner.js", () => ({
	getSession: vi.fn(() => ({ model: undefined })), getAvailableModels: vi.fn(() => []),
	refreshConfiguredProviders: vi.fn(), switchModel: vi.fn(), syncConfig: vi.fn(),
}));
vi.mock("../../channels/feishu/feishu-registration.js", () => ({
	feishuRegistrationBegin: vi.fn(), feishuRegistrationPoll: vi.fn(),
}));
vi.mock("../../channels/wechat/wechat-channel.js", () => ({ WeChatChannel: vi.fn() }));

import { ChannelRegistry } from "../../channels/channel.js";
import { feishuRegistrationBegin, feishuRegistrationPoll } from "../../channels/feishu/feishu-registration.js";
import { WeChatChannel } from "../../channels/wechat/wechat-channel.js";
import { normalizeConfig, type InnoConfig } from "../../config.js";
import { resolveRuntimePaths, type RuntimePaths } from "../../runtime.js";
import { handleChannelsRoutes, type ChannelsRouteContext } from "./channels.js";
import { handleSettingsRoutes, type SettingsRouteContext } from "./settings.js";

let root: string;
let paths: RuntimePaths;
let config: InnoConfig;
let settings: SettingsRouteContext;
let channels: ChannelsRouteContext;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "inno-experience-routes-"));
	paths = resolveRuntimePaths({ home: root, configDir: join(root, "config"), dataDir: join(root, "data"), skillsDir: join(root, "skills"), workspaceDir: join(root, "workspace") });
	config = normalizeConfig({
		experience: "learning", defaultProvider: "test", defaultModel: "test",
		providers: { test: { apiKey: "test-only", baseUrl: "http://127.0.0.1:9", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }] } },
		channels: { feishu: { enabled: true }, wechat: { enabled: true, mode: "ilink" } },
		subagents: { enabled: true }, mcp: { enabled: true },
		plugins: { todo: { enabled: true }, webAccess: { enabled: true }, computerUse: { enabled: true } },
	});
	const getConfig = () => config;
	const setConfig = vi.fn((next: InnoConfig) => { config = next; });
	const reloadFeishuChannel = vi.fn(async () => {});
	settings = { paths, getConfig, setConfig, reloadFeishuChannel, scheduleSkillsReload: vi.fn(), invalidateContentSource: vi.fn() };
	channels = {
		channelRegistry: new ChannelRegistry(join(root, "targets.json")), dataDir: paths.dataDir, configPath: paths.configPath,
		getConfig, setConfig, reloadFeishuChannel, getDispatcher: vi.fn(() => null), getBridgeToken: vi.fn(() => "test-token"),
		getWechatChannel: vi.fn(() => null), setWechatChannel: vi.fn(),
	};
});

afterEach(() => {
	vi.clearAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function request(body: unknown): HttpReq {
	const req = Readable.from([JSON.stringify(body)]) as HttpReq;
	req.headers = {};
	return req;
}

function response(): ServerResponse & { statusCode: number; payload: Record<string, any> } {
	const res = {
		statusCode: 0,
		payload: {} as Record<string, any>,
		writeHead(status: number) { res.statusCode = status; return res; },
		end(body?: string) { res.payload = body ? JSON.parse(body) : undefined; return res; },
	};
	return res as unknown as ServerResponse & { statusCode: number; payload: Record<string, any> };
}

describe("learning experience HTTP gates", () => {
	it.each([["GET", "/"], ["HEAD", "/"], ["GET", "/assets/app.js"]])("leaves %s %s to static routing before configuration is initialized", async (method, url) => {
		const getConfig = vi.fn((): InnoConfig => { throw new Error("Configuration has not been initialized"); });
		const settingsRes = response();
		const channelsRes = response();
		expect(await handleSettingsRoutes(request({}), settingsRes, method, url, { ...settings, getConfig })).toBe(false);
		expect(await handleChannelsRoutes(request({}), channelsRes, method, url, { ...channels, getConfig })).toBe(false);
		expect(getConfig).not.toHaveBeenCalled();
		expect(settingsRes.statusCode).toBe(0);
		expect(channelsRes.statusCode).toBe(0);
	});

	it("reports effective settings while keeping all stored opt-ins intact", async () => {
		const before = JSON.stringify(config);
		const res = response();
		await handleSettingsRoutes(request({}), res, "GET", "/api/settings", settings);
		expect(res.statusCode).toBe(200);
		expect(res.payload.experience).toBe("learning");
		expect(res.payload.channels.feishu.enabled).toBe(false);
		expect(res.payload.subagents.enabled).toBe(false);
		expect(res.payload.mcp.enabled).toBe(false);
		for (const feature of ["todo", "webAccess", "computerUse"]) expect(res.payload.plugins[feature].enabled).toBe(false);
		expect(res.payload.plugins.permissionSystem.enabled).toBe(true);
		expect(res.payload.computerUse).toMatchObject({ enabled: false, explicit: true });
		expect(res.payload.providers.test.apiKey).not.toBe("test-only");
		expect(JSON.stringify(config)).toBe(before);
	});

	it.each([
		["PUT", "/api/settings/channels"], ["PUT", "/api/settings/computer-use"],
		["PUT", "/api/settings/mcp"], ["PUT", "/api/settings/web-access"],
		["PUT", "/api/mcp/servers/example"], ["PATCH", "/api/mcp/servers/example"], ["DELETE", "/api/mcp/servers/example"],
	])("blocks %s %s before changing stored configuration or hot-reloading", async (method, url) => {
		const before = JSON.stringify(config);
		const res = response();
		expect(await handleSettingsRoutes(request({ enabled: true, disabled: false, channels: { feishu: { enabled: true } } }), res, method, url, settings)).toBe(true);
		expect(res.statusCode).toBe(403);
		expect(res.payload.code).toBe("experience_restricted");
		expect(settings.setConfig).not.toHaveBeenCalled();
		expect(settings.reloadFeishuChannel).not.toHaveBeenCalled();
		expect(settings.scheduleSkillsReload).not.toHaveBeenCalled();
		expect(JSON.stringify(config)).toBe(before);
	});

	it.each([
		["POST", "/api/channels/feishu/qr-register"], ["GET", "/api/channels/feishu/qr-status?deviceCode=test"],
		["POST", "/api/channels/wechat/qr-login"], ["GET", "/api/channels/wechat/qr-status?qrId=test"],
		["POST", "/api/channels/feishu/test"], ["POST", "/api/channels/feishu/default-target"], ["POST", "/api/bridge/messages"],
	])("blocks channel activity through %s %s", async (method, url) => {
		const res = response();
		expect(await handleChannelsRoutes(request({}), res, method, url, channels)).toBe(true);
		expect(res.statusCode).toBe(403);
		expect(res.payload.code).toBe("experience_restricted");
		expect(feishuRegistrationBegin).not.toHaveBeenCalled();
		expect(feishuRegistrationPoll).not.toHaveBeenCalled();
		expect(WeChatChannel).not.toHaveBeenCalled();
		expect(channels.getDispatcher).not.toHaveBeenCalled();
		expect(channels.setConfig).not.toHaveBeenCalled();
	});

	it("reports no active channels or MCP connections", async () => {
		const channelRes = response();
		await handleChannelsRoutes(request({}), channelRes, "GET", "/api/channels", channels);
		expect(channelRes.payload).toEqual([]);
		const mcpRes = response();
		await handleSettingsRoutes(request({}), mcpRes, "GET", "/api/mcp", settings);
		expect(mcpRes.payload).toMatchObject({ enabled: false, adapterLoaded: false, servers: [], status: null });
	});

	it("keeps learning settings writable without persisting effective feature masks", async () => {
		const res = response();
		await handleSettingsRoutes(request({ l3Enabled: false }), res, "PUT", "/api/settings/memory", settings);
		expect(res.statusCode).toBe(200);
		expect(res.payload.memory.l3Enabled).toBe(false);
		expect(res.payload.mcp.enabled).toBe(false);
		const persisted = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(persisted.experience).toBe("learning");
		expect(persisted.channels.feishu.enabled).toBe(true);
		expect(persisted.mcp.enabled).toBe(true);
		expect(persisted.plugins.computerUse.enabled).toBe(true);
	});

	it("restores the original settings behavior in full mode", async () => {
		config.experience = "full";
		const res = response();
		await handleSettingsRoutes(request({ enabled: true }), res, "PUT", "/api/settings/mcp", settings);
		expect(res.statusCode).toBe(200);
		expect(res.payload.experience).toBe("full");
		expect(res.payload.mcp.enabled).toBe(true);
		expect(res.payload.plugins.todo.enabled).toBe(true);
		expect(res.payload.channels.feishu.enabled).toBe(true);
	});
});

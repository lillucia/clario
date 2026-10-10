import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths, type RuntimePaths } from "../runtime.js";
import { normalizeConfig } from "../config.js";
import { getManagedMcpConfigPath } from "../agent/mcp-extension.js";
import { getMcpOverview, readManagedMcpConfig, seedManagedMcpConfig } from "./mcp-config-store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("../logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));

let root: string;
let paths: RuntimePaths;
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "clario-mcp-store-"));
	vi.stubEnv("HOME", root);
	paths = resolveRuntimePaths({ home: root, configDir: join(root, "config"), dataDir: join(root, "data"), skillsDir: join(root, "skills"), workspaceDir: join(root, "workspace") });
	fs.mkdirSync(paths.configDir, { recursive: true });
});
afterEach(() => {
	vi.mocked(fs.renameSync).mockClear();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});
const legacyFile = () => join(paths.configDir, "mcp.json");
const managedFile = () => getManagedMcpConfigPath(paths);

// Use formatted bytes and unknown fields to ensure upgrades do not normalize
// away credentials, custom adapter settings, or comments embedded as fields.
const legacy = '{ "mcpServers": { "custom": { "command": "fixture", "env": { "KEY": "dummy" } } }, "future": true }\n';

describe("managed MCP config upgrade", () => {
	it("seeds only the new adapter filename with a disabled reference server", () => {
		seedManagedMcpConfig(paths);
		expect(managedFile()).toBe(join(paths.configDir, "mcp-adapter.json"));
		expect(fs.existsSync(legacyFile())).toBe(false);
		expect(readManagedMcpConfig(paths).mcpServers.weather.disabled).toBe(true);
	});
	it("moves the legacy managed config unchanged and is idempotent", () => {
		fs.writeFileSync(legacyFile(), legacy, { mode: 0o600 });
		seedManagedMcpConfig(paths);
		expect(fs.existsSync(legacyFile())).toBe(false);
		expect(fs.readFileSync(managedFile(), "utf8")).toBe(legacy);
		seedManagedMcpConfig(paths);
		expect(fs.readFileSync(managedFile(), "utf8")).toBe(legacy);
	});
	it("preserves both files and gives the existing adapter config precedence", () => {
		fs.writeFileSync(legacyFile(), legacy);
		const current = '{"mcpServers":{},"settings":{"future":true}}\n';
		fs.writeFileSync(managedFile(), current);
		seedManagedMcpConfig(paths);
		expect(fs.readFileSync(legacyFile(), "utf8")).toBe(legacy);
		expect(fs.readFileSync(managedFile(), "utf8")).toBe(current);
		expect(fs.renameSync).not.toHaveBeenCalled();
	});
	it("keeps corrupt legacy bytes for user repair instead of silently replacing them", () => {
		fs.writeFileSync(legacyFile(), "{broken");
		seedManagedMcpConfig(paths);
		expect(fs.readFileSync(managedFile(), "utf8")).toBe("{broken");
		expect(() => readManagedMcpConfig(paths)).toThrow();
	});
	it("does not seed after migration failure and retries on the next startup", () => {
		fs.writeFileSync(legacyFile(), legacy);
		vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("EACCES synthetic migration failure"); });
		seedManagedMcpConfig(paths);
		expect(fs.existsSync(managedFile())).toBe(false);
		expect(fs.readFileSync(legacyFile(), "utf8")).toBe(legacy);
		seedManagedMcpConfig(paths);
		expect(fs.readFileSync(managedFile(), "utf8")).toBe(legacy);
	});
	it("discovers adapter project overrides while leaving native project files untouched", () => {
		const projectPi = join(paths.workspaceDir, ".pi");
		fs.mkdirSync(projectPi, { recursive: true });
		fs.writeFileSync(managedFile(), JSON.stringify({ mcpServers: { shared: { command: "global" } } }));
		fs.writeFileSync(join(projectPi, "mcp-adapter.json"), JSON.stringify({ mcpServers: { shared: { command: "project" } } }));
		fs.writeFileSync(join(projectPi, "mcp.json"), JSON.stringify({ mcpServers: { nativeOnly: { command: "native" } } }));
		const overview = getMcpOverview(normalizeConfig({ providers: { test: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-unused", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512 }] } }, experience: "full", mcp: { enabled: true } }), paths);
		expect(overview.servers.map(server => server.name)).toEqual(["shared"]);
		expect(overview.servers[0]).toMatchObject({ definition: { command: "project" }, source: { kind: "project-pi", editable: false } });
	});
	it("learning mode hides preserved enabled MCP definitions without changing them", () => {
		fs.writeFileSync(managedFile(), legacy);
		const overview = getMcpOverview(normalizeConfig({ providers: { test: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-unused", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512 }] } }, experience: "learning", mcp: { enabled: true } }), paths);
		expect(overview).toMatchObject({ enabled: false, adapterLoaded: false, servers: [], status: null });
		expect(fs.readFileSync(managedFile(), "utf8")).toBe(legacy);
	});
});

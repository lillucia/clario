import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../../..");
const loader = pathToFileURL(join(projectRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cliPath = join(projectRoot, "apps/clario/src/cli.ts");
const piCliPath = join(projectRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "clario-mcp-cli-"));
	const configDir = join(root, "config");
	const workspace = join(root, "workspace");
	for (const dir of [configDir, join(workspace, ".pi"), join(root, "skills")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(configDir, "settings.json"), JSON.stringify({ telemetry: false, defaultProjectTrust: "always", extensions: ["-builtin:mcp"] }));
	// Exercise project override AND explicit -e: neither can revive native MCP.
	writeFileSync(join(workspace, ".pi/settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
	const probe = join(root, "probe.mjs");
	writeFileSync(probe, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.argv[2], "started\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  const result = req.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
});
lines.on("close", () => process.exit(0));
`);
	const marker = (name: string) => join(root, `${name}.started`);
	const definition = (name: string) => ({ command: process.execPath, args: [probe, marker(name)], lifecycle: "eager" });
	const legacy = JSON.stringify({ mcpServers: { native_global: definition("native-global") } });
	const managed = JSON.stringify({ mcpServers: { adapter: definition("adapter") } });
	writeFileSync(join(configDir, "mcp.json"), legacy);
	writeFileSync(join(configDir, "mcp-adapter.json"), managed);
	writeFileSync(join(workspace, ".pi/mcp.json"), JSON.stringify({ mcpServers: { native_project: definition("native-project") } }));
	function configure(experience: "learning" | "full", enabled: boolean) {
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			experience, defaultProvider: "fixture", defaultModel: "fixture", mcp: { enabled },
			providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-unused", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 512, input: ["text"] }] } },
			memory: { l1Enabled: false, l2Enabled: false, l3Enabled: false }, subagents: { enabled: false },
			plugins: { todo: { enabled: false }, webAccess: { enabled: false }, computerUse: { enabled: false }, permissionSystem: { enabled: false } },
		}));
	}
	return { root, configDir, workspace, marker, legacy, managed, configure };
}

async function start(f: ReturnType<typeof fixture>, native = false, shellCommand = false) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(INNO_|PI_)/.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
	}
	Object.assign(env, { HOME: f.root, INNO_HOME: f.root, INNO_DATA_DIR: join(f.root, "data"), PI_CODING_AGENT_DIR: f.configDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", LOG_LEVEL: "silent" });
	const args = native ? [piCliPath] : ["--import", loader, cliPath, "--home", f.root, "--config-dir", f.configDir, "--data-dir", join(f.root, "data"), "--skills-dir", join(f.root, "skills"), "--workspace-dir", f.workspace];
	args.push(...(shellCommand ? ["mcp", "list"] : ["--mode", "rpc", "--no-session", "--offline", "--approve", "-e", "builtin:mcp"]));
	if (native) args.push("--model", "openai/gpt-4o-mini", "--api-key", "synthetic-unused");
	const child = spawn(process.execPath, args, { cwd: f.workspace, env, stdio: "pipe" });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	const closed = new Promise<number | null>(resolve => child.once("close", resolve));
	child.stdin.on("error", () => {});
	if (!shellCommand) child.stdin.write(JSON.stringify({ id: "ready", type: "get_state" }) + "\n");
	return { child, closed, output: () => stdout + stderr, ready: () => stdout.split("\n").some(line => { try { const item = JSON.parse(line); return item.id === "ready" && item.success; } catch { return false; } }) };
}
async function until(check: () => boolean, output: () => string) {
	const deadline = Date.now() + 20_000;
	while (!check() && Date.now() < deadline) await pause(50);
	expect(check(), output()).toBe(true);
}
async function stop(running: { child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }) {
	running.child.kill("SIGTERM");
	const timer = setTimeout(() => running.child.kill("SIGKILL"), 2_000);
	await running.closed;
	clearTimeout(timer);
}

describe("real CLI MCP isolation", () => {
	it("positive control: the SDK native CLI starts a configured synthetic MCP server", async () => {
		const f = fixture();
		const running = await start(f, true);
		try {
			await until(running.ready, running.output);
			await until(() => existsSync(f.marker("native-global")), running.output);
		} finally { await stop(running); rmSync(f.root, { recursive: true, force: true }); }
	}, 30_000);
	it("keeps native MCP off across learning/full switches and runs only the enabled adapter", async () => {
		const f = fixture();
		try {
			for (const [experience, enabled] of [["learning", true], ["full", false], ["full", true], ["learning", true]] as const) {
				f.configure(experience, enabled);
				const running = await start(f);
				try {
					await until(running.ready, running.output);
					if (experience === "full" && enabled) {
						await until(() => existsSync(f.marker("adapter")), running.output);
					}
					else await pause(300);
					expect(existsSync(f.marker("native-global")), running.output()).toBe(false);
					expect(existsSync(f.marker("native-project")), running.output()).toBe(false);
					expect(existsSync(f.marker("adapter"))).toBe(experience === "full" && enabled);
					expect(readFileSync(join(f.configDir, "mcp.json"), "utf8")).toBe(f.legacy);
					expect(readFileSync(join(f.configDir, "mcp-adapter.json"), "utf8")).toBe(f.managed);
				} finally { await stop(running); rmSync(f.marker("adapter"), { force: true }); }
			}
		} finally { rmSync(f.root, { recursive: true, force: true }); }
	}, 90_000);
	it("rejects native shell MCP commands before they can bypass the session factory", async () => {
		const f = fixture();
		f.configure("learning", true);
		const running = await start(f, false, true);
		try {
			expect(await running.closed).toBe(1);
			expect(running.output()).toContain("native pi mcp commands are disabled");
			expect(existsSync(f.marker("native-global"))).toBe(false);
		} finally { await stop(running); rmSync(f.root, { recursive: true, force: true }); }
	}, 30_000);
});

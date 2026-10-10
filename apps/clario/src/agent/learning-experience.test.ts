import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// jiti's native module loading differs inside Vitest. Run the real extension
// loader in Node, just as the Web backend does, without making a model call.
const registrationScript = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ChannelRegistry } from "./apps/clario/src/channels/channel.ts";
import { closeL2Memory, getL2Memory } from "./apps/clario/src/memory/l2/l2-memory.ts";
import { closeL3Memory, getL3Memory } from "./apps/clario/src/memory/l3/l3-tools.ts";
import { resolveRuntimePaths } from "./apps/clario/src/runtime.ts";
import { WorkspaceRegistry } from "./apps/clario/src/workspace/workspace-registry.ts";
import { createInnoExtension } from "./apps/clario/src/agent/inno-extension.ts";
import { loadMcpAdapterExtension } from "./apps/clario/src/agent/mcp-extension.ts";
const root = process.env.INNO_HOME;
const paths = resolveRuntimePaths({ home: root, configDir: join(root, "config"), dataDir: join(root, "data"), skillsDir: join(root, "skills"), workspaceDir: join(root, "workspace") });
for (const dir of [paths.configDir, paths.sessionDir, paths.skillsDir, paths.workspaceDir]) mkdirSync(dir, { recursive: true });
const config = {
  experience: "learning", defaultProvider: "test", defaultModel: "test", providers: {},
  channels: { feishu: { enabled: true } }, subagents: { enabled: true }, mcp: { enabled: true },
  plugins: { todo: { enabled: true }, webAccess: { enabled: true }, computerUse: { enabled: true }, permissionSystem: { enabled: true } },
};
const before = JSON.stringify(config);
try {
  const workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, paths.dataDir);
  workspaceRegistry.ensureBootstrapped();
  const loader = new DefaultResourceLoader({
    cwd: paths.workspaceDir, agentDir: paths.configDir, settingsManager: SettingsManager.inMemory(),
    extensionFactories: [createInnoExtension({ current: config }, paths, new ChannelRegistry(join(root, "targets.json")), {
      workspaceRegistry, getCurrentSessionId: () => "learning-test.jsonl",
    })],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  const result = {
    errors: loaded.errors, tools,
    permissionResourcesGate: loaded.extensions.some(extension => extension.handlers.has("resources_discover")),
    toolCallGates: loaded.extensions.flatMap(extension => extension.handlers.get("tool_call") ?? []).length,
    mcpDisabled: await loadMcpAdapterExtension(config, paths) === null,
    configUnchanged: JSON.stringify(config) === before,
  };
  console.log("INNO_EXPERIENCE_RESULT=" + JSON.stringify(result));
} finally {
  await getL2Memory(paths.l2DataDir).backfill();
  await getL3Memory(paths.l3DataDir, paths.sessionDir).backfill();
  closeL2Memory(paths.l2DataDir);
  closeL3Memory(paths.l3DataDir);
}
`;

describe("learning experience extension registration", () => {
	it("keeps learning/practice/permission tools while excluding explicitly enabled complex extensions", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-learning-extension-"));
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/^(INNO_|PI_)/.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
		}
		Object.assign(env, { INNO_HOME: root, INNO_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
		try {
			const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", registrationScript], {
				cwd: resolve(import.meta.dirname, "../../../.."), env, encoding: "utf8", timeout: 25_000,
			});
			expect(result.status, result.stderr || result.error?.message).toBe(0);
			const output = result.stdout.split("\n").find(line => line.startsWith("INNO_EXPERIENCE_RESULT="));
			expect(output, result.stdout).toBeDefined();
			const report = JSON.parse(output!.slice("INNO_EXPERIENCE_RESULT=".length));
			expect(report.errors).toEqual([]);
			for (const name of ["get_learner_context", "record_learning_evidence", "assess_learning_prerequisites", "l2_archive", "l2_query", "l2_lint", "l3_recall", "ask_user_question", "create_practice_lab"]) expect(report.tools).toContain(name);
			for (const name of ["send_file_to_channel", "subagent", "todo", "fetch_content", "get_search_content", "mcp", "find_roots", "observe_ui", "act_ui"]) expect(report.tools).not.toContain(name);
			expect(report.permissionResourcesGate).toBe(true);
			expect(report.toolCallGates).toBeGreaterThanOrEqual(2);
			expect(report.mcpDisabled).toBe(true);
			expect(report.configUnchanged).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 30_000);
});

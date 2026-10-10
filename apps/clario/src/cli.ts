#!/usr/bin/env node

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { main, type ExtensionFactory, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { getExperience, loadConfig } from "./config.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { createInnoExtension } from "./agent/inno-extension.js";
import { createMcpStatusExtension, loadMcpAdapterExtension } from "./agent/mcp-extension.js";
import { ensureDir } from "./storage/file-store.js";
import { seedManagedMcpConfig } from "./mcp/mcp-config-store.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { installProcessFallbacks } from "./utils/process-fallback.js";
import { logger } from "./logger.js";

// Set process title
process.title = "clario";

// Last-resort handlers: log fatal-level and exit cleanly on stray
// exceptions/rejections instead of dying silently mid-session.
installProcessFallbacks();

// Disable undici timeouts for long streaming responses
// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 0 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
// Pi's shell-level `mcp` commands bypass extension factories altogether. Clario
// owns MCP through its adapter, so do not dispatch those native-only commands.
if (parsed.rest[0] === "mcp") {
	console.error("Clario uses pi-mcp-adapter. Manage MCP with /mcp in a full-mode session or the Web settings; native pi mcp commands are disabled.");
	process.exit(1);
}
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);

// Load config
const config = loadConfig(paths.configPath);
applyProviderProxyBypass(config);

// First-run MCP template: seeds <configDir>/mcp-adapter.json with a disabled
// reference server when the file doesn't exist yet. No-op afterwards.
if (getExperience(config) === "full") seedManagedMcpConfig(paths);

// Ensure data directories exist
ensureDir(paths.learnerDataDir);
ensureDir(paths.sessionDir);
ensureDir(paths.skillsDir);
ensureDir(paths.workspaceDir);

// Create the extension factory
const innoExtension = createInnoExtension({ current: config }, paths);

// Build extension factories list (conditionally include sandbox)
// Pi 0.99 main() prepends built-in factories; DefaultResourceLoader keys built-ins
// by name, so this public InlineExtension replaces its native MCP factory. Keep
// Clario adapter-only even with stale mcp.json, failed migration, an explicit
// `-e builtin:mcp`, or project settings that enable `+builtin:mcp`. This avoids
// editing user settings and leaves all other extension discovery unchanged.
const nativeMcpDisabled: InlineExtension = { name: "mcp", builtin: true, factory: () => {} };
const extensionFactories: InlineExtension[] = [nativeMcpDisabled, innoExtension];

// MCP: status bridge is always on (no-op without the adapter); the adapter
// itself only when `mcp.enabled` is set in config. In the CLI the adapter's
// full TUI surface (`/mcp` panel, OAuth dialogs) is available.
extensionFactories.push(createMcpStatusExtension());
const mcpAdapter = await loadMcpAdapterExtension(config, paths);
if (mcpAdapter) extensionFactories.push(mcpAdapter);

if (parsed.options.sandbox) {
	try {
		const { createJiti } = await import("jiti/static");
		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			alias: {
				"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
				"@mariozechner/pi-tui": "@earendil-works/pi-tui",
			},
		});
		const mod = await jiti.import("pi-sandbox", { default: true });
		const sandboxExtension = mod as ExtensionFactory;
		if (typeof sandboxExtension === "function") {
			extensionFactories.push(sandboxExtension);
			logger.info("[inno] Sandbox extension loaded");
		}
	} catch (err) {
		// pi-sandbox ships TS source only and is loaded via jiti — a version
		// bump can break loading; it is pinned in package.json for that reason.
		logger.warn({ err }, "[inno] Failed to load pi-sandbox (TS-source package loaded via jiti; check that the pinned version in package.json was not changed)");
	}
}

const hasCliModel = parsed.rest.some((arg) => arg === "--model" || arg.startsWith("--model="));
const hasCliProvider = parsed.rest.some((arg) => arg === "--provider" || arg.startsWith("--provider="));
const modelArgs = hasCliModel
	? parsed.rest
	: hasCliProvider
		? [...parsed.rest, "--model", config.defaultModel]
		: [...parsed.rest, "--model", `${config.defaultProvider}/${config.defaultModel}`];

// Run PI's main with our extension injected
main([...modelArgs, "--no-skills", "--skill", paths.skillsDir], {
	extensionFactories,
});

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InnoConfig } from "../config.js";
import { resolveRuntimePaths } from "../runtime.js";
import { branchSessionBeforeUserMessage, initSession, runPrompt } from "./pi-runner.js";

let session: AgentSession | undefined;
let temporaryRoot: string | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
	vi.unstubAllEnvs();
	if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	temporaryRoot = undefined;
});

async function createHarness() {
	temporaryRoot = mkdtempSync(join(tmpdir(), "clario-provider-context-"));
	const paths = resolveRuntimePaths({
		home: temporaryRoot,
		configDir: join(temporaryRoot, "config"),
		dataDir: join(temporaryRoot, "data"),
		skillsDir: join(temporaryRoot, "skills"),
		workspaceDir: join(temporaryRoot, "workspace"),
	});
	mkdirSync(paths.configDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", paths.configDir);
	vi.stubEnv("PI_SKIP_UPDATE_CHECK", "1");
	writeFileSync(join(paths.configDir, "settings.json"), JSON.stringify({
		telemetry: { enabled: false },
		defaultProjectTrust: "never",
		compaction: { enabled: false },
		// Context regression: skip the optional native image-resizing backend.
		images: { autoResize: false },
		retry: { enabled: false },
	}));
	const provider = fauxProvider({
		provider: `faux-clario-context-${randomUUID()}`,
		tokenSize: { min: 1000, max: 1000 },
	});
	const config: InnoConfig = {
		experience: "learning",
		defaultProvider: provider.models[0].provider,
		defaultModel: provider.models[0].id,
		providers: {},
		memory: { l1Enabled: false, l2Enabled: false, l3Enabled: false },
		mcp: { enabled: false },
		plugins: { permissionSystem: { enabled: false } },
	};
	// Use the production initialization and prompt paths; only the provider is
	// scripted. No credentials, network requests, or UI-history mocks are used.
	session = await initSession(config, paths);
	session.modelRuntime.registerNativeProvider(provider.provider);
	await session.modelRuntime.setRuntimeApiKey(provider.models[0].provider, "faux-test-key");
	await session.setModel(provider.models[0]);
	return { session, provider };
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

function userTexts(context: TranscriptContext): string[] {
	return context.messages.filter((message) => message.role === "user").map(textOf);
}

function imageCount(context: TranscriptContext): number {
	return context.messages.reduce((count, message) => {
		const content = (message as { content?: unknown }).content;
		return count + (Array.isArray(content) ? content.filter((item) => item.type === "image").length : 0);
	}, 0);
}

function userEntryId(target: AgentSession, text: string): string {
	const entry = target.sessionManager.getBranch().find((entry) =>
		entry.type === "message" && entry.message.role === "user" && textOf(entry.message) === text);
	expect(entry).toBeDefined();
	return entry!.id;
}

describe("production prompt context with Pi 0.99 sessions", () => {
	it.each([false, true])("editing a user turn excludes abandoned messages from the next provider request (has earlier turn: %s)", async (hasEarlierTurn) => {
		const { session: active, provider } = await createHarness();
		const requests: TranscriptContext[] = [];
		provider.setResponses(Array.from({ length: hasEarlierTurn ? 4 : 3 }, (_, index) => (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage(`answer-${index}`);
		}));
		if (hasEarlierTurn) await runPrompt("keep this earlier question");
		await runPrompt("replace this question");
		const replacedEntryId = userEntryId(active, "replace this question");
		await runPrompt("abandoned follow-up");
		const beforeEdit = active.sessionManager.getEntries().length;

		await branchSessionBeforeUserMessage(active.sessionFile!, replacedEntryId);
		expect(active.messages.filter((message) => message.role === "user").map(textOf)).toEqual(
			hasEarlierTurn ? ["keep this earlier question"] : [],
		);
		await runPrompt("replacement question");

		const finalRequest = requests.at(-1)!;
		expect(userTexts(finalRequest)).toEqual(hasEarlierTurn
			? ["keep this earlier question", "replacement question"]
			: ["replacement question"]);
		const assistantTexts = finalRequest.messages.filter((message) => message.role === "assistant").map(textOf);
		expect(assistantTexts).toEqual(hasEarlierTurn ? ["answer-0"] : []);
		// The abandoned branch remains auditable even though it is absent from
		// the actual provider request and no longer feeds model responses.
		expect(active.sessionManager.getEntry(replacedEntryId)).toBeDefined();
		expect(active.sessionManager.getEntries().length).toBeGreaterThan(beforeEdit);
		expect(provider.getPendingResponseCount()).toBe(0);
	}, 30_000);

	it("rolls back a rejected image turn before the OCR retry and later provider requests", async () => {
		const { provider } = await createHarness();
		const requests: TranscriptContext[] = [];
		provider.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("earlier answer");
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: "This model does not support image input" });
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("OCR fallback answer");
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("follow-up answer");
			},
		]);
		await runPrompt("earlier question");
		expect(await runPrompt("failed native image question", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC" }], "read /workspace/diagram.png using OCR")).toBe("OCR fallback answer");
		await runPrompt("continue after fallback");

		expect(requests).toHaveLength(4);
		expect(imageCount(requests[1])).toBe(1);
		expect(userTexts(requests[2])).toEqual(["earlier question", "read /workspace/diagram.png using OCR"]);
		expect(userTexts(requests[3])).toEqual(["earlier question", "read /workspace/diagram.png using OCR", "continue after fallback"]);
		for (const request of requests.slice(2)) {
			expect(imageCount(request)).toBe(0);
			expect(request.messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
		}
		expect(provider.getPendingResponseCount()).toBe(0);
	}, 30_000);
});

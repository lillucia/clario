import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { root, prepareEnvironment, isolatedEnv, serverArgs } from "./common.mjs";

// This checks the built application with synthetic data. It deliberately never
// submits a chat prompt: the local model endpoint is a tripwire, not a model.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
  console.error("Usage: node scripts/baseline/verify-web.mjs --output <report.json>");
  process.exitCode = 1;
} else {
  await verify(resolve(args[1]));
}

async function verify(outputPath) {
  const ids = ["built-artifacts", "local-fixture", "http-health", "built-web-assets", "api-bootstrap",
    "session-workspace", "pty-create", "pty-command", "run-record", "content-hub-local", "no-model-calls",
    "terminal-cleanup", "server-cleanup", "fixture-cleanup", "temporary-files-cleanup"];
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: "running",
    environment: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
    scope: "Built HTTP server, web assets, session/workspace, real PTY and persisted run record; no real model or teaching-quality evaluation.",
    checks: ids.map((id) => ({ id, status: "not_run" })),
  };
  let temporaryRoot, fixture, child, childClosed, childError, terminalId, socket, baseUrl;
  let serverLog = "";
  const fixtureRequests = [], modelRequests = [];
  const terminalEvents = [], socketErrors = [];
  let fatalError;
  const check = async (id, fn) => {
    const item = report.checks.find((entry) => entry.id === id);
    const started = Date.now();
    try {
      const details = await fn();
      Object.assign(item, { status: "passed", durationMs: Date.now() - started, ...(details === undefined ? {} : { details }) });
      console.log(`[baseline:web] ${id}: passed`);
      return details;
    } catch (error) {
      Object.assign(item, { status: error.code === "NOT_SUPPORTED" ? "not_supported" : "failed", durationMs: Date.now() - started, error: error.message });
      console.error(`[baseline:web] ${id}: ${item.status}: ${error.message}`);
      throw error;
    }
  };
  const cleanupCheck = async (id, fn) => {
    try { await check(id, fn); } catch (error) { fatalError ??= error; }
  };
  const ensureChildRunning = () => {
    if (childError) throw childError;
    if (childClosed) throw new Error(`Server exited before verification completed (${JSON.stringify(childClosed)}).`);
  };
  const request = async (path, { method = "GET", body, timeoutMs = 60_000 } = {}) => {
    ensureChildRunning();
    return fetch(`${baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  };
  const jsonRequest = async (path, expectedStatus, options) => {
    const response = await request(path, options);
    const text = await response.text();
    assert.equal(response.status, expectedStatus, `${path}: expected HTTP ${expectedStatus}, received ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  try {
    await check("built-artifacts", async () => {
      assert.ok(existsSync(join(root, "apps/clario/dist/server.js")), "Backend build missing; run npm run build first.");
      assert.ok(existsSync(join(root, "apps/clario/web/dist/index.html")), "Web build missing; run npm run build first.");
      if (process.platform === "win32" || !existsSync("/bin/bash")) {
        throw Object.assign(new Error("This PTY verifier requires a POSIX /bin/bash; Windows is not supported by this harness."), { code: "NOT_SUPPORTED" });
      }
      assert.equal(typeof WebSocket, "function", "This Node runtime must provide WebSocket.");
    });
    temporaryRoot = mkdtempSync(join(tmpdir(), "inno-baseline-web-"));
    const environment = prepareEnvironment(join(temporaryRoot, "environment"));
    const fixtureUrl = await check("local-fixture", async () => {
      fixture = createServer((req, res) => {
        fixtureRequests.push({ method: req.method, path: req.url });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && req.url === "/hub/index.json") {
          res.end(JSON.stringify({ skills: [], presets: [] }));
        } else {
          modelRequests.push({ method: req.method, path: req.url });
          res.writeHead(500);
          res.end(JSON.stringify({ error: "No model calls are permitted in the HTTP/PTY baseline." }));
        }
      });
      await listen(fixture);
      return `http://127.0.0.1:${fixture.address().port}`;
    });
    const configPath = join(environment, "config", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.providers["baseline-dummy"].baseUrl = `${fixtureUrl}/model/v1`;
    config.contentHub = { type: "bundle", baseUrl: `${fixtureUrl}/hub`, token: "" };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const shellPath = join(temporaryRoot, "baseline-shell.sh");
    writeFileSync(shellPath, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    const inputrcPath = join(temporaryRoot, "inputrc");
    // --norc does not suppress ~/.inputrc. Use our own readline configuration;
    // the no-op delimiters also support macOS's older system Bash/readline.
    writeFileSync(inputrcPath, '"\\e[200~": ""\n"\\e[201~": ""\n');
    const env = isolatedEnv(environment);
    for (const name of Object.keys(env)) {
      if (/^(?:https?|all|no)_proxy$/i.test(name) || /^(?:BASH_ENV|ENV|ZDOTDIR|INIT_CWD)$/.test(name) || name.startsWith("BASH_FUNC_")) delete env[name];
    }
    Object.assign(env, { SHELL: shellPath, INPUTRC: inputrcPath, HISTFILE: join(temporaryRoot, "bash-history"), HISTSIZE: "0",
      INNO_DATA_DIR: join(environment, "data"),
      PI_CODING_AGENT_SESSION_DIR: join(environment, "data", "sessions"),
      XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"), XDG_CACHE_HOME: join(temporaryRoot, "xdg-cache"),
      XDG_DATA_HOME: join(temporaryRoot, "xdg-data"), NO_PROXY: "127.0.0.1,localhost" });
    const port = await unusedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, serverArgs(environment, port), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (error) => { childError = error; });
    child.on("close", (code, signal) => { childClosed = { code, signal }; });
    const capture = (chunk) => { serverLog = (serverLog + chunk.toString()).slice(-64_000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    await check("http-health", async () => {
      await waitFor(async () => {
        ensureChildRunning();
        try {
          const response = await request("/health", { timeoutMs: 1000 });
          return response.ok && (await response.json()).status === "ok";
        } catch (error) {
          ensureChildRunning();
          return false;
        }
      }, 60_000, "Server /health did not become ready.", 150);
      return { status: "ok" };
    });
    await check("built-web-assets", async () => {
      const response = await request("/");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const html = await response.text();
      assert.match(html, /<div[^>]+id="root"/);
      const asset = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"?#]+\.js)"/i)?.[1];
      assert.ok(asset, "Built entry script absent from served HTML.");
      const script = await request(asset);
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type") ?? "", /javascript/);
      assert.ok((await script.arrayBuffer()).byteLength > 0, "Built entry script was empty.");
      return { asset };
    });
    await check("api-bootstrap", async () => {
      const settings = await jsonRequest("/api/settings", 200);
      const provider = settings.providers?.["baseline-dummy"];
      assert.ok(provider, "Configured synthetic provider missing after bootstrap.");
      assert.notEqual(provider.apiKey, "baseline-placeholder", "API leaked the synthetic provider key.");
      assert.match(provider.apiKey, /^\*\*\*\*/);
      return { provider: "baseline-dummy", keyRedacted: true };
    });
    const session = await check("session-workspace", async () => {
      const result = await jsonRequest("/api/sessions", 201, { method: "POST", body: { newWorkspace: { name: "HTTP PTY baseline", isTemp: true } } });
      assert.equal(typeof result.id, "string");
      assert.ok(result.id.length > 0 && result.workspaceId && result.active === true);
      return result;
    });
    const terminal = await check("pty-create", async () => {
      const result = await jsonRequest("/api/terminal/sessions", 201, { method: "POST", body: { sessionId: session.id, workspaceId: session.workspaceId, cols: 100, rows: 24 } });
      terminalId = result.id;
      assert.equal(typeof terminalId, "string");
      assert.equal(result.status, "ready");
      assert.equal(result.sessionId, session.id);
      assert.equal(result.workspaceId, session.workspaceId);
      assert.ok(realpathSync(result.cwd).startsWith(realpathSync(environment) + "/"), "PTY cwd escaped the synthetic environment.");
      socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/terminal/sessions/${encodeURIComponent(terminalId)}/ws`);
      socket.addEventListener("message", ({ data }) => {
        try { terminalEvents.push(JSON.parse(String(data))); } catch { socketErrors.push("Terminal sent invalid JSON."); }
      });
      socket.addEventListener("error", () => { socketErrors.push("Terminal WebSocket error."); });
      await waitFor(() => {
        ensureChildRunning();
        assert.equal(socketErrors.length, 0, socketErrors.join(" "));
        const ready = terminalEvents.find((event) => event.type === "ready");
        if (!ready) return false;
        assert.equal(ready.sessionId, session.id);
        assert.equal(ready.cwd, result.cwd);
        return true;
      }, 15_000, "Terminal WebSocket did not report ready.");
      return result;
    });
    const marker = `INNO_BASELINE_OK_${process.pid}`;
    const run = await check("pty-command", async () => {
      socket.send(JSON.stringify({ type: "resize", cols: 90, rows: 28 }));
      // Split the token in the command, so an echoed command cannot alone satisfy
      // the assertion that the actual shell printed the complete marker.
      socket.send(JSON.stringify({ type: "run", command: `printf '%s%s\\n' 'INNO_BASELINE_OK_' '${process.pid}'` }));
      let completed;
      await waitFor(() => {
        ensureChildRunning();
        const error = terminalEvents.find((event) => event.type === "error");
        assert.ok(!error, error?.message);
        assert.equal(socketErrors.length, 0, socketErrors.join(" "));
        const started = terminalEvents.find((event) => event.type === "run_started");
        completed = terminalEvents.find((event) => event.type === "exit" && event.runId === started?.runId);
        return Boolean(started && completed);
      }, 20_000, "PTY command did not complete with a run id.");
      assert.equal(completed.code, 0, "PTY command returned a non-zero exit status.");
      const output = terminalEvents.filter((event) => event.type === "output").map((event) => event.data).join("");
      assert.ok(output.includes(marker), "PTY stream did not contain the executed command's output marker.");
      return { runId: completed.runId, exitCode: completed.code, marker };
    });
    await check("run-record", async () => {
      const record = await jsonRequest(`/api/runs/${encodeURIComponent(run.runId)}`, 200);
      assert.equal(record.id, run.runId);
      assert.equal(record.sessionId, session.id);
      assert.equal(record.workspaceId, session.workspaceId);
      assert.equal(record.cwd, terminal.cwd);
      assert.equal(record.exitCode, 0);
      assert.ok(record.endedAt, "Persisted run lacks completion timestamp.");
      assert.ok(record.outputTail.includes(marker), "Persisted run output lacks marker.");
      assert.ok(existsSync(record.logPath), "Persisted run log is missing.");
      assert.ok(realpathSync(record.logPath).startsWith(realpathSync(environment) + "/"), "Run log escaped the synthetic environment.");
      const listed = await jsonRequest(`/api/runs?sessionId=${encodeURIComponent(session.id)}&limit=5`, 200);
      assert.ok(listed.some((item) => item.id === run.runId && item.exitCode === 0));
      return { runId: run.runId, outputTail: record.outputTail };
    });
    await check("content-hub-local", async () => {
      await waitFor(() => fixtureRequests.some((item) => item.path === "/hub/index.json"), 5000, "Local content hub was not requested.");
      return { requests: fixtureRequests.filter((item) => item.path === "/hub/index.json").length };
    });
  } catch (error) {
    fatalError = error;
  } finally {
    await cleanupCheck("terminal-cleanup", async () => {
      if (!terminalId) return { created: false };
      const closed = await jsonRequest(`/api/terminal/sessions/${encodeURIComponent(terminalId)}/close`, 200, { method: "POST", timeoutMs: 5000 });
      assert.equal(closed.closed, true);
      return { closed: true };
    });
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try { socket.close(); } catch { /* server termination also closes the connection */ }
    }
    await cleanupCheck("server-cleanup", async () => {
      if (!child) return { started: false };
      if (!childClosed) {
        child.kill("SIGTERM");
        try { await waitFor(() => childClosed, 5000, "Server did not exit after SIGTERM."); }
        catch { child.kill("SIGKILL"); await waitFor(() => childClosed, 5000, "Server could not be stopped."); }
      }
      return childClosed;
    });
    await cleanupCheck("no-model-calls", async () => {
      assert.equal(modelRequests.length, 0, `Unexpected model/fixture request: ${JSON.stringify(modelRequests)}`);
      return { modelRequests: modelRequests.length, chatPromptsSubmitted: 0 };
    });
    await cleanupCheck("fixture-cleanup", async () => {
      if (!fixture) return { started: false };
      fixture.closeAllConnections();
      await new Promise((resolveClosed, reject) => fixture.close((error) => error ? reject(error) : resolveClosed()));
      return { closed: true };
    });
    await cleanupCheck("temporary-files-cleanup", async () => {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { removed: temporaryRoot ? !existsSync(temporaryRoot) : true };
    });
    for (const item of report.checks) {
      if (item.status === "not_run") Object.assign(item, { status: "failed", error: `Not executed because a prerequisite failed: ${fatalError?.message ?? "unknown failure"}` });
    }
    report.status = report.checks.every((item) => item.status === "passed") ? "passed" : "failed";
    report.finishedAt = new Date().toISOString();
    if (fatalError) report.error = fatalError.message;
    report.fixtureRequests = fixtureRequests;
    if (report.status !== "passed") report.serverLogTail = serverLog;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`[baseline:web] ${report.status}; report: ${outputPath}`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
}

async function listen(server) {
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListening(); });
  });
}

async function unusedPort() {
  const server = createServer();
  await listen(server);
  const { port } = server.address();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return port;
}

async function waitFor(predicate, timeoutMs, message, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(message);
}

/**
 * Guard rails: the failure modes that already happened once, plus the reload and
 * legacy-patch paths that are easy to break without noticing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPi, host, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree } from "./harness.mjs";

const install = await loadExtension();
const proto = host.ToolExecutionComponent.prototype;
const LEGACY_V1 = Symbol.for("legacy-test:compact-rows:v1");
const LEGACY_V2 = Symbol.for("legacy-test:compact-rows:v2");

// Load the old renderer's bookkeeping the way a stale /reload would leave it.
proto[LEGACY_V1] = { enabled: true };
proto[LEGACY_V2] = { enabled: true };

const { api, emit } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });
const boxFor = (component) => {
	const box = tree();
	box.add(component);
	return box;
};

// ---------------------------------------------------------------------------
test("legacy patch state is switched off so only one renderer is active", async () => {
	assert.equal(proto[LEGACY_V1].enabled, false, "v1 legacy renderer disabled");
	assert.equal(proto[LEGACY_V2].enabled, false, "v2 legacy renderer disabled");
});

test("a second install (reload) reuses the patch instead of wrapping it again", async () => {
	const again = createPi();
	install(again.api);

	await again.emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await again.emit("before_agent_start", { messageType: "user" }, { ui });
	const call = tool("bash", "reload-1", { command: "git status" });
	call.markExecutionStarted();
	const box = boxFor(call);
	assert.equal(box.frame().length, 3, "row is drawn once, not once per install");
	assert.match(box.rows()[0], / ● Running git · 0s/);
	assert.match(box.rows()[1], /└ \$ git status/);
});

test("both installs share one state, so counts are not doubled", async () => {
	const second = createPi();
	install(second.api);
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	const message = {
		message: { role: "assistant", content: [{ type: "toolCall", id: "shared-1", name: "bash", arguments: {} }] },
	};
	await emit("message_end", message, { ui });
	await second.emit("message_end", message, { ui });
	await emit("agent_before_settle", {}, { ui });
	assert.equal(boxFor(tool("bash", "shared-1", { command: "ls" })).rows()[0].trim(), "○ ran 1 shell command");
});

test("a component rendered without any live run falls back instead of throwing", async () => {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	// This exact shape killed pi once: runOf() returns null while tracing is off.
	const orphan = tool("bash", "orphan-1", { command: "echo hi" });
	const box = boxFor(orphan);
	assert.equal(box.rows()[0], "● bash(echo hi)");
});

test("a component without a toolCallId does not throw", async () => {
	await emit("before_agent_start", { messageType: "user" }, { ui });
	const anonymous = tool("bash", undefined, { command: "ls" });
	anonymous.markExecutionStarted();
	const box = boxFor(anonymous);
	const rows = box.rows();
	assert.ok(rows.length >= 1);
	assert.match(rows[0], /Running ls/);
});

test("a session without a theme still renders plain rows", async () => {
	// st.ui is taken from session_start; a ctx without ui must not break styling.
	await emit("session_start", {}, { sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui: undefined });
	const call = tool("bash", "no-ui", { command: "ls" });
	call.markExecutionStarted();
	assert.match(boxFor(call).rows()[0], /Running ls/);
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
});

test("a throwing lifecycle context is swallowed and leaves rows working", async () => {
	const hostile = {
		get ui() {
			throw new Error("ui exploded");
		},
	};
	// The handler wrapper must absorb it; nothing may escape into pi's render loop.
	await emit("session_start", {}, hostile);
	await emit("before_agent_start", { messageType: "user" }, hostile);
	await emit("message_end", { message: { role: "assistant", content: [] } }, hostile);
	await emit("agent_before_settle", {}, hostile);
	const call = tool("bash", "hostile-1", { command: "ls" });
	call.markExecutionStarted();
	assert.ok(boxFor(call).rows().length >= 1);
});

test("tracing writes only when the debug variable is set", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-tools-trace-"));
	const log = join(dir, "trace.log");
	try {
		process.env.PI_CC_TOOLS_DEBUG = log;
		await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
		await emit("before_agent_start", { messageType: "user" }, { ui });

		const traced = tool("bash", "trace-1", { command: "ls" });
		traced.markExecutionStarted();
		boxFor(traced).text();
		const written = readFileSync(log, "utf8");
		assert.match(written, /before_agent_start/);
		assert.match(written, /Running|live/);

		delete process.env.PI_CC_TOOLS_DEBUG;
		const before = readFileSync(log, "utf8").length;
		const silent = tool("bash", "trace-2", { command: "ls" });
		silent.markExecutionStarted();
		traced.updateResult(toolResult());
		const box = tree();
		box.add(silent);
		box.text();
		assert.equal(readFileSync(log, "utf8").length, before, "no new lines once tracing is off");
	} finally {
		delete process.env.PI_CC_TOOLS_DEBUG;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty container renders nothing", async () => {
	assert.deepEqual(tree().frame(), []);
});

test("a run with no tool calls at all still settles cleanly", async () => {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	const result = await emit("agent_before_settle", {}, { ui });
	assert.ok(result[0]?.entries, "summary entry is written even when nothing was counted");
	await emit("agent_settled", {}, { ui });
});

await runTests("robustness");

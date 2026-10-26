/**
 * Reload behaviour. pi re-evaluates extensions with `moduleCache: false`, but
 * `ToolExecutionComponent.prototype` survives, so the patch state and the wrapped
 * methods outlive the module. These tests pin down what happens when a new copy
 * of the script loads on top of a running one.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTENSION_PATH,
	createPi,
	host,
	jiti,
	loadExtension,
	makeTool,
	makeUi,
	runTests,
	test,
	toolResult,
	tree,
} from "./harness.mjs";

const install = await loadExtension();
const proto = host.ToolExecutionComponent.prototype;
const PATCH = Symbol.for("cc-tools:patch:v1");
const FILTER = Symbol.for("cc-tools:thinking-filter:v1");
const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });
const { api, emit } = createPi();

/** Evaluate the extension again, the way `/reload` does (new module, same prototype). */
async function evaluateAgain(source) {
	const path = join(tmpdir(), `cc-tools-reload-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
	writeFileSync(path, source);
	const factory = (await jiti.import(path)).default;
	const fresh = createPi();
	factory(fresh.api);
	return fresh;
}

// A running process left behind by an older copy of this script: a wrapper with
// its own state, no recorded host methods, and an older symbol name.
const staleState = { patched: true, enabled: true };
const hostRender = proto.render;
proto[Symbol.for("legacy-test:old-copy")] = staleState;
proto.render = function (width) {
	return staleState.enabled ? ["stale-row"] : hostRender.call(this, width);
};

install(api);

// ---------------------------------------------------------------------------
test("an older copy's wrapper is switched off instead of nested", async () => {
	assert.equal(staleState.enabled, false, "the stale wrapper now delegates to the host");
	assert.ok(proto[PATCH], "the new patch state is installed under the current symbol");

	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	const box = tree();
	box.add(tool("bash", "stale-1", { command: "ls" }));
	assert.ok(!box.text().includes("stale-row"), "the new code draws the row");
	assert.equal(box.rows()[0], "● bash(ls)", "no run yet: the fallback row of the new renderer");
});

test("installing twice from one module reuses the state and does not stack", async () => {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	const call = tool("bash", "reload-same", { command: "git status" });
	call.markExecutionStarted();
	const box = tree();
	box.add(call);
	assert.equal(box.frame().length, 3, "padding + activity + command");

	const state = proto[PATCH];
	const wrapper = proto.render;
	install(api);
	assert.equal(proto[PATCH], state, "same state object");
	assert.equal(proto.render, wrapper, "same wrapper");
	assert.equal(box.frame().length, 3, "rows are drawn once, not once per install");
});

test("a reload swaps the closures but keeps counters", async () => {
	const state = proto[PATCH];
	const runsBefore = state.runs.size;
	const wrapperBefore = proto.render;

	const reloaded = await evaluateAgain(readFileSync(EXTENSION_PATH, "utf8"));

	assert.equal(proto[PATCH], state, "the state object survives the reload");
	assert.notEqual(proto.render, wrapperBefore, "the stale closure is replaced");
	assert.equal(proto[PATCH].runs.size, runsBefore, "counts survive the reload");
	assert.ok(reloaded.handlers.size > 0, "the new module registered its handlers");
});

test("the reloaded module's code answers immediately", async () => {
	// A copy whose summary wording differs proves which closures are running.
	const patched = readFileSync(EXTENSION_PATH, "utf8").replace("`ran ", "`RELOADMARK ");
	await evaluateAgain(patched);

	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "reload-code", name: "bash", arguments: {} }] } },
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	box.add(tool("bash", "reload-code", { command: "ls" })).updateResult(toolResult());
	assert.match(box.rows()[0], /RELOADMARK 1 shell command/, "the new wording renders right away");
});

test("a reload rebuilds the thinking filter as well", async () => {
	const filterBefore = host.AssistantMessageComponent.prototype[FILTER];
	assert.ok(filterBefore?.originalRender, "the filter records what it wraps");
	assert.ok(typeof filterBefore.originalRender === "function");

	await evaluateAgain(readFileSync(EXTENSION_PATH, "utf8"));

	const filterAfter = host.AssistantMessageComponent.prototype[FILTER];
	assert.notEqual(filterAfter, filterBefore, "the filter closure is replaced");
	assert.equal(typeof filterAfter.originalRender, "function", "and records the method it wraps");
	// Each reload wraps the host method again instead of stacking filters.
	assert.equal(filterAfter.originalRender, filterBefore.originalRender, "no filter is nested in another");
});

test("a reload rebuilds parent tracking without stacking", async () => {
	const TRACKING = Symbol.for("cc-tools:parent-tracking:v1");
	const containerProto = Object.getPrototypeOf(host.ToolExecutionComponent.prototype);
	const trackingBefore = containerProto[TRACKING];
	assert.ok(trackingBefore?.originalAddChild, "the tracker records the host addChild");

	await evaluateAgain(readFileSync(EXTENSION_PATH, "utf8"));

	const trackingAfter = containerProto[TRACKING];
	assert.notEqual(trackingAfter, trackingBefore, "the tracker closure is replaced");
	assert.equal(trackingAfter.originalAddChild, trackingBefore.originalAddChild, "no addChild is nested in another");
});

await runTests("reload");

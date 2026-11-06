/**
 * Nested sessions in one process. `@tintinweb/pi-subagents` runs a subagent
 * through `createAgentSession`, so the same process hosts a second session with
 * its own extension runner: the factory runs again and the session emits its own
 * lifecycle events. The patch state lives on the prototype and is therefore
 * shared, so a nested session must never take it over — its `session_start`
 * would replace the run map of the conversation the user is reading.
 */
import assert from "node:assert/strict";
import { createPi, host, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree } from "./harness.mjs";

const install = await loadExtension();
const proto = host.ToolExecutionComponent.prototype;
const PATCH = Symbol.for("cc-tools:patch:v1");

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });
const parent = createPi();
install(parent.api);

const parentManager = { getBranch: () => [] };
const parentCtx = { ui, mode: "tui", sessionManager: parentManager };

/** A nested session: same process, its own runner, its own session manager. */
function nestedSession() {
	const child = createPi();
	install(child.api);
	const childManager = { getBranch: () => [] };
	// A nested session binds without a UI context: pi keeps its mode at `print`.
	return { child, childCtx: { ui: undefined, mode: "print", sessionManager: childManager } };
}

test("a nested session's factory does not reset the parent's live run", async () => {
	await parent.emit("session_start", {}, parentCtx);
	await parent.emit("before_agent_start", { messageType: "user" }, parentCtx);

	const box = tree();
	const call = box.add(tool("bash", "parent-live", { command: "ls" }));
	call.markExecutionStarted();
	await parent.emit("tool_execution_start", { toolCallId: "parent-live", toolName: "bash", args: {} }, parentCtx);
	assert.match(box.rows()[0], /Running|bash/, "the parent row is drawn");

	// The subagent spawn: pi evaluates every extension again for the child runner.
	const { child, childCtx } = nestedSession();
	assert.equal(proto[PATCH].live?.toolIds.includes("parent-live"), true, "the live run survives the factory");

	await child.emit("session_start", {}, childCtx);
	assert.ok(proto[PATCH].live, "a nested session_start does not drop the parent's run");
	assert.equal(proto[PATCH].sessionManager, parentManager, "the parent keeps owning the state");
});

test("a nested session's tool calls are not counted into the parent's run", async () => {
	const { child, childCtx } = nestedSession();
	const live = proto[PATCH].live;
	const before = live ? { tools: live.toolIds.length, counts: JSON.stringify(live.counts) } : undefined;

	await child.emit("session_start", {}, childCtx);
	await child.emit("before_agent_start", { messageType: "user" }, childCtx);
	await child.emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "child-1", name: "read", arguments: {} }] } },
		childCtx,
	);
	await child.emit("agent_before_settle", {}, childCtx);
	await child.emit("agent_settled", {}, childCtx);

	if (live && before) {
		assert.equal(proto[PATCH].live, live, "the parent run object is untouched");
		assert.equal(proto[PATCH].live.toolIds.length, before.tools, "no nested id lands in the parent's run");
		assert.equal(JSON.stringify(proto[PATCH].live.counts), before.counts, "the parent's counters stay put");
	}
	assert.equal(proto[PATCH].runs.has("child-1"), false, "the nested call never enters the run map");
	assert.equal(child.appended.length, 0, "the nested session writes no summary entry");
});

test("a nested session's shutdown does not clear the parent's rows", async () => {
	const { child, childCtx } = nestedSession();
	await child.emit("session_shutdown", { reason: "shutdown" }, childCtx);

	const box = tree();
	box.add(tool("bash", "parent-live", { command: "ls" })).markExecutionStarted();
	assert.ok(!box.rows()[0].startsWith("● bash(ls)"), "the parent row is still a live row, not a fallback");
	assert.ok(proto[PATCH].live, "the parent's run is still open");
});

test("the parent still settles and writes its summary", async () => {
	await parent.emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "parent-live", name: "bash", arguments: {} }] } },
		parentCtx,
	);
	const proposal = await parent.emitOne("agent_before_settle", {}, parentCtx);
	await parent.emit("agent_settled", {}, parentCtx);

	assert.equal(proposal?.entries?.[0]?.customType, "cc-tools-summary", "the parent settles with its summary");

	const box = tree();
	box.add(tool("bash", "parent-live", { command: "ls" })).updateResult(toolResult());
	assert.match(box.rows()[0], /ran 1 shell command/, "the parent keeps its summary band");
});

test("a session that shut down hands ownership to the next one", async () => {
	await parent.emit("session_shutdown", { reason: "new" }, parentCtx);

	const next = createPi();
	install(next.api);
	const nextManager = { getBranch: () => [] };
	const nextCtx = { ui, mode: "tui", sessionManager: nextManager };
	await next.emit("session_start", {}, nextCtx);
	assert.equal(proto[PATCH].sessionManager, nextManager, "the new session took over after the old one shut down");

	await next.emit("before_agent_start", { messageType: "user" }, nextCtx);
	const box = tree();
	box.add(tool("bash", "next-live", { command: "pwd" })).markExecutionStarted();
	assert.ok(!box.rows()[0].startsWith("● bash(pwd)"), "the new session draws live rows");
});

await runTests("nested-session");

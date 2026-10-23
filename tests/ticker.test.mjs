/**
 * The elapsed-seconds timer. pi repaints the transcript only on change, so the
 * extension has to ask for a repaint once a second while a call is in flight.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree } from "./harness.mjs";

const install = await loadExtension();
const { api, emit } = createPi();
install(api);

let ticks = 0;
const ui = makeUi({
	requestRender() {
		ticks += 1;
	},
});
const tool = makeTool(ui, { cwd: "/work/project" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startTurn() {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
}

function boxFor(component) {
	const box = tree();
	box.add(component);
	return box;
}

// ---------------------------------------------------------------------------
test("the timer asks for a repaint and the elapsed seconds advance", async () => {
	await startTurn();
	const box = boxFor(tool("bash", "tick-1", { command: "sleep 9" }));
	assert.match(box.rows()[0], /· 0s/);
	const before = ticks;
	await wait(1300);
	assert.ok(ticks > before, "a repaint was requested while the call was running");
	assert.match(box.rows()[0], /· [12]s/, "elapsed seconds moved forward");
});

test("a streamed partial result does not stop the timer", async () => {
	await startTurn();
	const call = tool("bash", "tick-2", { command: "echo start; sleep 9" });
	call.markExecutionStarted();
	// Partial output arrives immediately, the command keeps running for minutes.
	call.updateResult({ content: [{ type: "text", text: "start" }], isError: false }, true);
	const box = boxFor(call);
	box.text();
	const before = ticks;
	await wait(1300);
	assert.ok(ticks > before, "partial output must not be mistaken for completion");
	assert.match(box.rows()[0], /· [12]s/);
});

test("a component that never saw executionStarted still ticks", async () => {
	await startTurn();
	// This is what a component recreated by tree navigation looks like.
	const box = boxFor(tool("bash", "tick-3", { command: "sleep 9" }));
	box.text();
	const before = ticks;
	await wait(1300);
	assert.ok(ticks > before);
	assert.match(box.rows()[0], /· [12]s/);
});

test("the row disappears when the call finishes instead of freezing", async () => {
	await startTurn();
	const call = tool("bash", "tick-4", { command: "sleep 9" });
	call.markExecutionStarted();
	const box = boxFor(call);
	box.text();
	assert.match(box.rows()[0], /Running sleep/);
	// Regression: a finished call used to keep showing "· 0s" (or a stale
	// duration) for as long as the model kept thinking.
	call.updateResult(toolResult({ durationMs: 8200 }));
	assert.deepEqual(box.rows(), []);
	await wait(1100);
	assert.deepEqual(box.rows(), [], "no stale row comes back on a repaint");
});

test("a partial result carrying durationMs 0 does not reset the timer", async () => {
	await startTurn();
	const call = tool("bash", "tick-zero", { command: "sleep 9" });
	call.markExecutionStarted();
	const box = boxFor(call);
	assert.match(box.rows()[0], /· 0s/);
	await wait(1200);
	assert.match(box.rows()[0], /· 1s/);
	// Some tools report a partial result with a zero duration.
	call.updateResult({ content: [{ type: "text", text: "partial" }], isError: false, durationMs: 0 }, true);
	assert.match(box.rows()[0], /· 1s/, "a partial duration must not rewind the clock");
});

test("the timer stops when the run settles", async () => {
	await startTurn();
	const box = boxFor(tool("bash", "tick-5", { command: "sleep 9" }));
	box.text();
	await emit("agent_before_settle", {}, { ui });
	const before = ticks;
	await wait(1300);
	assert.equal(ticks, before, "no repaints are requested after settle");
});

test("the elapsed timer restarts for every tool call", async () => {
	await startTurn();
	const first = tool("bash", "tick-a", { command: "one" });
	first.markExecutionStarted();
	const firstBox = boxFor(first);
	assert.match(firstBox.rows()[0], /· 0s/);
	await wait(1200);
	assert.match(firstBox.rows()[0], /· 1s/);

	// The next call of the same run starts counting from zero again.
	const second = tool("bash", "tick-b", { command: "two" });
	second.markExecutionStarted();
	const box = tree();
	box.add(first);
	box.add(second);
	box.text(); // the frame in which a new call appears may still show the old one
	assert.match(box.rows()[0], /Running two · 0s/);
});

test("a ui without requestRender is tolerated", async () => {
	await startTurn();
	const bare = makeUi({ requestRender: undefined });
	const call = makeTool(bare, { cwd: "/work/project" })("bash", "tick-bare", { command: "sleep 9" });
	const box = boxFor(call);
	assert.match(box.rows()[0], / · 0s/);
	await wait(100);
	assert.match(box.rows()[0], /· 0s/, "rendering keeps working without a render callback");
});

await runTests("ticker");

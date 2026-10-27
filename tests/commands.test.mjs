/**
 * User-facing controls: the /cc-tools command and clicking the summary row.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree, HIDDEN_OUTPUT } from "./harness.mjs";

const install = await loadExtension();
const { api, commands, emit } = createPi();
install(api);

const notices = [];
let ticks = 0;
const ui = makeUi({
	notify(message, level) {
		notices.push({ message, level });
	},
	requestRender() {
		ticks += 1;
	},
});
const tool = makeTool(ui, { cwd: "/work/project" });
const command = (arg) => commands.get("cc-tools").handler(arg, { ui });
const lastNotice = () => notices.at(-1);

async function settledRun() {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "cmd-1", name: "bash", arguments: {} }] } },
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	const call = box.add(tool("bash", "cmd-1", { command: "git status" }));
	call.markExecutionStarted();
	call.updateResult(toolResult({ durationMs: 2000 }));
	return { box, call };
}

// ---------------------------------------------------------------------------
test("the command is registered with a description", async () => {
	const definition = commands.get("cc-tools");
	assert.ok(definition, "command exists");
	assert.ok(definition.description.length > 0);
});

test("off restores host rendering and on brings the compact rows back", async () => {
	const { box } = await settledRun();
	await command("off");
	assert.equal(lastNotice().message, "cc-tools: off");
	assert.equal(lastNotice().level, "info");
	assert.ok(box.text().includes(HIDDEN_OUTPUT), "host renderer shows the output again");

	await command("on");
	assert.equal(lastNotice().message, "cc-tools: on · live line");
	assert.ok(!box.text().includes(HIDDEN_OUTPUT));
});

test("toggle flips the state each time", async () => {
	await command("on");
	await command("toggle");
	assert.equal(lastNotice().message, "cc-tools: off");
	await command("toggle");
	assert.equal(lastNotice().message, "cc-tools: on · live line");
});

test("reveal and hide switch between compact rows and the call list", async () => {
	const { box } = await settledRun();
	await command("reveal");
	assert.equal(lastNotice().message, "cc-tools: on · all rows");
	assert.equal(box.rows()[0], "● bash(git status)", "revealed row names the call");

	await command("hide");
	assert.equal(lastNotice().message, "cc-tools: on · live line");
	assert.match(box.rows()[0], /ran 1 shell command/);
});

test("revealed rows never leak tool output and mark errors", async () => {
	const { call } = await settledRun();
	await command("reveal");
	const box = tree();
	const failed = box.add(tool("bash", "cmd-1", { command: "git status" }));
	failed.markExecutionStarted();
	failed.updateResult(toolResult({ isError: true }));
	assert.ok(!box.text().includes(HIDDEN_OUTPUT));
	assert.match(box.rows()[0], /● bash\(git status\) ✗$/);
	await command("hide");
	assert.ok(call);
});

test("an unknown option is rejected without changing state", async () => {
	await command("on");
	await command("onf");
	assert.equal(lastNotice().message, "Usage: /cc-tools [on|off|toggle|reveal|hide]");
	assert.equal(lastNotice().level, "error");
	assert.equal((await settledRun()).box.rows().length > 0, true, "renderer still active");
});

test("clicking the summary row reveals and hides the calls", async () => {
	const { box, call } = await settledRun();
	const click = { type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 };
	assert.deepEqual(call.handleMouse(click), { handled: true }, "click on the summary is consumed");
	assert.equal(box.rows()[0], "● bash(git status)", "first click reveals");

	call.handleMouse(click);
	assert.match(box.rows()[0], /ran 1 shell command/, "second click hides again");
});

test("clicking the summary asks for a repaint", async () => {
	const { call } = await settledRun();
	const before = ticks;
	call.handleMouse({ type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 });
	assert.ok(ticks > before, "reveal state is redrawn immediately");
	call.handleMouse({ type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 });
});

test("a click on an older call of the same run is passed to the host", async () => {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	await emit(
		"message_end",
		{
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "old-1", name: "bash", arguments: {} },
					{ type: "toolCall", id: "old-2", name: "bash", arguments: {} },
				],
			},
		},
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	const older = box.add(tool("bash", "old-1", { command: "one" }));
	const newer = box.add(tool("bash", "old-2", { command: "two" }));
	older.updateResult(toolResult());
	newer.updateResult(toolResult());
	// A shadow component renders the same run, so it reveals a global toggle.
	const probe = tree();
	probe.add(tool("bash", "old-2", { command: "two" })).updateResult(toolResult());
	const before = probe.rows();
	older.handleMouse({ type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 });
	assert.deepEqual(probe.rows(), before, "only the newest call owns the reveal toggle");
});

test("clicks while a run is still open are passed to the host", async () => {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	const box = tree();
	const live = box.add(tool("bash", "live-click", { command: "sleep 5" }));
	live.markExecutionStarted();
	const result = live.handleMouse({ type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 });
	assert.ok(!result?.handled);
});

test("right clicks and other events are passed to the host", async () => {
	const { call } = await settledRun();
	assert.ok(!call.handleMouse({ type: "click", button: "right", x: 1, y: 1, height: 5, width: 80 })?.handled);
	assert.ok(!call.handleMouse({ type: "move", x: 1, y: 1, height: 5, width: 80 })?.handled);
});

test("a click on an expanded tool is passed to the host", async () => {
	const { call } = await settledRun();
	call.setExpanded(true);
	const probe = tree();
	probe.add(tool("bash", "cmd-1", { command: "git status" })).updateResult(toolResult({ durationMs: 2000 }));
	const before = probe.rows();
	call.handleMouse({ type: "click", button: "left", x: 1, y: 1, height: 5, width: 80 });
	assert.deepEqual(probe.rows(), before, "the reveal toggle is not touched while expanded");
	call.setExpanded(false);
});

await runTests("commands");

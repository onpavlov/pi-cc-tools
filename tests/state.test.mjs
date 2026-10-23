/**
 * Lifecycle and persistence: which event opens, settles and reopens a run, what
 * gets written to the session, and what a replayed session renders.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree } from "./harness.mjs";

const install = await loadExtension();
const { api, emit, emitOne, appended } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });
const emptyBranch = { getBranch: () => [] };

const assistantWith = (calls) => ({
	message: {
		role: "assistant",
		content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
	},
});

async function startSession() {
	await emit("session_start", {}, { ui, sessionManager: emptyBranch });
}

/** A new user prompt; the session itself stays alive. */
async function prompt(messageType = "user") {
	await emit("before_agent_start", { messageType }, { ui });
}

async function startTurn() {
	await startSession();
	await prompt();
}

function boxFor(component) {
	const box = tree();
	box.add(component);
	return box;
}

// ---------------------------------------------------------------------------
test("settling persists only the timings, never the counts", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["st-1", "bash"]]), { ui });
	const result = await emitOne("agent_before_settle", {}, { ui });
	assert.ok(result?.entries?.length === 1, "settle returns one custom entry");
	const entry = result.entries[0];
	assert.equal(entry.type, "custom");
	assert.equal(entry.customType, "cc-tools-summary");
	assert.deepEqual(Object.keys(entry.data).sort(), ["thinkingMs", "workedMs"]);
	assert.equal(typeof entry.data.workedMs, "number");
});

test("settling twice is idempotent", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["idem-1", "bash"]]), { ui });
	assert.ok((await emitOne("agent_before_settle", {}, { ui }))?.entries, "first settle writes the entry");
	assert.equal(await emitOne("agent_before_settle", {}, { ui }), undefined, "second settle writes nothing");
});

test("an aborted run still persists its summary through appendEntry", async () => {
	await startTurn();
	const before = appended.length;
	await emit("agent_settled", {}, { ui });
	assert.equal(appended.length, before + 1, "appendEntry is used when the run never settled");
	assert.equal(appended.at(-1).customType, "cc-tools-summary");
});

test("a settled run does not persist twice", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["once-1", "bash"]]), { ui });
	await emit("agent_before_settle", {}, { ui });
	const before = appended.length;
	await emit("agent_settled", {}, { ui });
	assert.equal(appended.length, before, "agent_settled adds nothing after a normal settle");
});

test("a user prompt opens a new run and closes the previous one", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["n-1", "read"]]), { ui });
	await prompt();
	await emit("message_end", assistantWith([["n-2", "bash"]]), { ui });
	await emit("agent_before_settle", {}, { ui });

	const box = tree();
	const first = box.add(tool("read", "n-1", { path: "/work/project/a.ts" }));
	const second = box.add(tool("bash", "n-2", { command: "ls" }));
	first.updateResult(toolResult());
	second.updateResult(toolResult());
	const rows = box.rows();
	assert.equal(rows.length, 2, "one summary per run");
	assert.match(rows[0], /read 1 file/);
	assert.match(rows[1], /ran 1 shell command/);
});

test("a custom message continues the same run instead of resetting it", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["c-1", "bash"]]), { ui });
	// A subagent notification starts its own agent run.
	await emit("before_agent_start", { messageType: "custom" }, { ui });
	await emit("message_end", assistantWith([["c-2", "read"]]), { ui });
	await emit("agent_before_settle", {}, { ui });

	const row = boxFor(tool("read", "c-2", { path: "/work/project/a.ts" })).rows()[0];
	assert.equal(row.trim(), "read 1 file, ran 1 shell command", "counts from both segments survive");
});

test("agent_start reopens a settled run so the summary keeps following the newest call", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["re-1", "bash"]]), { ui });
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	const finished = box.add(tool("bash", "re-1", { command: "ls" }));
	finished.updateResult(toolResult());
	assert.equal(box.rows().length, 1);
	assert.match(box.rows()[0], /ran 1 shell command/);

	await emit("agent_start", {}, { ui });
	assert.deepEqual(box.rows(), [], "a reopened run does not resurrect a finished call");

	// The retry's own call takes the row over.
	const retry = tool("bash", "re-2", { command: "ls again" });
	retry.markExecutionStarted();
	box.add(retry);
	box.text(); // the frame in which a new call appears may still show the old one
	assert.match(box.rows()[0], / ● Running ls · 0s/);
	assert.match(box.rows()[1], /└ \$ ls again/);
});

test("counts are taken from message_end exactly once per tool call", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["d-1", "bash"], ["d-2", "bash"]]), { ui });
	await emit("message_end", assistantWith([["d-1", "bash"], ["d-2", "bash"]]), { ui });
	await emit("agent_before_settle", {}, { ui });
	assert.equal(boxFor(tool("bash", "d-2", { command: "ls" })).rows()[0].trim(), "ran 2 shell commands");
});

test("non-assistant messages do not add counts", async () => {
	await startTurn();
	await emit("message_end", { message: { role: "toolResult", toolCallId: "z-1", content: [] } }, { ui });
	await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } }, { ui });
	await emit("agent_before_settle", {}, { ui });
	const row = boxFor(tool("bash", "z-9", { command: "true" })).rows()[0].trim();
	assert.match(row, /^Worked for \d+s$/, row);
});

test("session_start resets live state and rebuilds runs from the branch", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["reset-1", "bash"]]), { ui });
	await emit("session_start", {}, { ui, sessionManager: emptyBranch });
	// No run, no summary: the component falls back to the default row.
	const row = boxFor(tool("bash", "reset-1", { command: "ls" })).rows()[0];
	assert.equal(row, "● bash(ls)");
});

test("session_shutdown drops the live run", async () => {
	await startTurn();
	await emit("message_end", assistantWith([["sd-1", "bash"]]), { ui });
	await emit("session_shutdown", {}, { ui });
	assert.equal(boxFor(tool("bash", "sd-1", { command: "ls" })).rows()[0], "● bash(ls)");
});

test("a replayed session shows the same summary from the branch", async () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				durationMs: 8000,
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", id: "r-1", name: "read", arguments: { path: "/work/project/a.ts" } },
					{ type: "toolCall", id: "r-2", name: "bash", arguments: { command: "ls" } },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "r-1", content: [] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "r-2", content: [] } },
		{ type: "custom", customType: "cc-tools-summary", data: { thinkingMs: 11_000, workedMs: 30_000 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
	];
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => branch } });

	const box = tree();
	const read = box.add(tool("read", "r-1", { path: "/work/project/a.ts" }));
	const bash = box.add(tool("bash", "r-2", { command: "ls" }));
	read.updateResult(toolResult());
	bash.updateResult(toolResult());
	const rows = box.rows();
	assert.equal(rows.length, 1, "replay shows exactly one summary row");
	assert.equal(rows[0].trim(), "Thought for 11s, read 1 file, ran 1 shell command");
});

test("replay keeps runs separated by user messages", async () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "one" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "b-1", name: "read", arguments: {} }] } },
		{ type: "custom", customType: "cc-tools-summary", data: { thinkingMs: 0, workedMs: 1000 } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "two" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "b-2", name: "bash", arguments: {} }] } },
		{ type: "custom", customType: "cc-tools-summary", data: { thinkingMs: 0, workedMs: 2000 } },
	];
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => branch } });
	const box = tree();
	box.add(tool("read", "b-1", { path: "/work/project/a.ts" })).updateResult(toolResult());
	box.add(tool("bash", "b-2", { command: "ls" })).updateResult(toolResult());
	const rows = box.rows();
	assert.equal(rows.length, 2);
	assert.match(rows[0], /read 1 file/);
	assert.match(rows[1], /ran 1 shell command/);
});

test("a session without a readable branch still loads", async () => {
	await emit("session_start", {}, {
		ui,
		sessionManager: {
			getBranch() {
				throw new Error("no branch yet");
			},
		},
	});
	assert.equal(boxFor(tool("bash", "nb-1", { command: "ls" })).rows()[0], "● bash(ls)");
});

test("a session_start without any session manager does not throw", async () => {
	await emit("session_start", {}, { ui });
	assert.equal(boxFor(tool("bash", "nsm-1", { command: "ls" })).rows()[0], "● bash(ls)");
});

await runTests("state");

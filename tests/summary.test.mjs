/**
 * The settled summary line: category phrases, plural forms, ordering, duration
 * formatting, and the rule that exactly one row carries it.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree } from "./harness.mjs";

const install = await loadExtension();
const { api, emit } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });
const emptyBranch = { getBranch: () => [] };

async function startSession() {
	await emit("session_start", {}, { ui, sessionManager: emptyBranch });
}

/** A new user prompt; the session itself stays alive. */
async function prompt() {
	await emit("before_agent_start", { messageType: "user" }, { ui });
}

async function startTurn() {
	await startSession();
	await prompt();
}

/** Count tool calls through the message path, the way pi reports them. */
async function countCalls(calls) {
	await emit(
		"message_end",
		{
			message: {
				role: "assistant",
				content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
			},
		},
		{ ui },
	);
}

async function settle() {
	await emit("agent_before_settle", {}, { ui });
}

/** Component for the last counted call, so the summary has somewhere to render. */
function summaryTree(lastId) {
	const box = tree();
	const call = tool("bash", lastId, { command: "true" });
	call.updateResult(toolResult({ durationMs: 1000 }));
	box.add(call);
	return box;
}

/** Summary text of a finished run rebuilt from a session branch. */
async function replaySummary(branch, lastId, width = 120) {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => branch } });
	return summaryTree(lastId ?? branch.at(-2)?.message?.content?.at(-1)?.id).rows(width)[0];
}

const branchFor = (summary, calls = [["r-1", "bash"]]) => [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
		},
	},
	{ type: "custom", customType: "cc-tools-summary", data: summary },
];

// ---------------------------------------------------------------------------
test("categories appear in a stable order with correct plural forms", async () => {
	await startTurn();
	await countCalls([
		["o-1", "grep"],
		["o-2", "read"],
		["o-3", "read"],
		["o-4", "edit"],
		["o-5", "bash"],
		["o-6", "bash"],
		["o-7", "bash"],
		["o-8", "Agent"],
		["o-9", "Agent"],
	]);
	await settle();
	const row = summaryTree("o-9").rows(200)[0];
	assert.equal(
		row.trim(),
		"searched for 1 pattern, read 2 files, edited 1 file, ran 3 shell commands, spawned 2 agents",
	);
});

test("singular forms drop the trailing s", async () => {
	await startTurn();
	await countCalls([
		["s-1", "grep"],
		["s-2", "read"],
		["s-3", "write"],
		["s-4", "shell"],
		["s-5", "task"],
		["s-6", "todo"],
	]);
	await settle();
	const row = summaryTree("s-6").rows(200)[0].trim();
	assert.equal(
		row,
		"searched for 1 pattern, read 1 file, edited 1 file, ran 1 shell command, spawned 1 agent, used 1 todo",
	);
});

test("one other tool is named with a plural, several are listed with counts", async () => {
	await startTurn();
	await countCalls([
		["x-1", "todo"],
		["x-2", "todo"],
	]);
	await settle();
	assert.equal(summaryTree("x-2").rows()[0].trim(), "used 2 todos");

	await startTurn();
	await countCalls([
		["y-1", "todo"],
		["y-2", "mcp__jira__get_issue"],
	]);
	await settle();
	assert.equal(summaryTree("y-2").rows(200)[0].trim(), "used todo ×1, jira:get_issue ×1");
});

test("mcp tool names lose the prefix and double underscores", async () => {
	await startTurn();
	await countCalls([["m-1", "mcp__confluence__search_pages"]]);
	await settle();
	assert.equal(summaryTree("m-1").rows()[0].trim(), "used 1 confluence:search_pages");
});

test("thinking time is reported only when it rounds to at least one second", async () => {
	assert.equal(
		(await replaySummary(branchFor({ thinkingMs: 400, workedMs: 5000 }), "r-1")).trim(),
		"ran 1 shell command",
	);
	assert.match(await replaySummary(branchFor({ thinkingMs: 5200, workedMs: 5000 }), "r-1"), /^ Thought for 5s, ran 1 shell command$/);
});

test("durations switch to minutes past sixty seconds", async () => {
	const cases = [
		[59_000, "Thought for 59s"],
		[60_000, "Thought for 1m"],
		[125_000, "Thought for 2m 5s"],
	];
	for (const [thinkingMs, expected] of cases) {
		const row = await replaySummary(branchFor({ thinkingMs, workedMs: thinkingMs }), "r-1");
		assert.ok(row.includes(expected), `${thinkingMs}ms → ${expected} (got: ${row.trim()})`);
	}
});

test("a run with no counted calls falls back to worked time", async () => {
	await startTurn();
	await settle();
	// An anonymous call is never counted, so nothing but the duration is left.
	const box = tree();
	box.add(tool("bash", undefined, { command: "true" }));
	assert.match(box.rows()[0].trim(), /^Worked for \d+s$/);
});

test("only the newest call of a settled run carries the summary", async () => {
	await startTurn();
	await countCalls([
		["t-1", "bash"],
		["t-2", "bash"],
	]);
	await settle();
	const box = tree();
	const older = box.add(tool("bash", "t-1", { command: "one" }));
	const newer = box.add(tool("bash", "t-2", { command: "two" }));
	older.updateResult(toolResult());
	newer.updateResult(toolResult());
	assert.deepEqual(box.frame().filter((line) => line.includes("ran 2 shell commands")).length, 1);
	assert.equal(box.frame()[0], "", "summary row keeps its top padding");
	assert.ok(box.frame()[1].startsWith(" "), "summary is inset like the answer text");
});

test("each settled run renders its own summary, newest tool only", async () => {
	await startTurn();
	await countCalls([["p-1", "read"]]);
	await settle();
	await prompt();
	await countCalls([["q-1", "bash"]]);
	await settle();

	const box = tree();
	const first = box.add(tool("read", "p-1", { path: "/work/project/a.ts" }));
	const second = box.add(tool("bash", "q-1", { command: "ls" }));
	first.updateResult(toolResult());
	second.updateResult(toolResult());
	const rows = box.rows();
	assert.equal(rows.length, 2, "history keeps one summary per run");
	assert.match(rows[0], /read 1 file/);
	assert.match(rows[1], /ran 1 shell command/);
});

test("calls the transcript never announced are not counted", async () => {
	await startTurn();
	await countCalls([["main-1", "bash"]]);
	const box = tree();
	box.add(tool("bash", "main-1", { command: "ls" })).updateResult(toolResult());
	// Subagent / nested activity renders as components too, but the transcript
	// never announced these ids, so they must stay out of the run's counts.
	for (let index = 0; index < 3; index++) {
		const nested = box.add(tool("read", `nested-${index}`, { path: `/work/f${index}.ts` }));
		nested.markExecutionStarted();
		nested.updateResult(toolResult());
	}
	box.text();
	await settle();
	assert.deepEqual(box.rows().map((row) => row.trim()), ["ran 1 shell command"]);
});

test("replay re-derives counts from messages instead of the persisted entry", async () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "d-1", name: "read", arguments: {} },
					{ type: "toolCall", id: "d-2", name: "bash", arguments: {} },
					{ type: "toolCall", id: "d-3", name: "bash", arguments: {} },
				],
			},
		},
		// An older version persisted counts here; they must not be trusted.
		{ type: "custom", customType: "cc-tools-summary", data: { thinkingMs: 0, workedMs: 1000, counts: { read: 99 } } },
	];
	const row = await replaySummary(branch, "d-3");
	assert.equal(row.trim(), "read 1 file, ran 2 shell commands");
});

test("a summary line is truncated to the available width", async () => {
	const row = await replaySummary(branchFor({ thinkingMs: 5000, workedMs: 6000 }, [["r-1", "bash"], ["r-2", "read"]]), "r-2", 20);
	assert.equal(row.length, 20, "row is cut to the width");
	assert.ok(row.endsWith("…"), `cut is marked: ${row}`);
});

await runTests("summary");

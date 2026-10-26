/**
 * A `codemode` call: the script it runs and the tool/MCP calls that script makes.
 *
 * Those nested calls carry the codemode call's id (`<parent>/<n>`), never reach
 * the transcript as rows of their own, and must stay out of the run's counters —
 * the summary keeps reporting one `codemode` call.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree, tui } from "./harness.mjs";

const install = await loadExtension();
const { api, commands, emit } = createPi();
install(api);

const ui = makeUi();
const cwd = "/work/project";
const tool = makeTool(ui, { cwd });
const command = (arg) => commands.get("cc-tools").handler(arg, { ui });

/** The extension reads the working directory from the handler context. */
const ctx = { ui, cwd };

const SCRIPT = `// @options: { "timeoutMs": 60000 }

const found = await searchTools("rank");
await tools.read({ path: "${cwd}/src/config.ts" });
return found;
`;

async function startRun() {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
}

/** Announce the call the way pi does at the end of the assistant message. */
async function announce(id, name = "codemode") {
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] } },
		{ ui },
	);
}

/** One nested call of the script: `tool_execution_start` / `_end` for `<parent>/<n>`. */
async function nestedStart(parentId, index, toolName, args) {
	await emit(
		"tool_execution_start",
		{ toolCallId: `${parentId}/${index}`, toolName, args, parentToolCallId: parentId },
		ctx,
	);
}

async function nestedEnd(parentId, index, toolName, options = {}) {
	await emit(
		"tool_execution_end",
		{
			toolCallId: `${parentId}/${index}`,
			toolName,
			result: { content: [], details: {} },
			isError: options.isError === true,
			...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
			parentToolCallId: parentId,
		},
		ctx,
	);
}

/** A live codemode row, drawn once the call starts executing. */
async function codemodeBox(id, code = SCRIPT) {
	const box = tree();
	const call = box.add(tool("codemode", id, { code }));
	call.markExecutionStarted();
	return { box, call };
}

// ---------------------------------------------------------------------------
test("a codemode call shows its first meaningful script line", async () => {
	await startRun();
	await announce("cm-script");
	const { box } = await codemodeBox("cm-script");
	box.text();
	const rows = box.rows();
	assert.equal(rows[0], " ● codemode · 0s", "the label is the tool name, not its argument keys");
	assert.equal(
		rows[1],
		'   └ const found = await searchTools("rank");',
		"the leading // @options: hint and blank lines are skipped",
	);
	assert.equal(rows.length, 2, "a script line stays one line, like a bash command");
});

test("multi-line scripts collapse into one script line", async () => {
	await startRun();
	await announce("cm-multi");
	const { box } = await codemodeBox("cm-multi", "const a = 1;\nconst b = 2;");
	box.text();
	assert.equal(box.rows()[1], "   └ const a = 1;");
});

test("a script with nothing to show keeps the bare label", async () => {
	await startRun();
	await announce("cm-empty");
	const { box } = await codemodeBox("cm-empty", "// @options: {}\n");
	box.text();
	assert.deepEqual(box.rows(), [" ● codemode · 0s"]);
});

test("nested calls are drawn under the codemode row with status and duration", async () => {
	await startRun();
	await announce("cm-live");
	const { box } = await codemodeBox("cm-live");
	await nestedStart("cm-live", 1, "read", { path: `${cwd}/src/config.ts` });
	await nestedEnd("cm-live", 1, "read", { durationMs: 8 });
	await nestedStart("cm-live", 2, "mcp__dev_radius__search", { query: "rank" });
	box.text();
	const rows = box.rows();
	assert.equal(rows[2], "   └ ✓ read src/config.ts 8ms");
	assert.equal(rows[3], "   └ … dev_radius:search rank", "a running call carries the ellipsis");
});

test("a failed nested call carries a cross", async () => {	await startRun();
	await announce("cm-fail");
	const { box } = await codemodeBox("cm-fail");
	await nestedStart("cm-fail", 1, "bash", { command: "npm test" });
	await nestedEnd("cm-fail", 1, "bash", { isError: true, durationMs: 1200 });
	box.text();
	assert.equal(box.rows()[2], "   └ ✗ bash npm test 1.2s");
});

test("nested search rows quote the pattern and shorten the location", async () => {
	await startRun();
	await announce("cm-search");
	const { box } = await codemodeBox("cm-search");
	await nestedStart("cm-search", 1, "grep", { pattern: "rank", path: `${cwd}/src` });
	await nestedEnd("cm-search", 1, "grep", { durationMs: 21 });
	box.text();
	assert.equal(box.rows()[2], '   └ ✓ grep "rank" in src 21ms');
});

test("nested calls the parent abandoned are marked cancelled", async () => {
	await startRun();
	await announce("cm-abort");
	const { box } = await codemodeBox("cm-abort");
	await nestedStart("cm-abort", 1, "read", { path: `${cwd}/a.ts` });
	// The script ends: the call it left running never reports an end of its own.
	await emit(
		"tool_execution_end",
		{ toolCallId: "cm-abort", toolName: "codemode", result: { content: [] }, isError: false },
		ctx,
	);
	box.text();
	assert.equal(box.rows()[2], "   └ ⊘ read a.ts");
});

test("only the newest nested calls are listed, older ones collapse into a count", async () => {
	await startRun();
	await announce("cm-many");
	const { box } = await codemodeBox("cm-many");
	for (let index = 1; index <= 10; index++) {
		await nestedStart("cm-many", index, "read", { path: `${cwd}/f${index}.ts` });
		await nestedEnd("cm-many", index, "read", { durationMs: 5 });
	}
	box.text();
	const rows = box.rows();
	assert.equal(rows[2], "   └ ... (2 earlier calls)");
	assert.equal(rows.length, 11, "label, script line, the hint and 8 calls");
	assert.match(rows[3], /f3\.ts 5ms$/, "the window keeps the newest calls");
	assert.match(rows.at(-1), /f10\.ts 5ms$/);
});

test("the summary still counts one codemode call, never a call per nested tool", async () => {
	await startRun();
	await announce("cm-count");
	const { box } = await codemodeBox("cm-count");
	for (const [index, name] of [[1, "read"], [2, "grep"], [3, "mcp__jira__get_issue"]]) {
		await nestedStart("cm-count", index, name, { path: `${cwd}/a.ts` });
		await nestedEnd("cm-count", index, name, { durationMs: 4 });
	}
	box.text();
	await emit("agent_before_settle", {}, { ui });
	const rows = box.rows();
	assert.equal(rows[0].trim(), "○ used 1 codemode", "nested calls are not counted as main-agent work");
	assert.equal(rows.length, 2, "the settled run keeps only its summary band");
});

test("a call the transcript never announced is not tracked (a subagent's script)", async () => {
	await startRun();
	await announce("cm-main");
	const { box } = await codemodeBox("cm-main");
	await nestedStart("sub-call", 1, "read", { path: `${cwd}/a.ts` });
	await nestedEnd("sub-call", 1, "read", { durationMs: 4 });
	box.text();
	assert.deepEqual(box.rows(), [" ● codemode · 0s", '   └ const found = await searchTools("rank");']);
});

test("a tall codemode row raises the slot for the rest of the run", async () => {
	await startRun();
	await announce("cm-tall");
	const box = tree();
	const call = box.add(tool("codemode", "cm-tall", { code: "await tools.read({ path: 'a.ts' });" }));
	call.markExecutionStarted();
	for (let index = 1; index <= 3; index++) {
		await nestedStart("cm-tall", index, "read", { path: `${cwd}/a.ts` });
		await nestedEnd("cm-tall", index, "read", { durationMs: 3 });
	}
	const height = box.frame().length;
	assert.equal(height, 6, "gap, label, script line and three nested calls");

	// A finished codemode row keeps the calls it made until the next call takes
	// the line over — and that hand-over must not move what sits below.
	call.updateResult({ ...toolResult({ durationMs: 3000 }) });
	assert.equal(box.frame().length, height, "the finished row keeps the height it reached");
	await announce("cm-next", "bash");
	box.add(tool("bash", "cm-next", { command: "ls" })).markExecutionStarted();
	const frame = box.frame();
	assert.equal(frame.length, height, "the slot keeps the height the tall row reached");
	assert.match(frame[1], / ● Running ls · 0s$/);
});

test("the codemode row stays inside every supported width", async () => {
	await startRun();
	await announce("cm-wide");
	const long = `await tools.mcp__dev_radius__search({ query: "${"x".repeat(120)}" });`;
	const { box } = await codemodeBox("cm-wide", long);
	await nestedStart("cm-wide", 1, "mcp__dev_radius__search", { query: "y".repeat(120) });
	for (const width of [1, 2, 3, 5, 10, 20, 40, 79, 80, 120, 200]) {
		for (const row of box.frame(width)) {
			assert.ok(tui.visibleWidth(row) <= width, `row exceeds width ${width}: ${JSON.stringify(row)}`);
		}
	}
});

test("the row falls back to codemode's own call log when the events are gone", async () => {
	await startRun();
	await announce("cm-replay");
	// A reload (or a component rebuilt from the transcript) leaves no recorded
	// events, but codemode keeps its call log on the result details.
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await startRun();
	await announce("cm-replay");
	const box = tree();
	const call = box.add(tool("codemode", "cm-replay", { code: "await tools.read({ path: 'a.ts' });" }));
	call.markExecutionStarted();
	call.updateResult({
		...toolResult({ durationMs: 500 }),
		details: {
			calls: [
				{ id: "cm-replay/1", name: "read", args: `${cwd}/a.ts`, status: "ok", durationMs: 8 },
				{ id: "cm-replay/2", name: "models.classify", args: "typesafe/jev", status: "error" },
			],
		},
	});
	box.text();
	const rows = box.rows();
	assert.equal(rows[2], `   └ ✓ read ${cwd}/a.ts 8ms`);
	assert.equal(rows[3], "   └ ✗ models.classify typesafe/jev");
});

test("/cc-tools reveal shows the script instead of the argument keys", async () => {
	await startRun();
	await announce("cm-reveal");
	const { box, call } = await codemodeBox("cm-reveal");
	await command("reveal");
	assert.equal(
		box.rows()[0],
		'● codemode const found = await searchTools("rank");',
		"the revealed row names what the script does",
	);
	call.updateResult(toolResult({ isError: true }));
	assert.match(box.rows()[0], / ✗$/);
	await command("hide");
});

await runTests("codemode");

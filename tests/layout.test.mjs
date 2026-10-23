/**
 * Layout safety: every row must fit any width pi can hand it, from a one-column
 * terminal to a very wide one, for the live row, the summary and the fallback.
 */
import assert from "node:assert/strict";
import { createPi, loadExtension, makeTool, makeUi, runTests, test, toolResult, tree, tui } from "./harness.mjs";

const install = await loadExtension();
const { api, emit } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });

const LONG_COMMAND = `rg --glob '!node_modules' --type ts "${"x".repeat(120)}" src | head -40`;
const WIDTHS = [1, 2, 3, 5, 10, 20, 40, 79, 80, 120, 200];

async function startRun() {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
}

function assertFits(rows, width, label) {
	for (const row of rows) {
		assert.ok(tui.visibleWidth(row) <= width, `${label} row exceeds width ${width}: ${JSON.stringify(row)}`);
	}
}

// ---------------------------------------------------------------------------
test("live rows stay inside every supported width", async () => {
	await startRun();
	const call = tool("bash", "w-live", { command: LONG_COMMAND });
	call.markExecutionStarted();
	const box = tree();
	box.add(call);
	for (const width of WIDTHS) assertFits(box.frame(width), width, `live@${width}`);
});

test("summary rows stay inside every supported width", async () => {
	await startRun();
	await emit(
		"message_end",
		{
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "w-1", name: "grep", arguments: {} },
					{ type: "toolCall", id: "w-2", name: "read", arguments: {} },
					{ type: "toolCall", id: "w-3", name: "bash", arguments: {} },
					{ type: "toolCall", id: "w-4", name: "Agent", arguments: {} },
				],
			},
		},
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	box.add(tool("bash", "w-4", { command: "ls" })).updateResult(toolResult());
	for (const width of WIDTHS) assertFits(box.frame(width), width, `summary@${width}`);
});

test("fallback rows stay inside every supported width", async () => {
	// No live run (for example right after session shutdown): components fall
	// back to the single-line `● tool(args)` form.
	await emit("session_shutdown", {});
	const box = tree();
	const call = box.add(tool("bash", "w-reveal", { command: LONG_COMMAND }));
	call.updateResult(toolResult());
	for (const width of WIDTHS) assertFits(box.frame(width), width, `fallback@${width}`);
});

test("every width from 1 to 200 renders without throwing", async () => {
	await startRun();
	const box = tree();
	const call = box.add(tool("bash", "w-sweep", { command: LONG_COMMAND }));
	call.markExecutionStarted();
	for (let width = 1; width <= 200; width++) {
		const rows = box.frame(width);
		assert.ok(Array.isArray(rows), `width ${width} must return rows`);
		assertFits(rows, width, `sweep@${width}`);
	}
});

test("a zero or negative width renders nothing instead of crashing", async () => {
	await startRun();
	const box = tree();
	box.add(tool("bash", "w-zero", { command: "ls" })).markExecutionStarted();
	assert.deepEqual(box.container.render(0), []);
	assert.deepEqual(box.container.render(-5), []);
});

test("truncation marks the cut with an ellipsis rather than slicing a wide character", async () => {
	await startRun();
	const box = tree();
	box.add(tool("bash", "w-ellipsis", { command: LONG_COMMAND })).markExecutionStarted();
	const row = box.rows(40)[1];
	assert.ok(row.endsWith("…"), row);
});

test("ansi styling never inflates the measured width", async () => {
	// The stub theme is plain; real themes wrap text in escapes. Both must fit.
	await startRun();
	const styled = makeUi({
		theme: {
			fg: (_token, text) => `\u001b[36m${text}\u001b[0m`,
			bold: (text) => `\u001b[1m${text}\u001b[0m`,
			italic: (text) => `\u001b[3m${text}\u001b[0m`,
		},
	});
	const call = makeTool(styled, { cwd: "/work/project" })("bash", "w-ansi", { command: LONG_COMMAND });
	call.markExecutionStarted();
	const box = tree();
	box.add(call);
	const container = box.container;
	for (const width of WIDTHS) {
		const rows = container.render(width);
		// Measure with escapes stripped: that is what the terminal consumes.
		for (const row of rows) {
			const visible = tui.visibleWidth(row.replace(/\u001b\[[0-9;]*m/g, ""));
			assert.ok(visible <= width, `styled row exceeds ${width}: ${visible}`);
		}
	}
});

await runTests("layout");

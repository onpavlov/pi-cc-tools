/**
 * Layout safety: every row must fit any width pi can hand it, from a one-column
 * terminal to a very wide one, for the live row, the summary and the fallback.
 */
import assert from "node:assert/strict";
import {
	assistantMessage,
	createPi,
	loadExtension,
	makeTool,
	makeUi,
	runTests,
	test,
	toolResult,
	tree,
	tui,
} from "./harness.mjs";

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

/** A settled run whose summary band is rendered by its only call. */
async function settledSummary(id) {
	await startRun();
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] } },
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	box.add(tool("bash", id, { command: "true" })).updateResult(toolResult());
	return box;
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

test("the summary rule spans the render width and closes the band", async () => {
	const box = await settledSummary("w-band");
	box.add(assistantMessage({ role: "assistant", content: [{ type: "text", text: "Answer." }] }));
	for (const width of [10, 20, 40, 80, 120, 200]) {
		const frame = box.frame(width);
		assert.equal(frame.length, 5, `width ${width}: gap, summary, rule, gap, answer`);
		assert.equal(frame[0], "", `width ${width}: activity is separated from the band`);
		assert.equal(tui.visibleWidth(frame[2]), width, `rule fills width ${width}`);
		assert.equal(frame[2], ` ${"─".repeat(width - 1)}`, `rule is inset like the summary at ${width}`);
		assert.equal(frame[3], "", `width ${width}: exactly one blank line under the rule`);
	}
});

test("a one-column terminal drops the rule instead of wrapping the layout", async () => {
	const box = await settledSummary("w-narrow");
	assert.deepEqual(box.frame(1), ["", "…"]);
	assertFits(box.frame(2), 2, "narrow-band@2");
	assert.ok(box.frame(2)[2].includes("─"), "a two-column terminal still fits one rule cell");
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

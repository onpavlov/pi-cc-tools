/**
 * The rows shown while a run is live: verb, detail, command, a duration, and the
 * check or cross a finished call carries.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
	HIDDEN_OUTPUT,
	createPi,
	loadExtension,
	makeTool,
	makeUi,
	runTests,
	test,
	toolResult,
	tree,
	wait,
} from "./harness.mjs";

const install = await loadExtension();
const { api, emit } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });

async function freshRun(options = {}) {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: options.messageType ?? "user" }, { ui });
}

const plainText = (component, width = 100) => {
	// A row is drawn once the call runs: a bare component is still waiting for
	// its streamed arguments, so the line has not been handed over yet.
	component.markExecutionStarted();
	const box = tree();
	box.add(component);
	return box.text(width);
};

// ---------------------------------------------------------------------------
test("bash call renders as a single activity line plus its command", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "bash-1", { command: "npm view hunk version" }));
	call.markExecutionStarted();
	const rows = box.rows();
	assert.equal(rows.length, 2);
	assert.equal(rows[0], " ● Running npm · 0s");
	assert.equal(rows[1], "   └ $ npm view hunk version");
});

test("live row keeps a blank line above it and a left inset", async () => {
	await freshRun();
	const box = tree();
	box.add(tool("bash", "bash-2", { command: "ls" })).markExecutionStarted();
	const frame = box.frame();
	assert.equal(frame.length, 3);
	assert.equal(frame[0], "");
	assert.ok(frame[1].startsWith(" ● Running"));
});

test("the program name skips env assignments, sudo, env and command", async () => {
	await freshRun();
	const cases = [
		["FOO=1 BAR=2 rg pattern", "Running rg"],
		["sudo npm install", "Running npm"],
		["env NODE_ENV=test node script.js", "Running node"],
		["command git status", "Running git"],
		// Regression: a quoted assignment with spaces used to yield "(Macintosh;".
		['UA="Mozilla/5.0 (Macintosh; Intel Mac OS X)" for u in 1 2; do echo "$u"; done', "Running for"],
		["UA='Mozilla/5.0 (X11; Linux)' curl -sS http://x", "Running curl"],
		['UA="Mozilla/5.0 (Macintosh; X)"; for u in 1 2; do echo "$u"; done', "Running for"],
	];
	for (const [command, expected] of cases) {
		const row = plainText(tool("bash", `prog-${command}`, { command }));
		assert.ok(row.includes(expected), `${command} → ${expected} (got: ${row})`);
	}
});

test("a command without a program keeps its command line", async () => {
	await freshRun();
	const box = tree();
	box.add(tool("bash", "bash-empty", { command: "" })).markExecutionStarted();
	const rows = box.rows();
	assert.equal(rows[0], " ● Running… · 0s");
	assert.equal(rows.length, 1, "no command line when there is no command");
});

test("multi-line commands collapse into one command line", async () => {
	await freshRun();
	const box = tree();
	box.add(tool("bash", "bash-multi", { command: "set -e\necho one\n  echo two" })).markExecutionStarted();
	const rows = box.rows();
	assert.equal(rows.length, 2);
	assert.equal(rows[1], "   └ $ set -e echo one echo two");
});

test("path tools show a path relative to the working directory", async () => {
	await freshRun();
	assert.ok(plainText(tool("read", "read-1", { path: "/work/project/src/app.ts" })).includes(" ● Reading src/app.ts"));
	assert.ok(plainText(tool("edit", "edit-1", { path: "/work/project/a.ts" })).includes(" ● Editing a.ts"));
	assert.ok(plainText(tool("write", "write-1", { path: "/work/project/b.ts" })).includes(" ● Writing b.ts"));
	assert.ok(plainText(tool("apply_patch", "patch-1", { path: "/work/project/c.ts" })).includes(" ● Patching c.ts"));
	assert.ok(plainText(tool("ls", "ls-1", { path: "/work/project/src" })).includes(" ● Listing src"));
});

test("home-relative paths are shortened with a tilde", async () => {
	await freshRun();
	const row = plainText(tool("read", "read-home", { path: `${homedir()}/notes.md` }));
	assert.ok(row.includes(" ● Reading ~/notes.md"), row);
});

test("search tools quote the pattern and name their location", async () => {
	await freshRun();
	const grep = plainText(tool("grep", "grep-1", { pattern: "hunk", path: "/tmp/project" }));
	assert.ok(grep.includes(' ● Searching "hunk" in /tmp/project'), grep);
	assert.ok(plainText(tool("find", "find-1", { pattern: "*.md", path: "/tmp" })).includes(' ● Finding "*.md" in /tmp'));
	assert.ok(plainText(tool("glob", "glob-1", { glob: "**/*.ts" })).includes(' ● Finding "**/*.ts"'));
	assert.ok(plainText(tool("todo", "todo-1", {})).includes(" ● Updating the todo list"));
});

test("unknown tools use the tool name and the most descriptive argument", async () => {
	await freshRun();
	assert.ok(plainText(tool("web_search", "web-1", { query: "cats" })).includes(" ● web_search cats"));
	assert.ok(plainText(tool("shell_custom", "web-2", { prompt: "do it" })).includes(" ● shell_custom do it"));
	const keysOnly = plainText(tool("mystery", "web-3", { alpha: 1, beta: 2 }));
	assert.ok(keysOnly.includes(" ● mystery alpha, beta"), keysOnly);
});

test("the next call takes the line over from a finished one", async () => {
	await freshRun();
	const box = tree();
	const first = box.add(tool("bash", "seq-1", { command: "npm install" }));
	first.markExecutionStarted();
	first.updateResult(toolResult());
	box.text(); // a component is attached to its run on its first render
	assert.match(box.rows()[0], / ● Running npm · 4s ✓$/);

	const second = box.add(tool("grep", "seq-2", { pattern: "hunk", path: "/tmp/project" }));
	second.markExecutionStarted();
	box.text(); // the frame in which a new call appears may still show the old row
	const rows = box.rows();
	assert.equal(rows.length, 1, "only one activity row at a time");
	assert.match(rows[0], / ● Searching "hunk"/);
});

test("a finished call keeps its row until the run settles into its summary", async () => {
	await freshRun();
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "solo-1", name: "bash", arguments: {} }] } },
		{ ui },
	);
	const box = tree();
	const call = box.add(tool("bash", "solo-1", { command: "ls" }));
	call.markExecutionStarted();
	assert.match(box.rows()[0], /Running ls/);
	call.updateResult(toolResult({ durationMs: 4200 }));
	// The call is done: the row keeps its duration and gains a green check, and
	// the model's thinking no longer blanks it out.
	assert.match(box.rows()[0], /Running ls · 4s ✓$/);
	await wait(50);
	assert.equal(box.rows().length, 2, "the finished row stays on screen");
	// Only the summary ends it.
	await emit("agent_before_settle", {}, { ui });
	const rows = box.rows();
	assert.equal(rows.length, 2, "the row collapses into the summary band");
	assert.equal(rows[0], " ○ ran 1 shell command");
});

test("a failed call keeps its row with a cross instead of a check", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "failed-1", { command: "UA=\"x y\" for u in \\" }));
	call.markExecutionStarted();
	call.updateResult(toolResult({ isError: true, durationMs: 82 }));
	assert.match(box.rows()[0], /Running for · 0s ✗$/);
	await wait(50);
	assert.match(box.rows()[0], /✗$/, "a failed call must not linger as done");
});

test("the next call replaces a finished row without a blank frame", async () => {
	await freshRun();
	const box = tree();
	// A command that ends before it can be read keeps its row...
	const first = box.add(tool("bash", "hold-1", { command: "true" }));
	first.markExecutionStarted();
	first.updateResult(toolResult({ durationMs: 10 }));
	assert.match(box.rows()[0], /Running true · 0s ✓$/);
	// ...and the next call takes the line over, so nothing blanks out between them.
	const second = box.add(tool("bash", "hold-2", { command: "sleep 1" }));
	second.markExecutionStarted();
	box.text(); // the frame in which a new call appears may still show the old row
	const rows = box.rows();
	assert.equal(rows.filter((row) => row.includes("Running")).length, 1, "only one activity row at a time");
	assert.match(rows[0], /Running sleep · 0s$/);
});

test("the check and the cross use the theme's success and error tokens", async () => {
	const seen = [];
	const themed = makeUi({
		theme: {
			fg(token, text) {
				seen.push(`${token}:${text}`);
				return text;
			},
			bold: (text) => text,
			italic: (text) => text,
		},
	});
	const themedTool = makeTool(themed, { cwd: "/work/project" });
	await emit("session_start", {}, { ui: themed, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui: themed });
	const okBox = tree();
	const ok = okBox.add(themedTool("bash", "mark-ok", { command: "true" }));
	ok.markExecutionStarted();
	ok.updateResult(toolResult());
	okBox.text();
	assert.ok(seen.includes("success:✓"), `success token used: ${seen.join(", ")}`);

	await emit("before_agent_start", { messageType: "user" }, { ui: themed });
	const badBox = tree();
	const bad = badBox.add(themedTool("bash", "mark-bad", { command: "false" }));
	bad.markExecutionStarted();
	bad.updateResult(toolResult({ isError: true }));
	badBox.text();
	assert.ok(seen.includes("error:✗"), `error token used: ${seen.join(", ")}`);
});

test("setting hideComponent removes the row entirely", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "hidden-1", { command: "ls" }));
	call.markExecutionStarted();
	assert.ok(box.rows().length > 0);
	call.hideComponent = true;
	assert.deepEqual(box.frame(), []);
	call.hideComponent = false;
});

test("the reserved slot keeps the frame height steady while the run is open", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "slot-1", { command: "ls" }));
	call.markExecutionStarted();
	assert.equal(box.frame().length, 3, "gap, activity row and command fill the slot");

	call.updateResult(toolResult({ durationMs: 10 }));
	assert.equal(box.frame().length, 3, "the finished row keeps the slot");
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "the row now carries its check");
	// There is no dwell window: the row stays until the next call replaces it.
	await wait(50);
	assert.equal(box.frame().length, 3, "the slot never shrinks while the run is open");
	assert.match(box.frame()[1], /Running ls · 0s ✓$/);

	const next = box.add(tool("read", "slot-2", { path: "/work/project/a.ts" }));
	next.markExecutionStarted();
	assert.equal(box.frame().length, 3, "the next call takes over the same slot");
	assert.match(box.rows()[0], /Reading a\.ts/);
});

test("a short live row still fills the slot", async () => {
	await freshRun();
	const box = tree();
	box.add(tool("grep", "slot-short", { pattern: "hunk", path: "/work/project" })).markExecutionStarted();
	const frame = box.frame();
	assert.equal(frame.length, 3, "a row without a command is padded below");
	assert.match(frame[1], /Searching "hunk"/);
	assert.equal(frame[2].trim(), "", "the padding sits under the row, never above it");
});

test("an announced call without a component does not drop the slot", async () => {
	await freshRun();
	const box = tree();
	const first = box.add(tool("bash", "slot-ann-1", { command: "ls" }));
	first.markExecutionStarted();
	first.updateResult(toolResult({ durationMs: 10 }));
	box.text();
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "the finished row holds the slot");
	// The transcript announces the next call before its component exists: the
	// row must stay where it is instead of collapsing onto a missing owner.
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "slot-ann-2", name: "grep", arguments: {} }] } },
		{ ui },
	);
	assert.equal(box.frame().length, 3, "the previous call keeps the slot until the new row exists");
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "the announced call does not blank the row");
});

test("a call whose component appears before it is announced keeps the slot", async () => {
	await freshRun();
	const box = tree();
	const first = box.add(tool("bash", "slot-next-1", { command: "ls" }));
	first.markExecutionStarted();
	box.text(); // the row is drawn
	first.updateResult(toolResult({ durationMs: 10 }));
	// The transcript announces the call, so the run's newest known call is it.
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "slot-next-1", name: "bash", arguments: {} }] } },
		{ ui },
	);
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "the finished call holds the slot");

	// Pi creates the next call's component while the model still streams its
	// arguments. The line must keep the finished call instead of flashing an
	// empty `Running… · 0s` and then growing the command chunk by chunk.
	const next = box.add(tool("bash", "slot-next-2", { command: "" }));
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "the streamed call does not blank the row");
	next.updateArgs({ command: "npm te" });
	assert.match(box.frame()[1], /Running ls · 0s ✓$/, "partial arguments do not take the line over");
	assert.equal(next.executionStarted, false);

	// Once the arguments are complete the row swaps in one step.
	next.updateArgs({ command: "npm test" });
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "slot-next-2", name: "bash", arguments: {} }] } },
		{ ui },
	);
	const frame = box.frame();
	assert.equal(frame.length, 3, "the slot does not change height on the swap");
	assert.match(frame[1], /Running npm · 0s$/, "the full command appears at once");
	assert.match(frame[2], /└ \$ npm test$/);
});

test("the first call draws nothing while its arguments are still streaming", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "first-stream", { command: "" }));
	assert.deepEqual(box.frame(), [], "no empty row appears before the call is known");
	call.updateArgs({ command: "npm test" });
	assert.deepEqual(box.frame(), [], "partial arguments still draw nothing");
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "first-stream", name: "bash", arguments: {} }] } },
		{ ui },
	);
	const frame = box.frame();
	assert.equal(frame.length, 3, "the row arrives together with its whole command");
	assert.match(frame[1], /Running npm · 0s$/);
	assert.match(frame[2], /└ \$ npm test$/);
});

test("only one call reserves the slot at a time", async () => {
	await freshRun();
	const box = tree();
	const first = box.add(tool("bash", "slot-one-1", { command: "ls" }));
	first.markExecutionStarted();
	first.updateResult(toolResult({ durationMs: 10 }));
	box.text();
	const second = box.add(tool("grep", "slot-one-2", { pattern: "hunk" }));
	second.markExecutionStarted();
	// The held row yields at once: the successor is already queued behind it.
	const frame = box.frame();
	assert.equal(frame.length, 3, "the predecessor does not keep a slot of its own");
	assert.match(frame[1], /Searching "hunk"/, "the newest call owns the slot");
});

test("the reservation is dropped when the run settles", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("read", "slot-settle", { path: "/work/project/a.ts" }));
	call.markExecutionStarted();
	call.updateResult(toolResult({ durationMs: 2000 }));
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "slot-settle", name: "read", arguments: {} }] } },
		{ ui },
	);
	assert.equal(box.frame().length, 3, "the open run holds the slot");
	await emit("agent_before_settle", {}, { ui });
	const frame = box.frame();
	assert.equal(frame.length, 3, "the settled summary needs only its own gap, line and rule");
	assert.equal(frame[0], "");
	assert.match(frame[1], /read 1 file/);
	assert.equal(frame[2].trim(), "─".repeat(frame[2].trim().length), "the band closes with a rule");
});

test("an expanded tool falls through to the host renderer", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "expanded-1", { command: "ls" }));
	call.markExecutionStarted();
	call.updateResult(toolResult());
	call.setExpanded(true);
	assert.ok(box.text().includes(HIDDEN_OUTPUT), "expanded view shows the real output");
	call.setExpanded(false);
});

test("a live row never leaks tool output", async () => {
	await freshRun();
	const box = tree();
	const call = box.add(tool("bash", "leak-1", { command: "ls" }));
	call.markExecutionStarted();
	call.updateResult(toolResult());
	assert.ok(!box.text().includes(HIDDEN_OUTPUT));
});

test("two calls running at once keep a single row", async () => {
	await freshRun();
	// One assistant message announces both calls; pi runs them at the same time.
	await emit(
		"message_end",
		{
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "par-1", name: "bash", arguments: {} },
					{ type: "toolCall", id: "par-2", name: "bash", arguments: {} },
				],
			},
		},
		{ ui },
	);
	const box = tree();
	const first = box.add(tool("bash", "par-1", { command: "echo one" }));
	first.markExecutionStarted();
	box.text(); // the first call already holds the line
	const second = box.add(tool("bash", "par-2", { command: "echo two" }));
	second.markExecutionStarted();
	const text = box.text();
	assert.equal(text.split("\n").filter((row) => row.includes("Running echo")).length, 1, `only one activity row at a time, got: ${JSON.stringify(text)}`);
	assert.ok(text.includes("echo two"), "the newest running call holds the line");
	assert.ok(!text.includes("echo one"), "the older running call yields the line");
});

await runTests("live-row");

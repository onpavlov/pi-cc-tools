/**
 * The /cc-tools settings menu and the settings file behind it.
 *
 * The persisted state has to be in place before the extension is installed,
 * because that is where the renderer reads it, so the file is written above
 * `loadExtension()`.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
	HIDDEN_OUTPUT,
	SETTINGS_PATH,
	createPi,
	loadExtension,
	makeTool,
	makeUi,
	runTests,
	test,
	toolResult,
	tree,
} from "./harness.mjs";

writeFileSync(SETTINGS_PATH, `${JSON.stringify({ enabled: true, revealAll: true })}\n`);

const install = await loadExtension();
const { api, commands, emit } = createPi();
install(api);

const command = commands.get("cc-tools");
const settings = () => JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });

/** Drive the run through a settle so a row can be rendered. */
async function settledRun() {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
	await emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "toolCall", id: "set-1", name: "bash", arguments: {} }] } },
		{ ui },
	);
	await emit("agent_before_settle", {}, { ui });
	const box = tree();
	const call = box.add(tool("bash", "set-1", { command: "git status" }));
	call.markExecutionStarted();
	call.updateResult(toolResult({ durationMs: 2000 }));
	return { box, call };
}

/** Open the menu and return the component pi would mount, plus the close hook. */
async function openMenu() {
	let mounted;
	let closed = false;
	await command.handler("", {
		mode: "tui",
		ui: makeUi({
			custom: (factory) => {
				mounted = factory({ requestRender() {} }, makeUi().theme, undefined, () => {
					closed = true;
				});
				return Promise.resolve();
			},
		}),
	});
	return { component: mounted, wasClosed: () => closed };
}

// ---------------------------------------------------------------------------
test("outside the TUI the menu points at the shortcuts", async () => {
	const notices = [];
	await command.handler("", { mode: "rpc", ui: makeUi({ notify: (message, level) => notices.push({ message, level }) }) });
	assert.equal(notices.at(-1).level, "error");
	assert.match(notices.at(-1).message, /on\|off\|toggle\|reveal\|hide/);
});

test("the state written by an earlier session is applied on install", async () => {
	const { box } = await settledRun();
	assert.equal(box.rows()[0], "● bash(git status)", "revealed rows come back");
});

test("the menu opens with both settings at their persisted values", async () => {
	const { component } = await openMenu();
	const text = component.render(80).join("\n");
	assert.match(text, /cc-tools settings/);
	assert.match(text, /Claude Code style rows/);
	assert.match(text, /on\b/);
	assert.match(text, /all rows/);
});

test("turning the renderer off in the menu persists the change", async () => {
	const { component } = await openMenu();
	component.handleInput(" ");
	assert.equal(settings().enabled, false, "the file records the renderer state");
	assert.equal(settings().revealAll, true, "the other setting is left alone");

	const { box } = await settledRun();
	assert.ok(box.text().includes(HIDDEN_OUTPUT), "the host renderer takes over");
});

test("a shortcut on the command line persists too", async () => {
	await command.handler("on", { ui });
	assert.deepEqual(settings(), { enabled: true, revealAll: true });
	await command.handler("hide", { ui });
	assert.deepEqual(settings(), { enabled: true, revealAll: false });
});

test("escape closes the menu without touching the settings", async () => {
	const { component, wasClosed } = await openMenu();
	assert.equal(wasClosed(), false, "the menu stays open while it is being used");
	component.handleInput("\x1b");
	assert.equal(wasClosed(), true, "escape finishes the interaction");
	assert.deepEqual(settings(), { enabled: true, revealAll: false }, "leaving the menu changes nothing");
});

test("a corrupt settings file falls back to the last known state", async () => {
	writeFileSync(SETTINGS_PATH, "{ not json");
	install(api);
	const { box } = await settledRun();
	assert.match(box.rows()[0], /ran 1 shell command/, "the renderer keeps the state it had");
});

await runTests("settings.test.mjs");

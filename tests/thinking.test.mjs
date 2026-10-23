/**
 * The hidden-thinking filter: the summary already reports thinking time, so the
 * "Thinking…" placeholder and the blank edges it leaves behind are dropped.
 */
import assert from "node:assert/strict";
import { assistantMessage, createPi, loadExtension, makeUi, runTests, strip, test } from "./harness.mjs";

const install = await loadExtension();
const { api, commands, emit } = createPi();
install(api);

const ui = makeUi();
await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });

const rows = (component, width = 80) =>
	component.render(width).map(strip);

const thinkingAndAnswer = () => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "internal reasoning" },
		{ type: "text", text: "answer" },
	],
	timestamp: 0,
	stopReason: "stop",
});

// ---------------------------------------------------------------------------
test("the placeholder is dropped and the answer is kept", async () => {
	const component = assistantMessage(thinkingAndAnswer());
	const lines = rows(component);
	assert.ok(!lines.some((line) => line.trim() === "Thinking…"), "placeholder is removed");
	assert.ok(lines.some((line) => line.includes("answer")), "answer survives");
});

test("the leading gap stays but trailing blanks are trimmed", async () => {
	const lines = rows(assistantMessage(thinkingAndAnswer()));
	assert.equal(lines[0].trim(), "", "answer keeps the blank line above it");
	assert.notEqual(lines.at(-1).trim(), "", "no trailing blank row");
});

test("blank lines left by the removed placeholder are collapsed", async () => {
	const lines = rows(assistantMessage(thinkingAndAnswer()));
	const blanks = lines.filter((line) => !line.trim()).length;
	assert.equal(blanks, 1, "exactly one separating blank remains");
});

test("a message with only thinking renders nothing at all", async () => {
	const component = assistantMessage({
		role: "assistant",
		content: [{ type: "thinking", thinking: "just thinking" }],
		timestamp: 0,
		stopReason: "stop",
	});
	assert.deepEqual(rows(component), []);
});

test("a message without thinking is untouched", async () => {
	const component = assistantMessage({
		role: "assistant",
		content: [{ type: "text", text: "plain answer" }],
		timestamp: 0,
		stopReason: "stop",
	});
	const lines = rows(component);
	assert.ok(lines.some((line) => line.includes("plain answer")));
});

test("the filter follows the label pi supplies, not a hardcoded string", async () => {
	const custom = rows(assistantMessage(thinkingAndAnswer(), "Размышляю…"));
	assert.ok(!custom.some((line) => line.includes("Размышляю")), "a custom placeholder is dropped too");
	assert.ok(custom.some((line) => line.includes("answer")), "the answer is kept");

	// Only the exact placeholder line is removed; answer text that merely starts
	// with the same words stays.
	const nearMiss = rows(
		assistantMessage(
			{ role: "assistant", content: [{ type: "text", text: "Thinking… about it" }], timestamp: 0, stopReason: "stop" },
			"Thinking…",
		),
	);
	assert.ok(nearMiss.some((line) => line.includes("Thinking… about it")), "near-miss text survives");
});

test("with compact tools off the placeholder comes back", async () => {
	const component = assistantMessage(thinkingAndAnswer());
	await commands.get("cc-tools").handler("off", { ui });
	const lines = rows(component);
	assert.ok(lines.some((line) => line.trim() === "Thinking…"), "host rendering is restored");
	await commands.get("cc-tools").handler("on", { ui });
	assert.ok(!rows(component).some((line) => line.trim() === "Thinking…"), "filter is back on");
});

test("the filter never breaks narrow widths", async () => {
	const component = assistantMessage(thinkingAndAnswer());
	for (let width = 1; width <= 200; width++) {
		assert.ok(Array.isArray(component.render(width)), `width ${width}`);
	}
});

await runTests("thinking");

/**
 * The live marker's pulse: while a call runs, the `●` fades from the theme's
 * accent toward the background and back. Colour only — the row keeps its width,
 * and the animation must die with the row.
 */
import assert from "node:assert/strict";
import {
	EXTENSION_PATH,
	THEME,
	createPi,
	jiti,
	makeTool,
	makeUi,
	runTests,
	strip,
	test,
	tui,
	tree,
} from "./harness.mjs";

const extensionModule = await jiti.import(EXTENSION_PATH);
const install = extensionModule.default;
const { PULSE_PERIOD_MS, pulseAmount } = extensionModule;
const { api, commands, emit } = createPi();
install(api);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repaint counter plus a stub or real theme, one ui per test. */
function countingUi(theme) {
	const counter = { ticks: 0 };
	const ui = makeUi({
		theme,
		requestRender() {
			counter.ticks += 1;
		},
	});
	return { ui, counter };
}

async function startTurn(ui) {
	await emit("session_start", {}, { ui, sessionManager: { getBranch: () => [] } });
	await emit("before_agent_start", { messageType: "user" }, { ui });
}

/** A running bash call in a transcript of its own. */
function runningBox(ui, id, command = "sleep 9") {
	const tool = makeTool(ui, { cwd: "/work/project" });
	const call = tool("bash", id, { command });
	call.markExecutionStarted();
	const box = tree();
	box.add(call);
	return { box, call };
}

/** The first visible row as rendered — escapes included, so a colour can be read. */
function rawRow(box) {
	return box.container.render(80).find((line) => strip(line).trim()) ?? "";
}

/** Render the row repeatedly, so each frame reflects the clock at that moment. */
async function sampleRows(box, count, gapMs) {
	const rows = [];
	for (let index = 0; index < count; index++) {
		rows.push(rawRow(box));
		if (index < count - 1) await wait(gapMs);
	}
	return rows;
}

/** A theme stub that records the concrete colour the pulse asked for. */
function recordingTheme(appearance, accent) {
	const recorded = [];
	const theme = {
		colors: { accent },
		appearance,
		style(text, options) {
			recorded.push(options.fg);
			return text;
		},
		fg: (_token, text) => text,
		bold: (text) => text,
		italic: (text) => text,
	};
	return { theme, recorded };
}

async function setCommand(option) {
	await commands.get("cc-tools").handler(option, { ui: makeUi(), notify() {} });
}

// ---------------------------------------------------------------------------
test("the glow is bounded and reaches both of its ends", () => {
	const samples = [];
	for (let offset = 0; offset < PULSE_PERIOD_MS; offset += 10) samples.push(pulseAmount(offset));
	for (const value of samples) {
		assert.ok(value >= 0, `glow phase went negative: ${value}`);
		assert.ok(value <= 1, `glow phase exceeded 1: ${value}`);
	}
	assert.ok(Math.abs(Math.min(...samples)) < 1e-9, "the dimmest point is reachable");
	assert.ok(Math.abs(Math.max(...samples) - 1) < 1e-9, "the brightest point is reachable");
});

test("the glow depends on the clock only, never on a frame count", () => {
	// Calling it again at the same instant must give the same value: the curve
	// holds no counter of its own, and the same phase a few periods later is
	// identical, so a skipped frame or a repaint cannot desync the glow.
	const at = pulseAmount(137);
	for (let repeat = 0; repeat < 50; repeat++) assert.equal(pulseAmount(137), at);
	for (const offset of [0, 400, 900, 999]) {
		assert.equal(pulseAmount(offset), pulseAmount(offset + PULSE_PERIOD_MS * 7));
	}
	// Two phases differ — otherwise nothing would be glowing.
	assert.notEqual(pulseAmount(0), pulseAmount(PULSE_PERIOD_MS / 2));
});

test("the fading marker stays one cell and the row layout is unchanged", async () => {
	const { ui } = countingUi(THEME);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-width");
	const frames = await sampleRows(box, 12, 40);
	const widths = new Set(frames.map((row) => strip(row).length));
	assert.equal(widths.size, 1, `the row changed width while pulsing: ${[...widths].join(", ")}`);
	for (const row of frames) {
		assert.equal(strip(row).indexOf("Running"), 3, `the dot took more than one cell: ${JSON.stringify(strip(row))}`);
		assert.ok(strip(row).startsWith(" ● Running sleep · "), `unexpected row: ${JSON.stringify(strip(row))}`);
	}
	// The cell itself is repainted: the escape ahead of the dot differs per phase.
	const colours = new Set(frames.map((row) => row.slice(0, row.indexOf("●"))));
	assert.ok(colours.size > 2, `the marker did not change colour: ${colours.size} distinct values`);
});

test("the running marker shimmers at animation cadence", async () => {
	const { ui, counter } = countingUi(THEME);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-cadence");
	box.text();
	const before = counter.ticks;
	await wait(350);
	assert.ok(counter.ticks - before >= 3, `expected glow frames, got ${counter.ticks - before} repaints`);
});

test("without a theme the dot is plain and no animation is armed", async () => {
	// The stub theme exposes fg/bold/italic but no concrete colours: it renders
	// the marker as-is and keeps the slow seconds timer instead of a frame timer.
	const { ui, counter } = countingUi(makeUi().theme);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-plain");
	const row = rawRow(box);
	assert.ok(row.startsWith(" ● Running sleep · 0s"), `unexpected row: ${JSON.stringify(row)}`);
	const before = counter.ticks;
	await wait(300);
	assert.equal(counter.ticks, before, "a theme without colours must not animate");
	// The idle cadence is still there: the elapsed seconds have to keep moving.
	await wait(900);
	assert.ok(counter.ticks > before, "the seconds timer still fires");
});

test("a finished call keeps a static check instead of pulsing", async () => {
	const { ui, counter } = countingUi(THEME);
	await startTurn(ui);
	const { box, call } = runningBox(ui, "pulse-done", "sleep 1");
	box.text();
	call.updateResult({ content: [{ type: "text", text: "done" }], isError: false, durationMs: 1000 });
	const frames = await sampleRows(box, 4, 80);
	for (const row of frames) {
		assert.match(strip(row), /Running sleep · 1s ✓$/, `the check must stay put: ${JSON.stringify(row)}`);
	}
	assert.equal(new Set(frames).size, 1, "a finished row is not repainted differently");
	const settled = counter.ticks;
	await wait(300);
	assert.equal(counter.ticks, settled, "no pulse timer survives the call");
});

test("a settled run's summary band stays static", async () => {
	const { ui, counter } = countingUi(THEME);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-settle");
	box.text();
	await emit("agent_before_settle", {}, { ui });
	const before = counter.ticks;
	const frames = await sampleRows(box, 4, 80);
	assert.equal(new Set(frames).size, 1, "the summary band does not animate");
	assert.ok(strip(frames[0]).includes("○"), `unexpected summary row: ${JSON.stringify(frames[0])}`);
	assert.equal(counter.ticks, before, "a settled run asks for no frames");
});

test("/cc-tools off stops the pulse timer", async () => {
	const { ui, counter } = countingUi(THEME);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-off");
	box.text();
	await wait(250);
	assert.ok(counter.ticks > 0, "the pulse was running");
	await setCommand("off");
	const afterOff = counter.ticks;
	await wait(300);
	assert.equal(counter.ticks, afterOff, "a hidden row must not keep the animation alive");
	await setCommand("on");
});

test("/cc-tools reveal stops the pulse timer", async () => {
	const { ui, counter } = countingUi(THEME);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-reveal");
	box.text();
	await wait(250);
	assert.ok(counter.ticks > 0, "the pulse was running");
	await setCommand("reveal");
	const afterReveal = counter.ticks;
	await wait(300);
	assert.equal(counter.ticks, afterReveal, "revealed rows are compact one-liners, not a pulse");
	await setCommand("hide");
});

test("a custom theme handing out string colours keeps a static dot", async () => {
	// Extensions sometimes expose their own theme shim; a string is not a Color,
	// so mixing would throw mid-render. The row must stay plain and unanimated.
	const shim = { colors: { accent: "#7aa2f7" }, style: () => "●", fg: (_token, text) => text, bold: (t) => t, italic: (t) => t };
	const { ui, counter } = countingUi(shim);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-shim");
	assert.ok(strip(rawRow(box)).startsWith(" ● Running sleep · 0s"), "the row still renders");
	const before = counter.ticks;
	await wait(300);
	assert.equal(counter.ticks, before, "a theme with unusable colours must not animate");
});

test("the glow keeps the accent's hue and chroma", async () => {
	// The point of the glow: the dot changes brightness only. A mix with the
	// background would drag chroma down and grey the accent out instead.
	const accent = tui.rgbColor(167, 152, 215);
	const { theme, recorded } = recordingTheme("dark", accent);
	const { ui } = countingUi(theme);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-glow-chroma");
	await sampleRows(box, 28, 40);
	const base = tui.colorToOklch(accent);
	assert.ok(recorded.length >= 20, `expected samples, got ${recorded.length}`);
	for (const color of recorded) {
		const oklch = tui.colorToOklch(color);
		assert.ok(Math.abs(oklch.c - base.c) < 1e-6, `chroma drifted: ${oklch.c} vs ${base.c}`);
		assert.ok(Math.abs(oklch.h - base.h) < 0.5, `hue drifted: ${oklch.h} vs ${base.h}`);
	}
});

test("the dot brightens above and dims below the accent", async () => {
	const accent = tui.rgbColor(167, 152, 215);
	const { theme, recorded } = recordingTheme("dark", accent);
	const { ui } = countingUi(theme);
	await startTurn(ui);
	const { box } = runningBox(ui, "pulse-glow-range");
	await sampleRows(box, 28, 40);
	const lightness = recorded.map((color) => tui.colorToOklch(color).l);
	const accentLightness = tui.colorToOklch(accent).l;
	assert.ok(lightness.length >= 20, `expected samples, got ${lightness.length}`);
	assert.ok(Math.min(...lightness) < accentLightness - 0.05, `the dimmest point is below the accent: ${Math.min(...lightness)}`);
	assert.ok(Math.max(...lightness) > accentLightness + 0.05, `the brightest point is above the accent: ${Math.max(...lightness)}`);
});

await runTests("pulse");

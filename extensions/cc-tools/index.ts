/**
 * Claude-Code-style tool output, display-only.
 *
 * While a run is going, every tool row except the newest one is hidden, so the
 * transcript shows a single line: what pi is doing right now plus its command.
 * A finished call keeps that row and gains a green check until the next call
 * takes the line over, so a burst of short commands never leaves a blank gap or
 * a blinking line. The activity area keeps a fixed height from the first call
 * to the settle — an empty slot when no row is drawn — because the transcript
 * follows the terminal bottom and a line appearing or disappearing there
 * scrolls the whole screen. When the run settles, the slot is dropped and the
 * row collapses into one summary line ("Thought for 4s, searched for 1 pattern,
 * ran 3 shell commands") that sits right above the final answer. Ctrl+O (or a
 * click on the summary) reveals the rows again;
 * `/cc-tools` opens a settings menu; `/cc-tools on|off|toggle|reveal|hide`
 * still works as a shortcut.
 *
 * Nothing here touches model messages or the session transcript semantics; the
 * only session write is a `cc-tools-summary` custom entry used to render the
 * same summary when the session is replayed. The renderer settings are the one
 * thing kept outside the session, in `cc-tools.json` under the agent directory,
 * so `/cc-tools` carries them from one session to the next.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	getAgentDir,
	getSettingsListTheme,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Color,
	Container,
	type SettingItem,
	SettingsList,
	Text,
	colorToOklch,
	oklchColor,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const SETTINGS_FILE = (): string => join(getAgentDir(), "cc-tools.json");

function loadSettings(): { enabled?: boolean; revealAll?: boolean } {
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_FILE(), "utf8"));
		const out: { enabled?: boolean; revealAll?: boolean } = {};
		if (typeof raw?.enabled === "boolean") out.enabled = raw.enabled;
		if (typeof raw?.revealAll === "boolean") out.revealAll = raw.revealAll;
		return out;
	} catch {
		return {};
	}
}

function saveSettings(settings: { enabled: boolean; revealAll: boolean }): void {
	try {
		mkdirSync(dirname(SETTINGS_FILE()), { recursive: true });
		writeFileSync(SETTINGS_FILE(), `${JSON.stringify(settings, null, 2)}\n`);
	} catch {
		// Persisting is best effort; the in-memory state still applies.
	}
}

const PATCH = Symbol.for("cc-tools:patch:v1");
const THINKING_FILTER = Symbol.for("cc-tools:thinking-filter:v1");
/** Container a tool component was added to, so a row can tell whether a newer one follows. */
const PARENT = Symbol.for("cc-tools:parent:v1");
const PARENT_TRACKING = Symbol.for("cc-tools:parent-tracking:v1");
/** Bumped when the patch layout changes, so a reload can migrate older state. */
const PATCH_VERSION = 4;
/** New object on every module evaluation: tells a reload from a repeated install. */
const LOAD_TOKEN = Symbol("cc-tools-load");
const SUMMARY_ENTRY = "cc-tools-summary";

// Built from a string so the source carries no literal control characters.
const ANSI = new RegExp("\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "g");
/** Left inset of the activity and summary rows, matching the answer text column. */
const ROW_PAD = " ";
/**
 * Height the activity area keeps while a run is going: the gap above the row,
 * the row, and its command line. The transcript follows the terminal bottom, so
 * a line that appears or disappears there scrolls the whole screen; holding the
 * slot at the height of the tallest row is what keeps the output below it still.
 */
const LIVE_SLOT_LINES = 3;
/**
 * Nested calls a row lists before it collapses the older ones into a count,
 * matching Pi's own codemode renderer. A script can make hundreds of calls;
 * the row still holds one line each and never takes over the screen.
 */
const NESTED_PREVIEW_COUNT = 8;
/**
 * One breath of the live marker. Shorter than a fade because the glow travels a
 * smaller distance: it reads as a shimmer rather than a slow pulse.
 */
export const PULSE_PERIOD_MS = 1000;
/**
 * How far the accent's lightness travels either side of its own value, in OKLCH.
 * The dot is never mixed with the background, so its hue and chroma stay put —
 * it brightens and dims instead of washing out.
 */
const PULSE_GLOW = 0.14;
/** Repaint cadence; a colour-only change of one cell needs no more. */
const PULSE_FRAME_MS = 90;
/** Cadence when the theme cannot animate: only the seconds counter needs it. */
const IDLE_TICK_MS = 1000;

/** Opt-in tracing: set PI_CC_TOOLS_DEBUG=/path/to/log to capture what the rows do. */
function trace(message: string): void {
	const path = process.env.PI_CC_TOOLS_DEBUG;
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Tracing must never break rendering.
	}
}
const plain = (text: string) => text.replace(ANSI, "");
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

type Counts = {
	read: number;
	search: number;
	shell: number;
	edit: number;
	agents: number;
	other: Record<string, number>;
};

/** A tool call a tool made while it ran (`ctx.executeTool()`), never a transcript row. */
type NestedStatus = "running" | "ok" | "error" | "cancelled";

type NestedCall = {
	id: string;
	name: string;
	/** One-line argument preview, computed once when the call starts. */
	detail: string;
	status: NestedStatus;
	durationMs?: number;
};

type Run = {
	startedAt: number;
	thinkingMs: number;
	workedMs: number;
	counts: Counts;
	toolIds: string[];
	/** Tool calls already accounted for in `counts`. */
	counted?: Set<string>;
	/** Execution progress per tool call, refreshed whenever a row renders. */
	progress?: Map<string, { started: boolean; done: boolean }>;
	/** Newest tool call the transcript announced: the row that carries the summary. */
	lastToolId?: string;
	/** Newest component seen at all, used only when nothing was announced. */
	lastSeenId?: string;
	finished: boolean;
};

type PersistedSummary = {
	thinkingMs: number;
	workedMs: number;
};

type PatchState = {
	patched: true;
	/** Layout of this state object; a mismatch means an older copy wrote it. */
	version?: number;
	/** Module that installed the current wrapper; a different token means /reload. */
	loadToken?: symbol;
	/** Untouched prototype methods, recorded so a reload can replace stale closures. */
	originalRender?: (this: unknown, width: number) => string[];
	originalMouse?: (this: unknown, event: unknown) => unknown;
	enabled: boolean;
	revealAll: boolean;
	ui?: ExtensionContext["ui"];
	live: Run | null;
	/** toolCallId -> run it belongs to (live and replayed). */
	runs: Map<string, Run>;
	/** Ids the transcript announced. Anything else is subagent/nested activity. */
	announced: Set<string>;
	toolStartAt: Map<string, number>;
	/** Highest elapsed value already shown per tool call: the row never rewinds. */
	shownSeconds?: Map<string, number>;
	thinkingStartAt: number;
	/** One-shot timer that keeps the elapsed seconds moving while a tool runs. */
	ticker?: ReturnType<typeof setTimeout>;
	/** Calls whose rows already collapsed at settle: never drawn as a row again. */
	settled?: Set<string>;
	/** Last time a live row was actually drawn, and whether it was still running. */
	lastLiveAt?: number;
	liveRunning?: boolean;
	/** Last elapsed value written to the debug trace, so it logs per second, not per repaint. */
	__ccSeconds?: number;
	/** Nested calls per calling tool call id: drawn under its row, never counted. */
	nested?: Map<string, NestedCall[]>;
	/** Height the activity slot has reached in the open run; it never shrinks before settle. */
	slotLines?: number;
	/** UI of the row currently on screen: the way a nested call asks for its sub-row. */
	rowUi?: { requestRender?: () => void };
};

type Styler = {
	/** Concrete colours per token, when the theme resolves them (a real Theme does). */
	colors?: Readonly<Record<string, Color | undefined>>;
	/** Render text with a concrete colour, at whatever terminal colour mode applies. */
	style?(text: string, options: { fg?: Color }): string;
	fg(token: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
};

const NO_STYLE: Styler = { fg: (_token, text) => text, bold: (text) => text, italic: (text) => text };

function styler(st: PatchState): Styler {
	// SAFETY: Theme exposes fg/bold/italic with (token, text) signatures, which is all
	// Styler declares; narrowing to it only drops members this module never calls.
	const theme = st.ui?.theme as unknown as Styler | undefined;
	return theme && typeof theme.fg === "function" ? theme : NO_STYLE;
}

/**
 * The phase of the glow at `now`, 0…1: 0 is the dimmest point, 1 the brightest.
 * A pure function of the clock, so a frame pi's diffing skipped, a repaint or a
 * `/reload` cannot desync it. Exported so the curve can be checked without a
 * terminal.
 */
export function pulseAmount(now: number): number {
	const phase = ((now % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
	// Cosine, so the glow leaves the bright peak and returns to it without a jump.
	return (1 - Math.cos((2 * Math.PI * phase) / PULSE_PERIOD_MS)) / 2;
}

/** The accent's own hue and chroma with its lightness shifted by the glow. */
function glowColor(accent: Color, amount: number): Color {
	const oklch = colorToOklch(accent);
	const lightness = oklch.l + (amount * 2 - 1) * PULSE_GLOW;
	// Stays inside the sRGB gamut: an accent already near white or black must not
	// clamp into a colour the terminal cannot show.
	return oklchColor(Math.min(0.98, Math.max(0.02, lightness)), oklch.c, oklch.h);
}

/**
 * The concrete accent colour a theme resolves, if it exposes a usable one. A
 * custom theme may hand out a plain string: mixing needs a real `Color`, so
 * such a theme keeps a static dot instead of throwing mid-render.
 */
function concreteAccent(style: Styler): Color | undefined {
	const accent = style.colors?.accent;
	// SAFETY: the shape check below is exactly what a Colour carries; anything
	// else (a plain string from a custom theme) is rejected instead of passed on.
	const candidate = accent as { kind?: unknown } | undefined;
	if (!candidate || typeof candidate !== "object" || typeof candidate.kind !== "string") return undefined;
	return accent;
}

/** Whether this theme can animate the marker: without concrete colours it cannot. */
function pulsing(style: Styler): boolean {
	return concreteAccent(style) !== undefined && typeof style.style === "function";
}

/**
 * The live marker. Colour only: the glyph stays one cell wide, so the row never
 * reflows and the activity slot keeps its height.
 */
function pulseMarker(style: Styler, now: number): string {
	const accent = concreteAccent(style);
	const render = style.style;
	if (!accent || typeof render !== "function") return style.fg("accent", "●");
	try {
		return render.call(style, "●", { fg: glowColor(accent, pulseAmount(now)) });
	} catch {
		// Rendering must never fail because a colour could not be shifted.
		return style.fg("accent", "●");
	}
}

function emptyCounts(): Counts {
	return { read: 0, search: 0, shell: 0, edit: 0, agents: 0, other: {} };
}

function newRun(): Run {
	return {
		startedAt: Date.now(),
		thinkingMs: 0,
		workedMs: 0,
		counts: emptyCounts(),
		toolIds: [],
		counted: new Set(),
		progress: new Map(),
		finished: false,
	};
}

function shortToolName(name: string): string {
	if (!name.startsWith("mcp__")) return name;
	return name.slice("mcp__".length).replace(/__/g, ":");
}

function countTool(run: Run, toolName: string): void {
	switch (toolName) {
		case "read":
			run.counts.read++;
			return;
		case "grep":
		case "find":
		case "glob":
			run.counts.search++;
			return;
		case "bash":
		case "shell":
		case "powershell":
			run.counts.shell++;
			return;
		case "edit":
		case "write":
		case "apply_patch":
		case "multi_edit":
			run.counts.edit++;
			return;
		case "Agent":
		case "agent":
		case "task":
			run.counts.agents++;
			return;
		default: {
			const name = shortToolName(toolName);
			run.counts.other[name] = (run.counts.other[name] ?? 0) + 1;
		}
	}
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function duration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function countPhrases(counts: Counts): string[] {
	const parts: string[] = [];
	if (counts.search > 0) parts.push(`searched for ${plural(counts.search, "pattern")}`);
	if (counts.read > 0) parts.push(`read ${plural(counts.read, "file")}`);
	if (counts.edit > 0) parts.push(`edited ${plural(counts.edit, "file")}`);
	if (counts.shell > 0) parts.push(`ran ${plural(counts.shell, "shell command")}`);
	if (counts.agents > 0) parts.push(`spawned ${plural(counts.agents, "agent")}`);
	const others = Object.entries(counts.other);
	if (others.length === 1) parts.push(`used ${plural(others[0][1], others[0][0])}`);
	else if (others.length > 1) parts.push(`used ${others.map(([name, count]) => `${name} ×${count}`).join(", ")}`);
	return parts;
}

function summaryText(run: Run): string {
	const parts: string[] = [];
	const thoughtSeconds = Math.round(run.thinkingMs / 1000);
	if (thoughtSeconds >= 1) parts.push(`Thought for ${duration(thoughtSeconds)}`);
	parts.push(...countPhrases(run.counts));
	if (parts.length === 0) {
		const workedSeconds = Math.max(1, Math.round(run.workedMs / 1000));
		parts.push(`Worked for ${duration(workedSeconds)}`);
	}
	return parts.join(", ");
}

function relativePath(path: string | undefined, cwd: string | undefined): string {
	if (!path) return "";
	let value = path;
	if (cwd && value.startsWith(`${cwd}/`)) value = value.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && value.startsWith(`${home}/`)) value = `~${value.slice(home.length)}`;
	return value;
}

function quoted(pattern: unknown, where?: string, cwd?: string): string {
	const text = typeof pattern === "string" ? `"${pattern}"` : "";
	const location = where ? ` in ${relativePath(where, cwd)}` : "";
	return `${text}${location}`;
}

function argumentSummary(args: any): string {
	if (!args || typeof args !== "object") return "";
	const value = args.path ?? args.description ?? args.query ?? args.prompt ?? args.command ?? args.name;
	if (typeof value === "string") return oneLine(value);
	const keys = Object.keys(args);
	return keys.length > 0 ? keys.join(", ") : "";
}

function programOf(command: string): string {
	const tokens = command.split(" ");
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		index += 1;
		if (!token) continue;
		const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(token);
		if (assignment) {
			// `UA="Mozilla/5.0 (Macintosh; …"` spans tokens: skip the whole value.
			const value = token.slice(assignment[0].length);
			const quote = value[0];
			if ((quote === '"' || quote === "'") && !value.slice(1).includes(quote)) {
				while (index < tokens.length) {
					const next = tokens[index];
					index += 1;
					// `X)";` closes the value and keeps the following `;`.
					if (next.includes(quote)) break;
				}
			}
			continue;
		}
		if (token.includes("=")) continue;
		if (token === "sudo" || token === "env" || token === "command") continue;
		return token;
	}
	return "";
}

/** A tool call's row: what it does, its command line, and anything below it. */
type ToolRow = {
	verb: string;
	detail: string;
	/** Exact label, for a tool whose name is the whole row (`codemode`). */
	title?: string;
	/** Second line: what the call runs. */
	command?: string;
	/** What follows the `└` on that line: a shell command, or a bare script line. */
	commandPrefix?: string;
};

/**
 * The first line of a script that says something: codemode's arguments are raw
 * JavaScript, so the leading `// @options:` hint and blank lines say nothing and
 * the keys-only fallback (`code`) is worse than useless.
 */
function firstScriptLine(code: unknown): string {
	if (typeof code !== "string") return "";
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		return oneLine(trimmed);
	}
	return "";
}

function describeTool(component: any): ToolRow {
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const cwd = typeof component.cwd === "string" ? component.cwd : undefined;
	switch (name) {
		case "bash": {
			const command = oneLine(String(args.command ?? ""));
			return { verb: "Running", detail: programOf(command), command, commandPrefix: "$ " };
		}
		case "codemode":
			return { verb: "codemode", detail: "", title: "codemode", command: firstScriptLine(args.code), commandPrefix: "" };
		case "read":
			return { verb: "Reading", detail: relativePath(args.path, cwd) };
		case "edit":
			return { verb: "Editing", detail: relativePath(args.path, cwd) };
		case "write":
			return { verb: "Writing", detail: relativePath(args.path, cwd) };
		case "apply_patch":
			return { verb: "Patching", detail: relativePath(args.path, cwd) };
		case "grep":
			return { verb: "Searching", detail: quoted(args.pattern, args.path) };
		case "find":
		case "glob":
			return { verb: "Finding", detail: quoted(args.pattern ?? args.glob, args.path) };
		case "ls":
			return { verb: "Listing", detail: relativePath(args.path ?? ".", cwd) };
		case "todo":
			return { verb: "Updating", detail: "the todo list" };
		default:
			return { verb: name, detail: argumentSummary(args) };
	}
}

/** One-line preview of a nested call's arguments, shortened like a row's detail. */
function nestedDetail(name: string, args: any, cwd: string | undefined): string {
	if (!args || typeof args !== "object") return "";
	switch (name) {
		case "grep":
			return quoted(args.pattern, args.path, cwd);
		case "find":
		case "glob":
			return quoted(args.pattern ?? args.glob, args.path, cwd);
		case "bash":
		case "shell":
			return oneLine(String(args.command ?? ""));
		default: {
			const path = args.path ?? args.file;
			if (typeof path === "string") return relativePath(path, cwd);
			return argumentSummary(args);
		}
	}
}

function millis(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function nestedIcon(style: Styler, status: NestedStatus): string {
	switch (status) {
		case "ok":
			return style.fg("success", "✓");
		case "error":
			return style.fg("error", "✗");
		case "cancelled":
			return style.fg("muted", "⊘");
		default:
			return style.fg("warning", "…");
	}
}

function knownStatus(value: unknown): NestedStatus {
	if (value === "running" || value === "ok" || value === "error" || value === "cancelled") return value;
	return "ok";
}

/**
 * Remember a nested call under the tool call that made it. Only a call the
 * transcript announced is tracked: a subagent's codemode script reaches the same
 * handlers, and its calls would linger without ever being drawn.
 */
function startNested(st: PatchState, parentId: string, event: any, cwd: string | undefined): void {
	if (!st.live || !st.announced.has(parentId)) return;
	const id = String(event?.toolCallId ?? "");
	if (!id) return;
	st.nested ??= new Map();
	let calls = st.nested.get(parentId);
	if (!calls) {
		calls = [];
		st.nested.set(parentId, calls);
	}
	if (calls.some((call) => call.id === id)) return;
	const name = String(event?.toolName ?? "tool");
	calls.push({
		id,
		name,
		detail: nestedDetail(name, event?.args, cwd),
		status: "running",
	});
	trace(`N start parent=${parentId} id=${id} name=${name} calls=${calls.length}`);
	// The parent may not publish an update of its own, so ask for the repaint
	// that draws the new sub-row.
	st.rowUi?.requestRender?.();
}

function endNested(st: PatchState, parentId: string, event: any): void {
	const calls = st.nested?.get(parentId);
	if (!calls) return;
	const id = String(event?.toolCallId ?? "");
	const call = calls.find((candidate) => candidate.id === id);
	if (!call) return;
	call.status = event?.isError === true ? "error" : "ok";
	if (typeof event?.durationMs === "number") call.durationMs = event.durationMs;
	trace(`N end parent=${parentId} id=${id} status=${call.status} ms=${call.durationMs ?? "?"}`);
	st.rowUi?.requestRender?.();
}

/** Calls a parent stopped waiting for — an aborted script — never report an end. */
function cancelNested(st: PatchState, parentId: string): void {
	for (const call of st.nested?.get(parentId) ?? []) {
		if (call.status === "running") call.status = "cancelled";
	}
}

/**
 * The nested calls of one component: what the live events recorded, or — after a
 * reload dropped them — the call log codemode itself keeps on its result.
 */
function nestedCallsOf(st: PatchState, component: any): NestedCall[] {
	const recorded = st.nested?.get(String(component.toolCallId));
	if (recorded?.length) return recorded;
	if (String(component.toolName) !== "codemode") return [];
	const calls = component.result?.details?.calls;
	if (!Array.isArray(calls)) return [];
	return calls.map((call: any) => ({
		id: String(call?.id ?? ""),
		name: String(call?.name ?? "tool"),
		detail: oneLine(String(call?.args ?? "")),
		status: knownStatus(call?.status),
		durationMs: typeof call?.durationMs === "number" ? call.durationMs : undefined,
	}));
}

/** The newest nested calls of a row, oldest hidden behind a count. */
function nestedRows(st: PatchState, component: any, style: Styler): string[] {
	const calls = nestedCallsOf(st, component);
	if (calls.length === 0) return [];
	const shown = calls.slice(-NESTED_PREVIEW_COUNT);
	const hidden = calls.length - shown.length;
	const lead = `${ROW_PAD}  ${style.fg("dim", "└ ")}`;
	const lines: string[] = [];
	if (hidden > 0) lines.push(`${lead}${style.fg("muted", `... (${hidden} earlier ${hidden === 1 ? "call" : "calls"})`)}`);
	for (const call of shown) {
		const detail = call.detail ? ` ${style.fg("muted", call.detail)}` : "";
		const took = typeof call.durationMs === "number" ? ` ${style.fg("dim", millis(call.durationMs))}` : "";
		const name = style.fg("toolTitle", shortToolName(call.name));
		lines.push(`${lead}${nestedIcon(style, call.status)} ${name}${detail}${took}`);
	}
	return lines;
}

/** A partially streamed result is not a finished call. */
function stillRunning(component: any): boolean {
	return component.isPartial !== false;
}

function elapsedSeconds(st: PatchState, component: any): number {
	const running = stillRunning(component);
	const id = String(component.toolCallId);
	// Only a finished call has a trustworthy duration: a tool that streams output
	// may report a partial result carrying durationMs 0.
	const recorded = component.result?.durationMs;
	let seconds: number;
	if (!running && typeof recorded === "number") {
		seconds = Math.max(0, Math.round(recorded / 1000));
	} else {
		let started = st.toolStartAt.get(id);
		if (!started) {
			started = Date.now();
			st.toolStartAt.set(id, started);
		}
		seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
	}
	// A component pi recreates mid-call (navigation, compaction) must not restart
	// the clock; the row only ever moves forward while the call is in flight.
	const shown = st.shownSeconds?.get(id);
	if (running && shown !== undefined && seconds < shown) seconds = shown;
	if (st.shownSeconds) st.shownSeconds.set(id, seconds);
	return seconds;
}

function stopTicker(st: PatchState): void {
	if (st.ticker === undefined) return;
	clearTimeout(st.ticker);
	st.ticker = undefined;
}

/** Frame cadence: fast enough for the pulse, slower when only seconds move. */
function liveTickMs(st: PatchState): number {
	return pulsing(styler(st)) ? PULSE_FRAME_MS : IDLE_TICK_MS;
}

/**
 * Pi repaints the transcript only when something changes, so a tool that runs
 * without emitting output would freeze its elapsed seconds — and a colour-only
 * pulse needs a frame far more often than once a second. Re-request a render on
 * one timer for as long as a call of the live run is still executing.
 */
function tickLive(st: PatchState, ui: any): void {
	if (st.ticker !== undefined || typeof ui?.requestRender !== "function") {
		if (st.ticker === undefined) trace(`T arm-skipped ui=${typeof ui?.requestRender}`);
		return;
	}
	const frameMs = liveTickMs(st);
	trace(`T arm ${frameMs}ms`);
	st.ticker = setTimeout(() => {
		st.ticker = undefined;
		const run = st.live;
		if (!run) return trace("T stop: no run");
		if (run.finished) return trace("T stop: finished");
		if (!st.liveRunning) return trace("T stop: not running");
		if (!st.lastLiveAt || Date.now() - st.lastLiveAt > 3000) return trace("T stop: stale");
		trace("T fire");
		ui.requestRender();
		tickLive(st, ui);
	}, frameMs);
}

function closeThinking(st: PatchState): void {
	if (!st.thinkingStartAt) return;
	const elapsed = Date.now() - st.thinkingStartAt;
	st.thinkingStartAt = 0;
	if (st.live) st.live.thinkingMs += elapsed;
}

/**
 * Account for one tool call exactly once, from either the assistant message or a
 * rendered component. Both paths converge so counts survive without a UI.
 */
function account(st: PatchState, run: Run, toolCallId: string, toolName: string): void {
	let counted = run.counted;
	if (!counted) {
		counted = new Set<string>();
		run.counted = counted;
	}
	if (!toolCallId || counted.has(toolCallId)) return;
	counted.add(toolCallId);
	countTool(run, toolName);
	if (!run.toolIds.includes(toolCallId)) run.toolIds.push(toolCallId);
	run.lastToolId = toolCallId;
	st.runs.set(toolCallId, run);
}

function runOf(st: PatchState, component: any): Run | null {
	const id = component.toolCallId;
	// Ids reach `st.runs` from the transcript (message_end / session replay). A
	// component whose id is unknown comes from something the transcript never
	// announced — a subagent's nested call, for example — and must not be counted.
	const announced = st.announced.has(id);
	let run = st.runs.get(id);
	if (!run) {
		if (!st.live) return null;
		run = st.live;
		st.runs.set(id, run);
		// Attach once: repeated renders must not grow the call list.
		if (!run.toolIds.includes(id)) run.toolIds.push(id);
		run.lastSeenId = id;
	}
	let progress = run.progress;
	if (!progress) {
		progress = new Map();
		run.progress = progress;
	}
	const state = progress.get(id) ?? { started: false, done: false };
	if (component.executionStarted) state.started = true;
	if (!stillRunning(component)) state.done = true;
	progress.set(id, state);
	if (announced && (state.started || state.done)) account(st, run, id, String(component.toolName ?? "tool"));
	return run;
}

/** The newest call of the run that is still executing: it owns the activity row. */
function runningToolId(run: Run | null | undefined): string | undefined {
	const progress = run?.progress;
	if (!progress) return undefined;
	for (let index = run.toolIds.length - 1; index >= 0; index--) {
		const id = run.toolIds[index];
		const state = progress.get(id);
		if (state?.started && !state.done) return id;
	}
	return undefined;
}

/** The summary belongs to the newest announced call; without one, to the last seen. */
function summaryOwner(run: Run): string | undefined {
	return run.lastToolId ?? run.lastSeenId;
}

/**
 * Whether a call can already draw a meaningful row. Pi creates the component
 * while the model is still streaming the call's arguments — the command text
 * would grow chunk by chunk, and the row would flash empty first — so the line
 * is handed over only once the call is announced (its arguments are complete)
 * or it actually runs. A component pi recreates on navigation is announced even
 * when it never saw execution start, so it still owns the line.
 */
function rowReady(st: PatchState, component: any): boolean {
	if (component.argsComplete === true || component.executionStarted === true) return true;
	if (component.result != null) return true;
	return st.announced.has(String(component.toolCallId));
}

/** The newest call the transcript already has a component for and can draw. */
function newestReadyId(st: PatchState, run: Run): string | undefined {
	const progress = run.progress;
	if (!progress) return undefined;
	for (let index = run.toolIds.length - 1; index >= 0; index--) {
		const id = run.toolIds[index];
		const state = progress.get(id);
		if (!state) continue;
		if (st.announced.has(String(id)) || state.started || state.done) return id;
	}
	return undefined;
}

/**
 * The call that holds the row: the executing one, else the newest call that can
 * already be drawn. A call whose arguments are still streaming does not take
 * the line over yet, so the finished row stays put instead of flashing an empty
 * `Running… · 0s` and then growing its command text.
 */
function slotOwner(st: PatchState, run: Run): string | undefined {
	return runningToolId(run) ?? newestReadyId(st, run);
}

/**
 * The newest drawable tool row after this one in the transcript, if any. Pi
 * appends components in order and a successor renders after this row in the
 * same frame, so the two must never reserve a slot each. A successor whose row
 * is not ready yet does not count: the current row keeps the slot.
 */
function successorRow(st: PatchState, component: any): any {
	const children = component[PARENT]?.children;
	if (!Array.isArray(children)) return undefined;
	const own = children.lastIndexOf(component);
	for (let index = children.length - 1; index > own; index--) {
		const sibling = children[index];
		if (!(sibling instanceof ToolExecutionComponent) || (sibling as any).hideComponent) continue;
		if (rowReady(st, sibling)) return sibling;
	}
	return undefined;
}

/** Fill a live row up to the slot height, so a short row leaves the same gap. */
function inSlot(st: PatchState, lines: string[]): string[] {
	const height = Math.max(LIVE_SLOT_LINES, st.slotLines ?? 0);
	const padded = lines.slice();
	while (padded.length < height) padded.push("");
	// A tall row — a codemode call with its nested calls — raises the slot for the
	// rest of the run: the next call takes the line over without moving what sits
	// below the activity area.
	if (padded.length > height) st.slotLines = padded.length;
	return padded;
}

/** The blank slot a hidden row still holds, so the screen does not jump. */
function blankSlot(st: PatchState): string[] {
	return new Array<string>(Math.max(LIVE_SLOT_LINES, st.slotLines ?? 0)).fill("");
}

/**
 * The single row of a running run. A finished call keeps it with a check, so
 * the line is never blank while the model thinks; the next call replaces it.
 */
function liveRow(st: PatchState, component: any, width: number): string[] {
	const style = styler(st);
	const { verb, detail, title, command, commandPrefix } = describeTool(component);
	const label = title ?? (detail ? `${verb} ${detail}` : `${verb}…`);
	const now = Date.now();
	const seconds = elapsedSeconds(st, component);
	const running = stillRunning(component);
	// The row is on screen, so the call is in flight even if `executionStarted`
	// never reached this component instance.
	st.lastLiveAt = now;
	st.liveRunning = running;
	if (running) tickLive(st, component.ui);
	if (st.__ccSeconds !== seconds) {
		st.__ccSeconds = seconds;
		trace(`L id=${component.toolCallId} secs=${seconds} res=${component.result ? 1 : 0}`);
	}
	// A failed call must not read as a success: the check flips to a cross.
	const failed = component.result?.isError === true;
	// Only a call in flight breathes: a finished row keeps a plain accent dot
	// next to its check or cross, and the summary band its own static marker.
	const dot = running ? pulseMarker(style, now) : style.fg("accent", "●");
	const marker = running ? "" : ` ${style.fg(failed ? "error" : "success", failed ? "✗" : "✓")}`;
	const head = `${dot} ${style.fg("toolTitle", label)}${style.fg("dim", ` · ${duration(seconds)}`)}${marker}`;
	const lines = [`${ROW_PAD}${head}`];
	if (command) lines.push(`${ROW_PAD}  ${style.fg("dim", `└ ${commandPrefix ?? ""}`)}${style.fg("muted", command)}`);
	lines.push(...nestedRows(st, component, style));
	// This row is about to be drawn: a nested call that starts now has somewhere
	// to ask for the frame that shows it.
	st.rowUi = component.ui;
	return ["", ...lines.map((line) => truncateToWidth(line, width, "…"))];
}

/**
 * Marker of the summary band. Deliberately not the tool-row bullet: a call row
 * reports what is happening, the summary reports what happened.
 */
const SUMMARY_MARKER = "○";

/**
 * Full-width rule closing the summary band. The rule owns its line, so it is
 * sized to the render width instead of going through the summary's truncation:
 * one column too many wraps the whole transcript in a narrow terminal.
 */
function summaryRule(style: Styler, width: number): string | null {
	const ruleWidth = width - ROW_PAD.length;
	if (ruleWidth < 1) return null;
	return `${ROW_PAD}${style.fg("border", "─".repeat(ruleWidth))}`;
}

/**
 * The settled run as a band: a gap, the summary line, and a full-width rule.
 * The gap below the band is not drawn here: the answer's own component opens
 * with a blank line, and a second one would leave two empty rows under the rule.
 */
function summaryRow(st: PatchState, run: Run, width: number): string[] {
	const style = styler(st);
	const head = `${ROW_PAD}${style.fg("dim", SUMMARY_MARKER)} ${style.fg("muted", summaryText(run))}`;
	const rule = summaryRule(style, width);
	const band = [truncateToWidth(head, width, "…")];
	if (rule) band.push(rule);
	return ["", ...band];
}

function fallbackRow(component: any, width: number): string[] {
	// A revealed script row names what it runs; every other tool names itself and
	// keeps its most descriptive argument.
	const { title, command } = describeTool(component);
	let text = String(component.toolName);
	if (title) {
		text = command ? `${title} ${command}` : title;
	} else {
		const detail = argumentSummary(component.args);
		if (detail) text = `${text}(${detail})`;
	}
	const row = `● ${text}${component.result?.isError ? " ✗" : ""}`;
	return [truncateToWidth(row, width, "…")];
}

function persisted(run: Run): PersistedSummary {
	// Counts stay out of the entry: they are re-derived from the session messages,
	// so a session recorded by an older version still replays with real numbers.
	return { thinkingMs: run.thinkingMs, workedMs: run.workedMs };
}

/** Rebuild per-run state from the session branch so replays render the same summaries. */
function loadRuns(ctx: ExtensionContext, st: PatchState): void {
	st.runs = new Map();
	let entries: any[] = [];
	try {
		entries = ctx.sessionManager.getBranch() as any[];
	} catch {
		return;
	}
	const seen = new Set<Run>();
	let current: Run | null = null;
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role === "user") {
			current = newRun();
			seen.add(current);
			continue;
		}
		if (entry?.type === "custom" && entry.customType === SUMMARY_ENTRY && entry.data) {
			if (!current) {
				current = newRun();
				seen.add(current);
			}
			const data = entry.data as PersistedSummary;
			if (typeof data.thinkingMs === "number") current.thinkingMs = data.thinkingMs;
			if (typeof data.workedMs === "number") current.workedMs = data.workedMs;
			continue;
		}
		if (message?.role !== "assistant") continue;
		if (!current) {
			current = newRun();
			seen.add(current);
		}
		if (typeof message.durationMs === "number") current.workedMs += message.durationMs;
		for (const block of message.content ?? []) {
			if (block?.type !== "toolCall" || !block.id) continue;
			current.counted ??= new Set();
			if (current.counted.has(block.id)) continue;
			current.counted.add(block.id);
			st.announced.add(String(block.id));
			countTool(current, String(block.name));
			current.toolIds.push(block.id);
			current.lastToolId = block.id;
			st.runs.set(block.id, current);
		}
	}
	for (const run of seen) run.finished = true;
}

/** A previous load of this file — or an older copy of it — may still wrap the prototype. */
function findPatchState(proto: any): PatchState | null {
	const direct = proto[PATCH];
	if (direct?.patched) return direct as PatchState;
	for (const key of Object.getOwnPropertySymbols(proto)) {
		const value = proto[key];
		if (value && typeof value === "object" && value.patched === true) return value as PatchState;
	}
	return null;
}

/** Make leftover wrappers from older copies pass through to the host renderer. */
function disableStaleWrappers(proto: any, keep: PatchState | null): void {
	for (const key of Object.getOwnPropertySymbols(proto)) {
		const value = proto[key];
		if (!value || typeof value !== "object" || value === keep) continue;
		if (typeof value.enabled === "boolean" && value.patched !== true) value.enabled = false;
	}
}

type ParentTrackingState = {
	loadToken?: symbol;
	/** Untouched `addChild`, recorded so a reload can replace the stale closure. */
	originalAddChild?: (this: unknown, child: unknown) => unknown;
};

/**
 * Remember the container a tool component was added to. Pi appends transcript
 * components in order, so this is what lets a row know a newer one already
 * exists — without it a replaced row and its successor both hold the slot for
 * one frame, which is exactly the jump the slot is meant to prevent.
 */
function installParentTracking(): void {
	const containerProto = Object.getPrototypeOf(ToolExecutionComponent.prototype) as any;
	const previous = containerProto[PARENT_TRACKING] as ParentTrackingState | undefined;
	if (previous?.loadToken === LOAD_TOKEN) return;
	const originalAddChild = previous?.originalAddChild ?? containerProto.addChild;
	if (typeof originalAddChild !== "function") return;
	containerProto.addChild = function (child: any) {
		try {
			if (child instanceof ToolExecutionComponent) (child as any)[PARENT] = this;
		} catch {
			// Best effort: a row without a parent still renders, it just reserves.
		}
		return originalAddChild.call(this, child);
	};
	containerProto[PARENT_TRACKING] = { loadToken: LOAD_TOKEN, originalAddChild };
}

function installPatch(): PatchState {
	const proto = ToolExecutionComponent.prototype as any;
	const previous = findPatchState(proto);
	if (previous && previous.loadToken === LOAD_TOKEN) {
		// The same module instance installing twice: nothing to rewrap.
		proto[PATCH] = previous;
		return previous;
	}

	let st: PatchState;
	let originalRender = proto.render;
	let originalMouse = proto.handleMouse;
	if (previous?.originalRender && previous.originalMouse) {
		// /reload: keep the counters but swap the stale closures for this load's code.
		st = previous;
		originalRender = previous.originalRender;
		originalMouse = previous.originalMouse;
		proto.render = originalRender;
		proto.handleMouse = originalMouse;
	} else {
		// An older copy that never recorded the host methods: disabling its wrapper
		// makes it delegate to the host, so wrapping it stays transparent.
		if (previous) previous.enabled = false;
		st = {
			patched: true,
			enabled: true,
			revealAll: false,
			live: null,
			runs: new Map(),
			announced: new Set(),
			toolStartAt: new Map(),
			shownSeconds: new Map(),
			thinkingStartAt: 0,
		};
	}
	disableStaleWrappers(proto, previous);
	st.runs ??= new Map();
	st.announced ??= new Set();
	st.toolStartAt ??= new Map();
	st.shownSeconds ??= new Map();
	st.thinkingStartAt ??= 0;
	st.enabled ??= true;
	st.revealAll ??= false;
	Object.assign(st, loadSettings());
	st.live ??= null;
	st.version = PATCH_VERSION;
	st.loadToken = LOAD_TOKEN;
	st.originalRender = originalRender;
	st.originalMouse = originalMouse;

	proto.render = function (width: number): string[] {
		if (!st.enabled || this.expanded) return originalRender.call(this, width);
		if (this.hideComponent || width < 1) return [];
		// Revealed runs keep one compact row per call, like a plain activity log.
		if (st.revealAll) return fallbackRow(this, width);
		const run = runOf(st, this);
		const owner = run && !run.finished ? slotOwner(st, run) : undefined;
		const id = String(this.toolCallId);
		const settled = st.settled?.has(id) === true;
		let decision = "no-run";
		if (run?.finished) decision = this.toolCallId === summaryOwner(run) ? "summary" : "hidden";
		else if (run) decision = settled ? "settled" : this.toolCallId === owner ? "live" : "hidden";
		const key = `${decision}|${this.result ? 1 : 0}|${this.executionStarted ? 1 : 0}|${run?.finished ? 1 : 0}`;
		if (this.__ccDecision !== key) {
			this.__ccDecision = key;
			if (process.env.PI_CC_TOOLS_DEBUG) {
				const successor = successorRow(st, this) ? "next" : "own";
				trace(`R id=${this.toolCallId} name=${this.toolName} ${decision} res=${this.result ? 1 : 0} exec=${this.executionStarted ? 1 : 0} fin=${run?.finished ? 1 : 0} owner=${owner} slot=${successor} ui=${typeof this.ui?.requestRender}`);
			}
		}
		if (!run) return fallbackRow(this, width);
		if (run.finished) return this.toolCallId === summaryOwner(run) ? summaryRow(st, run, width) : [];
		if (this.toolCallId !== slotOwner(st, run)) return [];
		// A settled row stays collapsed even when a retry reopens the run: it keeps
		// the slot blank instead of dropping it, so nothing below moves.
		if (settled) return successorRow(st, this) ? [] : blankSlot(st);
		// A finished call's row yields the moment a newer row exists: the next
		// call replaces it at once instead of drawing beside it for a frame.
		if (!stillRunning(this) && successorRow(st, this)) return [];
		return inSlot(st, liveRow(st, this, width));
	};

	proto.handleMouse = function (event: any): any {
		if (st.enabled && !this.expanded && event.type === "click" && event.button === "left") {
			const run = runOf(st, this);
			if (run?.finished && this.toolCallId === summaryOwner(run)) {
				st.revealAll = !st.revealAll;
				this.ui?.requestRender?.();
				return { handled: true };
			}
		}
		return originalMouse.call(this, event);
	};

	proto[PATCH] = st;
	return st;
}

/**
 * Hidden thinking renders as a placeholder line plus a spacer. The run summary
 * already carries the thinking time, so drop those lines and the blank edges
 * they leave behind.
 */
type ThinkingFilterState = {
	version: number;
	loadToken?: symbol;
	/** The method this filter wraps, recorded so a reload can replace the closure. */
	originalRender?: (this: unknown, width: number) => string[];
};

function installThinkingFilter(): void {
	const proto = AssistantMessageComponent.prototype as any;
	const previous = proto[THINKING_FILTER] as ThinkingFilterState | undefined;
	if (previous?.loadToken === LOAD_TOKEN) return;
	const originalRender = previous?.originalRender ?? proto.render;
	proto.render = function (width: number): string[] {
		const lines: string[] = originalRender.call(this, width);
		// Read the flag at render time: a reload may install a new patch state.
		const state = (ToolExecutionComponent.prototype as any)[PATCH] as PatchState | undefined;
		if (state?.enabled === false) return lines;
		const label = String(this.hiddenThinkingLabel ?? "").trim();
		const kept: string[] = [];
		for (const line of lines) {
			if (label && plain(line).trim() === label) continue;
			// pi spaces out its own content; a removed placeholder can leave doubles.
			if (!plain(line).trim() && kept.length > 0 && !plain(kept[kept.length - 1]).trim()) continue;
			kept.push(line);
		}
		// Keep the leading gap (it separates the answer from what precedes it),
		// drop trailing blanks, and render nothing at all when only thinking was left.
		while (kept.length > 0 && !plain(kept[kept.length - 1]).trim()) kept.pop();
		if (!kept.some((line) => plain(line).trim())) return [];
		return kept;
	};
	proto[THINKING_FILTER] = { version: PATCH_VERSION, loadToken: LOAD_TOKEN, originalRender };
}

/**
 * The `/cc-tools` menu: the settings list pi uses for its own /settings, with
 * this extension's two switches on it. Changes apply at once and are written to
 * the settings file by `persist`.
 */
async function showSettingsMenu(ctx: ExtensionContext, state: PatchState, persist: () => void): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/cc-tools menu needs TUI mode; use /cc-tools on|off|toggle|reveal|hide", "error");
		return;
	}
	const items: SettingItem[] = [
		{
			id: "enabled",
			label: "Claude Code style rows",
			description: "Collapse tool calls into one live line and a summary",
			currentValue: state.enabled ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "rows",
			label: "Tool rows",
			description: "live line: only the newest row; all rows: show every tool row",
			currentValue: state.revealAll ? "all rows" : "live line",
			values: ["live line", "all rows"],
		},
	];
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("cc-tools settings"))));
		container.addChild(new Text(""));
		const list = new SettingsList(
			items,
			items.length + 2,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "enabled") state.enabled = value === "on";
				else if (id === "rows") state.revealAll = value === "all rows";
				persist();
				tui.requestRender();
			},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	const st = installPatch();
	installParentTracking();
	installThinkingFilter();

	st.live = null;
	st.toolStartAt.clear();
	st.thinkingStartAt = 0;
	stopTicker(st);

	// Every handler body is guarded: a throwing lifecycle hook would otherwise
	// leave the rows permanently hidden with no summary.
	const on = (name: any, handler: any) =>
		pi.on(name, (event: any, ctx: any) => {
			try {
				return handler(event, ctx);
			} catch {
				return undefined;
			}
		});

	on("session_start", (_event: any, ctx: any) => {
		st.ui = ctx.ui;
		st.live = null;
		st.announced = new Set();
		st.toolStartAt.clear();
		st.settled = new Set();
		st.thinkingStartAt = 0;
		st.nested = new Map();
		st.slotLines = LIVE_SLOT_LINES;
		stopTicker(st);
		loadRuns(ctx, st);
		// The placeholder text is filtered out of the transcript; keeping a stable
		// label is what lets the filter recognise those lines.
		ctx.ui.setHiddenThinkingLabel?.("Thinking…");
	});

	on("agent_start", () => {
		// A retry, recovery, or compaction continuation reopens the settled run so
		// the summary keeps following its newest tool instead of duplicating.
		if (st.live?.finished) st.live.finished = false;
	});

	on("before_agent_start", (event: any) => {
		const messageType = event?.messageType ?? "user";
		// Notifications and queued notes (subagent completion, injected context)
		// are delivered as custom messages that start their own run. They belong
		// to the turn the user already started, so keep its counters and timers
		// instead of reporting only the tail of the work.
		if (messageType !== "user" && st.live) {
			trace("E before_agent_start (continuing turn)");
			closeThinking(st);
			// The tool that is running keeps running: leave its timer alone.
			st.live.finished = false;
			return;
		}
		trace(`E before_agent_start (${messageType})`);
		closeThinking(st);
		stopTicker(st);
		// A queued prompt can start while the previous run is still open; close it
		// so its rows collapse behind their own summary.
		if (st.live && !st.live.finished) {
			st.live.finished = true;
			st.live.workedMs = Date.now() - st.live.startedAt;
		}
		st.live = newRun();
		st.slotLines = LIVE_SLOT_LINES;
	});

	on("message_update", (event: any) => {
		const kind = event?.assistantMessageEvent?.type;
		if (kind === "thinking_start" || (kind === "thinking_delta" && !st.thinkingStartAt)) {
			st.thinkingStartAt = Date.now();
		} else if (kind === "thinking_end") {
			closeThinking(st);
		}
	});

	on("message_end", (event: any) => {
		closeThinking(st);
		const message = event?.message;
		if (message?.role !== "assistant") return;
		if (!st.live) st.live = newRun();
		for (const block of message.content ?? []) {
			if (block?.type !== "toolCall") continue;
			const id = String(block.id ?? "");
			if (id) st.announced.add(id);
			account(st, st.live, id, String(block.name ?? "tool"));
		}
	});
	on("turn_end", () => closeThinking(st));

	// Nested calls — a codemode script's tool and MCP calls — never reach the
	// transcript as rows of their own: they carry their caller's id and are drawn
	// underneath its row. They are deliberately kept out of `st.runs` and the
	// run's counters, so the summary still reports one `codemode` call.
	on("tool_execution_start", (event: any, ctx: any) => {
		const parentId = event?.parentToolCallId;
		if (!parentId) return;
		startNested(st, String(parentId), event, typeof ctx?.cwd === "string" ? ctx.cwd : undefined);
	});

	on("tool_execution_end", (event: any) => {
		const parentId = event?.parentToolCallId;
		if (parentId) {
			endNested(st, String(parentId), event);
			return;
		}
		// The parent finished: anything it left running was aborted with it.
		const id = String(event?.toolCallId ?? "");
		if (id) cancelNested(st, id);
	});

	const settle = (): void => {
		closeThinking(st);
		stopTicker(st);
		const run = st.live;
		if (!run || run.finished) return;
		// A settled call must not come back as an activity row when the run is
		// reopened (retry, compaction continuation).
		if (!st.settled) st.settled = new Set();
		for (const id of run.toolIds) {
			st.settled.add(id);
			// Nothing draws a settled run's nested calls any more: its row collapses
			// into the summary band, so they would only linger.
			st.nested?.delete(id);
		}
		st.slotLines = LIVE_SLOT_LINES;
		run.finished = true;
		run.workedMs = Date.now() - run.startedAt;
		trace(`E settle worked=${run.workedMs} tools=${run.toolIds.length} counts=${JSON.stringify(run.counts)}`);
	};

	on("agent_before_settle", () => {
		const run = st.live;
		const wasOpen = run !== null && !run.finished;
		settle();
		if (!wasOpen || !run) return undefined;
		return { entries: [{ type: "custom", customType: SUMMARY_ENTRY, data: persisted(run) }] };
	});

	on("agent_settled", () => {
		const run = st.live;
		const wasOpen = run !== null && !run.finished;
		settle();
		// Aborted or otherwise unsettled runs still get their summary on replay.
		if (wasOpen && run) pi.appendEntry(SUMMARY_ENTRY, persisted(run));
	});

	on("session_shutdown", () => {
		stopTicker(st);
		st.live = null;
		st.runs = new Map();
		st.announced = new Set();
		st.toolStartAt.clear();
		st.shownSeconds = new Map();
		st.settled = new Set();
		st.thinkingStartAt = 0;
		st.nested = new Map();
		st.slotLines = LIVE_SLOT_LINES;
	});

	// Every way of changing the state ends here: nothing animates while the
	// renderer is off or every row is revealed, so the pulse timer must stop
	// asking for frames, and the change is written out for the next session.
	const applyState = (): void => {
		if (!st.enabled || st.revealAll) stopTicker(st);
		saveSettings({ enabled: st.enabled, revealAll: st.revealAll });
	};

	pi.registerCommand("cc-tools", {
		description: "Claude-Code-style tool rows settings (Ctrl+O expands)",
		async handler(args: string, ctx: ExtensionContext) {
			const option = args.trim().toLowerCase();
			const allowed = ["on", "off", "toggle", "reveal", "hide"];
			if (!option) {
				await showSettingsMenu(ctx, st, applyState);
				return;
			}
			if (!allowed.includes(option)) {
				ctx.ui.notify("Usage: /cc-tools [on|off|toggle|reveal|hide]", "error");
				return;
			}
			if (option === "reveal") st.revealAll = true;
			else if (option === "hide") st.revealAll = false;
			else if (option === "on") st.enabled = true;
			else if (option === "off") st.enabled = false;
			else st.enabled = !st.enabled;
			applyState();
			let status = "off";
			if (st.enabled) status = st.revealAll ? "on · all rows" : "on · live line";
			ctx.ui.notify(`cc-tools: ${status}`, "info");
		},
	});
}

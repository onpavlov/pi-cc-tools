/**
 * Claude-Code-style tool output, display-only.
 *
 * While a run is going, every tool row except the newest one is hidden, so the
 * transcript shows a single line: what pi is doing right now plus its command.
 * When the run settles, all tool rows collapse into one summary line
 * ("Thought for 4s, searched for 1 pattern, ran 3 shell commands") that sits
 * right above the final answer. Ctrl+O (or a click on the summary) reveals the
 * rows again; `/cc-tools on|off|toggle|reveal|hide` controls the renderer.
 *
 * Nothing here touches model messages or the session transcript semantics; the
 * only persisted data is a `cc-tools-summary` custom entry used to render the
 * same summary when the session is replayed.
 */
import { appendFileSync } from "node:fs";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("cc-tools:patch:v1");
const THINKING_FILTER = Symbol.for("cc-tools:thinking-filter:v1");
/** Bumped when the patch layout changes, so a reload can migrate older state. */
const PATCH_VERSION = 2;
/** New object on every module evaluation: tells a reload from a repeated install. */
const LOAD_TOKEN = Symbol("cc-tools-load");
const SUMMARY_ENTRY = "cc-tools-summary";

// Built from a string so the source carries no literal control characters.
const ANSI = new RegExp("\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "g");
/** Left inset of the activity and summary rows, matching the answer text column. */
const ROW_PAD = " ";
/**
 * Minimum time a live row stays on screen. A call that ends sooner than this
 * keeps its row for the rest of the window instead of blinking out, so a fast
 * tool is still readable; a call that replaced it hides it at once.
 */
const LIVE_DWELL_MS = 900;

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
	/** toolCallId -> when its live row first appeared: the start of its dwell window. */
	liveShownAt?: Map<string, number>;
	/** Calls whose row already collapsed at settle: never shown as live again. */
	settled?: Set<string>;
	/** One-shot timer that repaints when a finished call's held row is due to collapse. */
	dwell?: ReturnType<typeof setTimeout>;
	/** Last time a live row was actually drawn, and whether it was still running. */
	lastLiveAt?: number;
	liveRunning?: boolean;
	/** Last elapsed value written to the debug trace, so it logs per second, not per repaint. */
	__ccSeconds?: number;
};

type Styler = {
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

function quoted(pattern: unknown, where?: string): string {
	const text = typeof pattern === "string" ? `"${pattern}"` : "";
	const location = where ? ` in ${relativePath(where, undefined)}` : "";
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

function describeTool(component: any): { verb: string; detail: string; command?: string } {
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const cwd = typeof component.cwd === "string" ? component.cwd : undefined;
	switch (name) {
		case "bash": {
			const command = oneLine(String(args.command ?? ""));
			return { verb: "Running", detail: programOf(command), command };
		}
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

function stopDwell(st: PatchState): void {
	if (st.dwell === undefined) return;
	clearTimeout(st.dwell);
	st.dwell = undefined;
}

/** Ask for one repaint when the held row is due to collapse; that render drops it. */
function armDwell(st: PatchState, ui: any, remainingMs: number): void {
	stopDwell(st);
	if (typeof ui?.requestRender !== "function") return;
	const timer = setTimeout(() => {
		st.dwell = undefined;
		trace("D fire");
		ui.requestRender();
	}, remainingMs);
	// A pending hold must never keep the process alive on its own.
	timer.unref?.();
	st.dwell = timer;
}

/**
 * Pi repaints the transcript only when something changes, so a tool that runs
 * without emitting output would freeze its elapsed seconds. Re-request a render
 * once a second for as long as a call of the live run is still executing.
 */
function tickLive(st: PatchState, ui: any): void {
	if (st.ticker !== undefined || typeof ui?.requestRender !== "function") {
		if (st.ticker === undefined) trace(`T arm-skipped ui=${typeof ui?.requestRender}`);
		return;
	}
	trace("T arm");
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
	}, 1000);
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

/**
 * The row to draw for this run. Chosen by tool-call id and execution state, not
 * by object identity: pi recreates components on tree navigation, compaction,
 * and resume, and a remembered instance would hide every row.
 */
function liveToolId(run: Run | null | undefined): string | undefined {
	if (!run) return undefined;
	const progress = run.progress;
	if (progress) {
		for (let index = run.toolIds.length - 1; index >= 0; index--) {
			const id = run.toolIds[index];
			const state = progress.get(id);
			if (state?.started && !state.done) return id;
		}
	}
	return summaryOwner(run);
}

/** The summary belongs to the newest announced call; without one, to the last seen. */
function summaryOwner(run: Run): string | undefined {
	return run.lastToolId ?? run.lastSeenId;
}

function liveRow(st: PatchState, component: any, width: number): string[] {
	const style = styler(st);
	const { verb, detail, command } = describeTool(component);
	const label = detail ? `${verb} ${detail}` : `${verb}…`;
	const seconds = elapsedSeconds(st, component);
	// The row is on screen and has no result yet, so the call is in flight even
	// if `executionStarted` never reached this component instance.
	st.lastLiveAt = Date.now();
	st.liveRunning = stillRunning(component);
	if (st.liveRunning) tickLive(st, component.ui);
	if (st.__ccSeconds !== seconds) {
		st.__ccSeconds = seconds;
		trace(`L id=${component.toolCallId} secs=${seconds} res=${component.result ? 1 : 0}`);
	}
	const head = `${style.fg("accent", "●")} ${style.fg("toolTitle", label)}${style.fg("dim", ` · ${duration(seconds)}`)}`;
	const lines = [`${ROW_PAD}${head}`];
	if (command) lines.push(`${ROW_PAD}  ${style.fg("dim", "└ $ ")}${style.fg("muted", command)}`);
	return ["", ...lines.map((line) => truncateToWidth(line, width, "…"))];
}

/**
 * The row for the newest call: while it runs, and for the remainder of its
 * dwell window right after it finishes. The window opens when the row is first
 * drawn, so a call already on screen for longer than the dwell disappears at
 * once. A call that settled once is never shown again, even if the run is
 * reopened by `agent_start`.
 */
function liveRows(st: PatchState, component: any, width: number): string[] {
	const id = String(component.toolCallId);
	const now = Date.now();
	if (st.settled?.has(id)) return [];
	if (!st.liveShownAt) st.liveShownAt = new Map();
	if (stillRunning(component)) {
		stopDwell(st);
		if (!st.liveShownAt.has(id)) st.liveShownAt.set(id, now);
		return liveRow(st, component, width);
	}
	const shownAt = st.liveShownAt.get(id) ?? now;
	st.liveShownAt.set(id, shownAt);
	const remaining = shownAt + LIVE_DWELL_MS - now;
	if (remaining <= 0) return [];
	armDwell(st, component.ui, remaining);
	return liveRow(st, component, width);
}

function summaryRow(st: PatchState, run: Run, width: number): string[] {
	const line = truncateToWidth(`${ROW_PAD}${styler(st).fg("muted", summaryText(run))}`, width, "…");
	return ["", line];
}

function fallbackRow(component: any, width: number): string[] {
	const detail = argumentSummary(component.args);
	const row = `● ${component.toolName}${detail ? `(${detail})` : ""}${component.result?.isError ? " ✗" : ""}`;
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
		let decision = "no-run";
		if (run) {
			if (!run.finished) decision = this.toolCallId === liveToolId(run) ? "live" : "hidden";
			else decision = this.toolCallId === summaryOwner(run) ? "summary" : "hidden";
		}
		const key = `${decision}|${this.result ? 1 : 0}|${this.executionStarted ? 1 : 0}|${run?.finished ? 1 : 0}`;
		if (this.__ccDecision !== key) {
			this.__ccDecision = key;
			if (process.env.PI_CC_TOOLS_DEBUG) {
				trace(`R id=${this.toolCallId} name=${this.toolName} ${decision} res=${this.result ? 1 : 0} exec=${this.executionStarted ? 1 : 0} fin=${run?.finished ? 1 : 0} live=${liveToolId(run)} ui=${typeof this.ui?.requestRender}`);
			}
		}
		if (!run) return fallbackRow(this, width);
		if (run.finished) return this.toolCallId === summaryOwner(run) ? summaryRow(st, run, width) : [];
		if (this.toolCallId !== liveToolId(run)) return [];
		// A finished call must not keep claiming to run while the model thinks:
		// its held row collapses once the dwell window is over.
		return liveRows(st, this, width);
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

export default function (pi: ExtensionAPI) {
	const st = installPatch();
	installThinkingFilter();

	st.live = null;
	st.toolStartAt.clear();
	st.thinkingStartAt = 0;
	stopTicker(st);
	stopDwell(st);

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
		st.liveShownAt = new Map();
		st.settled = new Set();
		st.thinkingStartAt = 0;
		stopTicker(st);
		stopDwell(st);
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
		stopDwell(st);
		st.liveShownAt = new Map();
		// A queued prompt can start while the previous run is still open; close it
		// so its rows collapse behind their own summary.
		if (st.live && !st.live.finished) {
			st.live.finished = true;
			st.live.workedMs = Date.now() - st.live.startedAt;
		}
		st.live = newRun();
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

	const settle = (): void => {
		closeThinking(st);
		stopTicker(st);
		stopDwell(st);
		const run = st.live;
		if (!run || run.finished) return;
		// A settled call must not come back as an activity row when the run is
		// reopened (retry, compaction continuation).
		if (!st.settled) st.settled = new Set();
		for (const id of run.toolIds) st.settled.add(id);
		st.liveShownAt = new Map();
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
		stopDwell(st);
		st.live = null;
		st.runs = new Map();
		st.announced = new Set();
		st.toolStartAt.clear();
		st.shownSeconds = new Map();
		st.liveShownAt = new Map();
		st.settled = new Set();
		st.thinkingStartAt = 0;
	});

	pi.registerCommand("cc-tools", {
		description: "Claude-Code-style tool rows: on/off/toggle/reveal/hide (Ctrl+O expands)",
		async handler(args, ctx) {
			const option = args.trim().toLowerCase();
			const allowed = ["on", "off", "toggle", "reveal", "hide"];
			if (option && !allowed.includes(option)) {
				ctx.ui.notify("Usage: /cc-tools on|off|toggle|reveal|hide", "error");
				return;
			}
			if (option === "reveal") st.revealAll = true;
			else if (option === "hide") st.revealAll = false;
			else if (option === "on") st.enabled = true;
			else if (option === "off") st.enabled = false;
			else st.enabled = !st.enabled;
			let status = "off";
			if (st.enabled) status = st.revealAll ? "on · all rows" : "on · live line";
			ctx.ui.notify(`cc-tools: ${status}`, "info");
		},
	});
}

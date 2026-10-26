/**
 * Shared setup for the cc-tools renderer tests.
 *
 * Every test file runs in its own process: the extension patches
 * `ToolExecutionComponent.prototype`, so a shared process would leak patch
 * state (and timing state) between files. `run.mjs` starts them one by one.
 *
 * The tests never touch a terminal, a model, or a real session: they import the
 * extension through jiti exactly like pi does, drive lifecycle events through a
 * stub ExtensionAPI, and render components through the same container pi uses.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TESTS_DIR = here;
/** CC_TOOLS_EXTENSION lets the mutation checks run a modified copy. */
export const EXTENSION_PATH = process.env.CC_TOOLS_EXTENSION ?? join(here, "..", "extensions", "cc-tools", "index.ts");

function resolvePiRoot() {
	const candidates = [];
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
		candidates.push(join(globalRoot, "@earendil-works/pi-coding-agent"));
	} catch {
		// npm may be missing; the well-known locations below still cover it.
	}
	for (const base of [
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
		join(homedir(), ".npm-global", "lib", "node_modules"),
	]) {
		candidates.push(join(base, "@earendil-works/pi-coding-agent"));
	}
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	throw new Error("cannot locate @earendil-works/pi-coding-agent (needed to import the real components)");
}

const root = resolvePiRoot();
const requirePi = createRequire(join(root, "package.json"));
const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")));
export const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
		"@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
	},
});

export const host = await jiti.import("@earendil-works/pi-coding-agent");
export const tui = await jiti.import("@earendil-works/pi-tui");
/** Container is what the transcript uses to hold message/tool components. */
export const BaseContainer = Object.getPrototypeOf(host.ToolExecutionComponent.prototype).constructor;
host.initTheme("dark");
/**
 * The real theme pi installs globally. `host.theme` is a proxy that only the
 * agent's own module sees, so read the instance off the shared global key.
 */
export const THEME = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];

/** Built from a string so this file carries no literal control characters. */
const ANSI = new RegExp("\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "g");
export const strip = (text) => text.replace(ANSI, "");

const STYLE = { fg: (_token, text) => text, bold: (text) => text, italic: (text) => text };

/** Minimal stand-in for the ExtensionContext UI surface the extension touches. */
export function makeUi(overrides = {}) {
	return {
		theme: STYLE,
		requestRender() {},
		setHiddenThinkingLabel() {},
		notify() {},
		...overrides,
	};
}

/** Stub ExtensionAPI that records handlers, commands and appended entries. */
export function createPi() {
	const handlers = new Map();
	const commands = new Map();
	const appended = [];
	const api = {
		registerCommand: (name, definition) => commands.set(name, definition),
		on: (name, handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		appendEntry: (customType, data) => appended.push({ customType, data }),
	};
	const emit = async (name, event = {}, ctx = {}) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const emitOne = async (name, event = {}, ctx = {}) => (await emit(name, event, ctx))[0];
	return { api, handlers, commands, appended, emit, emitOne };
}

export async function loadExtension() {
	const module = await jiti.import(EXTENSION_PATH);
	return module.default;
}

/** Create a tool component the way pi's interactive mode does. */
export function makeTool(ui, options = {}) {
	const cwd = options.cwd ?? homedir();
	return (toolName, toolCallId, args) =>
		new host.ToolExecutionComponent(toolName, toolCallId, args, {}, undefined, ui, cwd);
}

/** Container wrapper with the render helpers every test needs. */
export function tree() {
	const container = new BaseContainer();
	return {
		container,
		add(component) {
			container.addChild(component);
			return component;
		},
		frame(width = 80) {
			return container.render(width).map(strip);
		},
		text(width = 80) {
			return this.frame(width).join("\n");
		},
		/** Rows that carry visible content (padding removed). */
		rows(width = 80) {
			return this.frame(width).filter((line) => line.trim());
		},
	};
}

/** Assistant message component with hidden thinking, as pi builds it. */
export function assistantMessage(message, label = "Thinking…") {
	return new host.AssistantMessageComponent(message, true, host.getMarkdownTheme(), label);
}

/** Tool result payload with output that must never leak into a live row. */
export const HIDDEN_OUTPUT = "OUTPUT_SHOULD_BE_HIDDEN";
/** Wait, so a render can observe a row that stayed on screen. */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function toolResult(overrides = {}) {
	return { content: [{ type: "text", text: HIDDEN_OUTPUT }], isError: false, durationMs: 4200, ...overrides };
}

const tests = [];

/** Declare a test; `runTests` executes them in order and reports. */
export function test(name, fn) {
	tests.push({ name, fn });
}

export async function runTests(fileName) {
	const failures = [];
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`  \u001b[32m✓\u001b[0m ${name}`);
		} catch (error) {
			failures.push({ name, error });
			console.log(`  \u001b[31m✗\u001b[0m ${name}`);
			const message = String(error?.message ?? error).split("\n").slice(0, 6).join("\n    ");
			console.log(`    ${message}`);
		}
	}
	const total = tests.length;
	if (failures.length > 0) {
		console.log(`\n${fileName}: ${failures.length}/${total} failed`);
		process.exitCode = 1;
		return;
	}
	console.log(`\n${fileName}: ${total}/${total} passed`);
}

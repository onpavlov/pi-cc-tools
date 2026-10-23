#!/usr/bin/env node
/**
 * Runs every cc-tools test file in its own process.
 *
 *   node ~/.pi/agent/extensions/tests/run.mjs
 *
 * One process per file is deliberate: the extension patches
 * ToolExecutionComponent.prototype, so module-level state is process-wide.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
	.filter((name) => name.endsWith(".test.mjs"))
	.sort();

if (files.length === 0) {
	console.error("no *.test.mjs files found next to run.mjs");
	process.exit(1);
}

const failed = [];
for (const file of files) {
	const label = file.replace(/\.test\.mjs$/, "");
	console.log(`\n\u001b[1m${label}\u001b[0m`);
	const result = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit" });
	if (result.status !== 0) failed.push(label);
}

console.log("");
if (failed.length > 0) {
	console.log(`\u001b[31m${failed.length}/${files.length} test files failed:\u001b[0m ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`\u001b[32mall ${files.length} test files passed\u001b[0m`);

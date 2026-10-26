# Tests for `extensions/cc-tools/index.ts`

Offline tests for the Claude-Code-style tool renderer. No model, no terminal, no
real session: they import the extension through `jiti` the same way pi does,
drive lifecycle events through a stub `ExtensionAPI`, and render components
through the container pi's transcript uses.

```bash
npm test
```

Exit code is non-zero when anything fails, so it can gate a commit.

## Why one process per file

`install(pi)` patches `ToolExecutionComponent.prototype` and keeps the patch
state on that prototype (`Symbol.for("cc-tools:patch:v1")`). In a single
process every file would inherit the previous file's runs, timers and reveal
state. `run.mjs` therefore spawns each `*.test.mjs` in its own process.

To test a modified copy of the extension (mutation checks):

```bash
CC_TOOLS_EXTENSION=/tmp/variant.ts npm test
```

## Files

| File | Covers |
| --- | --- |
| `live-row.test.mjs` | verb/detail per tool, command line, program extraction, path shortening, one-row rule, a finished row kept with its check/cross until the next call or the summary, hand-over only once the call's arguments are complete, `hideComponent`, expanded fallback, output never leaking into a row, the fixed-height activity slot and its hand-over between calls |
| `summary.test.mjs` | category phrases and their order, singular/plural, `×N` list for other tools, mcp name shortening, thinking threshold, `1m`/`2m 5s` durations, worked-time fallback, the summary band (marker, rule, blank lines), one summary per run, replay counts |
| `layout.test.mjs` | widths 1…200 for live/summary/fallback rows, the rule spanning each width, the one-column band without a rule, zero and negative widths, ellipsis cut, ANSI styling not inflating the measured width |
| `state.test.mjs` | `agent_before_settle` / `agent_settled` persistence, settle idempotency, new prompt vs custom-message runs, `agent_start` reopening, `message_end` counting and dedupe, `session_start`/`session_shutdown` resets, replay of a whole branch |
| `ticker.test.mjs` | the elapsed-seconds timer: arming, advancing, partial results, missing `requestRender`, stopping when the call finishes or the run settles, per-call restart, recorded duration, a finished row staying put without repaints |
| `thinking.test.mjs` | hidden-thinking placeholder removal, blank-line cleanup, thinking-only messages, label-driven matching, behaviour when compact tools are off |
| `commands.test.mjs` | `/cc-tools on\|off\|toggle\|reveal\|hide`, invalid option, click-to-reveal, clicks that belong to the host |
| `reload.test.mjs` | `/reload` semantics: an older copy's wrapper switched off, a repeated install not stacking, a reload swapping closures while keeping counters, the new code rendering immediately, the thinking filter rebuilding, parent tracking rebuilt |
| `robustness.test.mjs` | legacy patch state disabled on load, double install (`/reload`) not double-wrapping, orphan components, missing `toolCallId`, missing theme, throwing lifecycle context, opt-in tracing |

## Adding a test

```js
import { createPi, loadExtension, makeTool, makeUi, test, tree, toolResult, runTests } from "./harness.mjs";

const install = await loadExtension();
const { api, emit } = createPi();
install(api);

const ui = makeUi();
const tool = makeTool(ui, { cwd: "/work/project" });

test("what it must do", async () => {
	const box = tree();
	box.add(tool("bash", "id-1", { command: "ls" })).markExecutionStarted();
	assert.equal(box.rows()[0], " ● Running ls · 0s");
});

await runTests("<file name>");
```

Notes:

- `makeUi({...})` overrides `requestRender`, `notify`, `theme`; the timer tests
  count repaint requests through it.
- Tool ids must be unique within a test run: the extension maps ids to runs.
- A component only joins a run on its first render, so call `box.text()` once
  after adding it when a test depends on the row it just created.
- Prefer `box.rows()` (visible rows) over indexing `frame()`, which includes the
  empty padding row.

## Coverage of known regressions

Each of these was a real bug; the test named in brackets fails if it comes back.

| Regression | Test |
| --- | --- |
| Counters stuck at zero because `tool_execution_start` never arrived | `live-row: a finished call keeps its row until the run settles into its summary` + `ticker: a component that never saw executionStarted still ticks` |
| Frozen `· 0s` on a command that streams output then runs silently | `ticker: a streamed partial result does not stop the timer` |
| Ticker frozen because nobody repaints without pi's spinner | `ticker: the timer asks for a repaint and the elapsed seconds advance` |
| Subagent notifications resetting the turn's counters | `state: a custom message continues the same run…` |
| `TypeError: Cannot read properties of null (reading 'progress')` | `robustness: a component without a toolCallId does not throw` |
| Rows hidden forever after tree navigation/compaction | `live-row: the next call takes the line over from a finished one` |
| Double patching after `/reload` | `robustness: a second install (reload) reuses the patch` |
| `/reload` silently keeping the previous code (stale closures) | `reload: the reloaded module's code answers immediately` |
| Stale live row surviving a session switch | `state: session_shutdown drops the live run` |
| Placeholder `Thinking…` line visible above the answer | `thinking: the placeholder is dropped and the answer is kept` |
| Stale `Running … · 0s` row hanging after a finished/failed call | `live-row: a finished call keeps its row until the run settles into its summary`, `live-row: a failed call keeps its row with a cross instead of a check` |
| The row blinking out between short commands | `live-row: a finished call keeps its row until the run settles into its summary`, `live-row: the next call replaces a finished row without a blank frame` |
| A done row still claiming to run | `live-row: a finished call keeps its row until the run settles into its summary` |
| A finished row still requesting repaints | `ticker: a finished call keeps its row and stops the timer` |
| A failed call marked with a green check | `live-row: the check and the cross use the theme's success and error tokens` |
| A settled call reappearing as an activity row when the run is reopened | `state: agent_start reopens a settled run…` |
| Timer jumping back from `1s` to `0s` mid-call | `ticker: a partial result carrying durationMs 0 does not reset the timer` |
| Summary counting subagent/nested calls (`spawned 10 agents` for 5) | `summary: calls the transcript never announced are not counted` |
| `Running (Macintosh;` for `UA="Mozilla/5.0 (Macintosh; …" cmd` | `live-row: the program name skips env assignments…` |
| Output jumping while tools come and go at the transcript end | `live-row: the reserved slot keeps the frame height steady…`, `live-row: a short live row still fills the slot` |
| Two rows holding the activity slot at once when a call is replaced | `live-row: only one call reserves the slot at a time`, `live-row: an announced call without a component does not drop the slot` |
| The slot vanishing while the model streams the next call's arguments | `live-row: a call whose component appears before it is announced keeps the slot` |
| Empty `Running… · 0s` flashing, then the command growing chunk by chunk while arguments stream | `live-row: the first call draws nothing while its arguments are still streaming`, `live-row: a call whose component appears before it is announced keeps the slot` |
| The reserved slot surviving into the settled summary | `live-row: the reservation is dropped when the run settles` |
| Parent tracking wrapped twice after `/reload` | `reload: a reload rebuilds parent tracking without stacking` |

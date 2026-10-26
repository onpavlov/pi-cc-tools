# pi-cc-tools

Claude Code-style tool output for [Pi](https://github.com/earendil-works/pi). While a tool runs,
the transcript shows a single line with what is happening right now and how long it has been
running. When the turn settles, every tool row collapses into one summary line above the answer.

```text
 ● Running npm · 4s
   └ $ npm view hunk version 2>&1 | head -5

 Thought for 11s, searched for 2 patterns, read 3 files, ran 5 shell commands, spawned 2 agents
```

Display only: model messages, tool results and the session transcript are never touched.

## Install

```bash
pi install git:github.com/onpavlov/pi-cc-tools
```

Other sources:

```bash
pi install npm:pi-cc-tools          # once published
pi install ./pi-cc-tools            # local checkout
pi -e ./pi-cc-tools/extensions/cc-tools/index.ts   # try it for one run
```

## What it draws

**While a call runs** — one line, replaced as the next call starts:

```text
 ● Reading src/config.ts · 0s
 ● Searching "getUserById" in src · 2s
 ● Running npm · 12s
   └ $ npm test -- --watch=false
 ● Updating the todo list · 0s
 ● web_search cats · 1s
```

Only the newest still-executing call is shown. A call that ends sooner than the dwell window keeps
its line for the rest of that window (under a second), so a fast command is readable instead of
flashing past; the next call replaces the line at once, without waiting the window out. After that
the rows stay hidden until the turn settles, so the model's thinking never sits under a stale
"Running" line.

The activity area holds a fixed three-line slot for as long as the run is open: the gap above the
row, the row itself, and its command line. A row that goes away — a call that finished, a pause
between calls — leaves the slot blank instead of shrinking it, so nothing below (the streaming
answer included) jumps while tools come and go. The reservation is dropped when the turn settles:
the summary needs only its own gap.

**When the turn settles** — the run's summary, placed on its last call:

```text
 Thought for 15s, read 3 files, edited 1 file, ran 27 shell commands, used 6 todos, spawned 5 agents
```

Phrases appear in a fixed order: thinking, search, read, edit, shell, agents, other tools.
Durations switch to minutes (`Thought for 2m 5s`), and `Worked for Ns` is used when a run has
nothing counted.

## Controls

| Action | Effect |
| --- | --- |
| `/cc-tools on` · `off` · `toggle` | Enable or disable the renderer |
| `/cc-tools reveal` · `hide` | Show every call as a compact one-liner, or collapse again |
| Click the summary row | Toggle the same reveal |
| `Ctrl+O` on a call | Expand that call to Pi's full output |

## How counting works

Counts come from the assistant messages of the current turn (and, on replay, from the session
branch), so they survive reloads and restarts. Two consequences worth knowing:

- Activity the transcript never announced is not counted — a subagent's tool calls run in their own
  session, so the summary reports the main agent's work plus `spawned N agents`.
- A run split by notifications (subagent completion, injected context) keeps counting into the same
  turn instead of starting over.

The only thing written to the session is a `cc-tools-summary` custom entry holding the run's timings;
counts are re-derived from messages, so older sessions replay with real numbers.

## Compatibility

- Pi `1.4.0` or newer.
- Works with the default renderer and with custom footers/editors; nothing depends on Pi's own
  spinner or animation loop.
- Reload-safe: `/reload` swaps the renderer for the new code and keeps the current turn's counters.

## Debugging

Set `PI_CC_TOOLS_DEBUG=/tmp/cc-tools.log` to trace the renderer: which row each component draws,
when the elapsed timer arms and fires, and what a settle persisted.

## Development

```bash
npm test        # 101 offline tests, no model and no terminal
```

The tests import the extension through `jiti` the same way Pi does, drive lifecycle events through a
stub `ExtensionAPI`, and render components through Pi's real container. They run one file per process
because the patch state lives on `ToolExecutionComponent.prototype`.

```bash
CC_TOOLS_EXTENSION=/path/to/variant.ts npm test   # run the suite against a modified copy
```

See [`tests/README.md`](tests/README.md) for the file-by-file coverage map and the regression list.

## Layout

```text
extensions/cc-tools/index.ts   the extension
tests/                         offline renderer and lifecycle tests
```

## Known limitations

- The first call of a run still adds the slot's three lines: nothing before it exists to reserve the
  space. From the second call on the height stays put.
- For one frame, a brand-new call may still show the previous row's data: a component joins its run
  only when it renders for the first time. The reserved slot itself is handed over without doubling.
- Thinking time is measured from streamed reasoning; providers that send none report no
  `Thought for` line.
- Expanded calls (`Ctrl+O`) always use Pi's own renderer, so they ignore the summary styling.

## License

MIT — free to use, copy, modify, merge, publish, distribute, sublicense and sell.
See [LICENSE](LICENSE).

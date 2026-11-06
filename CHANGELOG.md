# Changelog

Releases before `0.8.4` are documented in the GitHub release notes:
https://github.com/onpavlov/pi-cc-tools/releases

## 0.8.5 - 2026-11-06

### Fixed

- Tool rows no longer break when a subagent runs. `@tintinweb/pi-subagents` runs a subagent through
  `createAgentSession` in the same process, which evaluates every extension again for a nested
  session: its `session_start` replaced the run map of the conversation on screen, so every row
  fell back to `● tool(arguments)`, the turn lost its summary band, and nothing restored it —
  the state belonged to the subagent from then on.
- Only a session the user drives (`ctx.mode === "tui"`, bound before any subagent exists) owns the
  renderer state now; events of a nested headless session are dropped, so a subagent's tool calls
  no longer land in the parent's run, counters or summary either.
- A session that shuts down releases ownership, which keeps `/new`, `/resume` and `/reload` working.

### Tests

- 147 offline tests, 13 files: `tests/nested-session.test.mjs` covers the nested factory, its
  events, its shutdown, the parent's own settle and the hand-over to the next session.

## 0.8.4 - 2026-11-06

This one shipped on GitHub only; npm goes from `0.8.3` straight to `0.8.5`.

### Fixed

- Tool rows no longer collapse into `● tool(arguments)` lines with no durations and no turn
  summary. A `/reload` clears the run map in `session_shutdown`, Pi then rebuilds the transcript
  before `session_start` hands the session branch back, and a frame drawn in that window had no run
  for any call. Because a row only re-renders when its own state changes, the degraded view stayed
  on screen for the rest of the session.
- The run map is now rebuilt from the session branch by the first row drawn without a run behind it,
  at most once per second, so that window closes on its own instead of waiting for the next session.
- `loadRuns` takes the session manager instead of the whole extension context, which is what lets a
  render call it; the patch state keeps the manager it last saw.

### Tests

- 142 offline tests, 12 files: two new cases in `tests/reload.test.mjs` cover a reload that loses
  the run map (the summary comes back, no fallback row) and an unknown call whose branch has no run
  (the fallback row still stands).

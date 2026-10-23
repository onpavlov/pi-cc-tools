# AGENTS.md

Project rules for `pi-cc-tools` — a Pi extension that renders Claude Code-style tool rows.
Read this before changing code, docs, tags or releases.

---

## Language

Everything is written in English — code, identifiers, comments, commit messages, tag messages,
README, tests, release notes, PR/issue text.

---

## Git

- Never commit, tag, push or create a release without an explicit user request for that step.
- Commit subject: imperative, English, no trailing period. Body: `-` bullets, one line each,
  describing behavior changes rather than files touched.
- Never commit unrelated staged work; check `git diff --cached` before `git commit`.
- Destructive git operations (`git reset`, `git tag -d`, `git push --force`, rewrites) only on
  explicit request. `git tag -d` and bare `git push --force` are blocked by the CC Safety Net —
  use the alternatives below.

## Rewriting history safely

```bash
git commit --amend -F message.txt              # message-only rewrite; no staged changes allowed
git tag -f -a v0.1.0 HEAD -m "pi-cc-tools v0.1.0"
git push --force-with-lease origin main
git push origin --force-with-lease=refs/tags/v0.1.0:<old-tag-sha> refs/tags/v0.1.0
```

Before amending, record `git rev-parse HEAD^{tree}` and confirm the tree hash is unchanged
afterwards — a message rewrite must not alter content. `--force-with-lease` for a tag needs the
explicit `<ref>:<old-sha>` form, otherwise git reports `stale info` after the local tag moved.

---

## Releases

- Tag format `vX.Y.Z` (with the `v` prefix), annotated, matching `package.json` `version`.
- A tag alone is not enough: the release needs GitHub Release notes.
- Release notes: English Markdown — title line, short "What it does" with a fenced example,
  features, install commands, tests, known limitations. Written from `README.md`, not invented.
- Flow:

```bash
git tag -a vX.Y.Z -m "pi-cc-tools vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md
gh release edit vX.Y.Z --notes-file /tmp/notes.md      # when notes change
```

- After publishing, verify the tag actually resolves to the intended commit:

```bash
git ls-remote origin 'refs/tags/vX.Y.Z^{}'
```

- Publishing to npm is out of scope unless asked; the README says the package is installed from git.

---

## Verifying changes

Both must pass before reporting work as done:

```bash
npm test          # node tests/run.mjs — 94 offline tests, no model, no terminal
npm run typecheck # tsc --noEmit, no build step
```

- The suite imports the extension through `jiti` exactly as Pi does, drives lifecycle events
  through a stub `ExtensionAPI`, and renders through Pi's real container.
- `tests/run.mjs` spawns one process per test file: the patch state lives on
  `ToolExecutionComponent.prototype`, so a shared process would leak runs between files.
- `CC_TOOLS_EXTENSION=/path/to/variant.ts npm test` runs the suite against a modified copy.
- Test counts appear in `README.md` and `tests/README.md`; update them when tests are added or
  removed, and keep the per-file table in `tests/README.md` current.

---

## Architecture constraints

- Single implementation file: `extensions/cc-tools/index.ts`. No build step, `type: module`.
- Display-only. Never mutate messages, tool results or the session transcript. The only session
  write allowed is the `cc-tools-summary` custom entry holding the run's timings; counts are
  re-derived from assistant messages so replays stay correct.
- Patch state lives on `ToolExecutionComponent.prototype` under
  `Symbol.for("cc-tools:patch:v1")` (and the placeholder filter under
  `Symbol.for("cc-tools:thinking-filter:v1")`). Version the symbol key if the state shape changes
  incompatibly — `/reload` must keep the current turn's counters while swapping closures.
- No new runtime dependencies. Peer deps are `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` and must stay optional; dev tooling only if an existing dependency
  cannot do the job.
- Keep `PI_CC_TOOLS_DEBUG` tracing working for anything that renders or persists timing state.

---

## Code style

- Tabs for indentation, matching the existing files.
- Small functions, early returns, low nesting; descriptive names, no `tmp`/`data1`/`foo`.
- Comments explain **why** (timers, dwell windows, reload semantics), never restate the code.
- No `TODO`/`FIXME`/`XXX` left behind.
- User-facing strings and timers described in `README.md` must stay in sync with the code —
  durations, phrase order (`thinking → search → read → edit → shell → todos/other → agents`),
  and command names (`/cc-tools on|off|toggle|reveal|hide`).
- `CHANGELOG.md` does not exist; release notes carry the history.

---

## Known behaviors to preserve

- Only the newest still-executing call has a live row; a finished call must not leave a stale
  `Running` row while the model thinks.
- A run split by notifications (subagent completion, injected context) keeps counting into the
  same turn.
- A subagent's own tool calls are not counted as the main agent's; they report as
  `spawned N agents`.
- Expanded calls (`Ctrl+O`) always use Pi's own renderer.

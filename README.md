# Memory Lab

A local CLI for collecting and analyzing JavaScript memory evidence. It can compare heap snapshots, identify object growth, trace retaining paths, and collect source location clues. Those clues are not by themselves proof of a leak or of what should be fixed.

## Get started

Requires Node.js 22.18 or newer and pnpm.

```sh
pnpm install --prod --frozen-lockfile --ignore-scripts
pnpm run check
node src/cli.mjs --help
```

The included RxJS example is a small, intentionally constructed before/after case. It requires a Chromium-based browser; set MEMORY_LAB_CHROME if the executable is not automatically detected.

```sh
node src/cli.mjs verify-project --config examples/rxjs-project/project.json --output ./runs/example
```

For the test suite and optional MemLab comparison, install development dependencies with pnpm install --frozen-lockfile --ignore-scripts, then run pnpm test.

The public repository contains tool code, tests, and the self-contained RxJS example. Historical application replays, third-party checkouts, generated reports, and raw heap snapshots are not included. Heap snapshots can contain application and user data; keep them local unless you have permission to share them.

### Resume a run as an engineer or an agent

To run new Meta MemLab analysis, install with
`pnpm install --frozen-lockfile --ignore-scripts` (without `--prod`).
A production-only install can still read captures and attached analyses.

`handoff` is a read-only view of a capture. To transfer a hashed run, copy the
whole run directory without renaming it or changing its internal layout. Pass
the recipient's run path to the same CLI; no new capture is needed:

```sh
node src/cli.mjs handoff --run <run-directory>
node src/cli.mjs handoff --run <run-directory> --json
```

The default view shows the capture stage, evidence files, and a copyable
analysis command when evidence is ready. JSON exposes the same evidence
with a versioned run record and a `nextActions[].argv` array for direct process
execution without shell interpolation. If the capture reached a follow-up
phase, analysis uses that snapshot rather than the first return snapshot.
Incomplete capture, missing evidence, and analysis failure do not imply a leak
or a successful repair.

After running the suggested analysis command, add
`--analysis <path-to-the-run's-analysis.json>` to see the result alongside the
same capture. The report is checked against the phase it actually analyzed.
A fresh handoff still recommends follow-up when available; a direct
`analyze --run` without `--final-phase` defaults to the first return (`final`).
Meta MemLab candidates are still hypotheses for review, even if
there are zero candidates. This command never modifies source, captures new
evidence, or asserts that a repair works. Keep run artifacts local: they can
contain application data.

New captures hash snapshot bytes while writing. Analysis and handoff check the
selected phases and keep the exact input digests. Changed or missing evidence
cannot attach an old candidate report to the run. Old captures are readable
with `legacy-unverified` provenance at their original location. Reopening a
copied analysis requires its input digests and intact analysis subdirectory.
Source/configuration paths are producer-side context only; copying evidence
does not copy the application or make its scenario replayable.

### Check one declared release rule

```sh
node src/cli.mjs repair-check --before <before-run> --after <after-run> --contract <rule.json>
```

Use two captures with snapshots and the same self-contained scenario. The
scenario must implement a follow-up hook, complete its functional assertions
in both runs, and emit a nonnegative integer count from `observe` at follow-up.
Do not change scenario dependencies between runs; the CLI compares the
top-level scenario digest, not its dependency graph. The rule JSON fields are
`schemaVersion` (currently `0.1.0`), `id`, `owner`, `releasePoint`,
`expectationSource`, `diagnosticKey` and `maxRetained`. The check exits 0
only if the **selected** count breaks the limit before and meets it after
under the matched workflow. A clean baseline or improvement on a different
rule is not a repair result. Add `--json` for structured output. A passed rule
does not prove object collection or that the project has no other leaks.

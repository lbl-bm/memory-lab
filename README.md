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

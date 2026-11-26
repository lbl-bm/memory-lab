# Local repair-check example

This is a synthetic draft editor, not a real-product benchmark. The before and
after web pages differ by the unregister operation on closing the editor.
From the repository root, serve the two previously authored fixture directories
locally in separate terminals:

```sh
python3 -m http.server 48431 --bind 127.0.0.1 --directory examples/draft-repair/before
python3 -m http.server 48432 --bind 127.0.0.1 --directory examples/draft-repair/after
```

With dependencies installed and a local Chromium binary available, run:

```sh
node src/cli.mjs run --config examples/draft-repair/before.json --snapshots
node src/cli.mjs run --config examples/draft-repair/after.json --snapshots
node src/cli.mjs repair-check --before <before-run> --after <after-run> --contract examples/draft-repair/rule.json
```

Use the directories containing each emitted `reportPath`. The scenario verifies
editing, saving and reopening the live draft in both builds. It measures
responses to a local event after the editor is closed, not collected objects.
The expected follow-up response count is 5 to 0. Comparing two clean captures
must not produce a verified repair.

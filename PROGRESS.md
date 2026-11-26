# Memory Lab progress

## 2026-11-26

- Restored a standalone test fixture for RxJS garbage-collection controls.
- Fixed fairness in bounded reverse-path search: a high-degree search can
  yield and resume rather than consuming the remaining traversal budget.
- The current product experiment compares an official Meta MemLab baseline
  against the same analysis engine plus a project-aware repair and replay
  workflow. The independent engine remains a separate experimental track.
- The local Chromium calibration and regression suite have run successfully.
  Calibration is not evidence of an advantage over Meta MemLab or of
  independent repair success on unknown cases.

This branch publishes reviewable engineering checkpoints. Evaluator keys,
raw heaps, project test data and machine-specific environment state are not
published here.

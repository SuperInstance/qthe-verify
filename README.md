# qthe-verify

**Verification you can check yourself, not trust.**

This is an independent rebuilder for [QTHE](https://github.com/SuperInstance/qthe),
a small deterministic cellular substrate. It exists to answer one question
without asking you to trust anyone: *given only a seed and a public spec, does
an independent implementation reproduce the exact same trace, byte for byte,
that the original kernel produced?*

That's it. No opinions about whether QTHE's research claims (the "Layer 2"
items in [SPEC.md](https://github.com/SuperInstance/qthe/blob/main/SPEC.md))
are true — this tool doesn't test those and doesn't care. It tests one thing,
the reproducible-builds thing: **does the same input produce the same output,
independent of who computes it?**

## Run it (one command, no install)

```
git clone https://github.com/SuperInstance/qthe-verify.git
cd qthe-verify
node verify.mjs
```

Requires only Node.js >= 18 (for `node:crypto`). No `npm install`, no
dependencies of any kind — `verify.mjs` imports nothing outside Node's
standard library. Total setup-to-verdict time: under a minute on any machine
with Node already installed; under 10 minutes including installing Node.

Expected output: 12 `PASS` lines and

```
ALL PASS — 12/12 cases byte-identical to the sealed kernel's replay.
```

with exit code `0`. Any other exit code means something diverged, and the
output tells you exactly which case and, where possible, exactly which tick.

## What "verification" means here

This is deliberately **not** "run the vendor's code and see if it says PASS."
That would just be trusting the vendor's code to grade itself. Instead:

1. `corpus/cases.json` holds a committed list of cases: a **seed** (how to
   build the initial substrate), **actions** (grid size, tick count, whether
   the wormhole table is enabled, and the bridge scale `sigma`), and the
   **expected trace hash** — a sha256 of the raw cell bytes after those
   ticks, plus a checkpoint hash after every intermediate tick.

2. Those expected hashes were produced once, by actually running the real,
   sealed QTHE kernel (`reference/qthe-kernel.mjs`, an unmodified vendored
   copy — see its header for the exact upstream commit) through
   `tools/generate-corpus.mjs`. That script is the only thing in this repo
   that touches the vendor's code.

3. `verify.mjs` — the thing you actually run — **never imports the vendor's
   code.** It reimplements the algorithm from scratch, using only the
   description below (and independently, using only SPEC.md, if you want to
   write your own reader instead of trusting this one). It replays each
   case's seed, computes the same sha256 checkpoints, and diffs them against
   the committed expectations.

If `verify.mjs`'s independent reimplementation produces the same hashes the
vendor's sealed kernel produced, that is a real, falsifiable reproducibility
result — not a trust claim. If you don't trust `verify.mjs` either, the
algorithm below is short enough to reimplement yourself in an afternoon (that
is the point: **spec-only**, so a second implementer can rebuild the whole
checker from this document alone, never looking at `verify.mjs`'s source).

## The algorithm, in full

One byte per cell: 2 bits of "timbre" `tau` (`Ground=0, Attract=1, Repel=2,
Abstain=3`), 6 bits of "amplitude" `d` (`0..63`). `pack(tau, d) = (tau<<6)|d`.

**Seed kinds** (deterministic substrate construction):

- `prng(w, h, value)`: seed a [mulberry32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32)
  generator with the 32-bit integer `value`. For each cell, in row-major
  order (`y` outer, `x` inner), draw exactly two floats `r1, r2` from the
  generator, in that order. Set `tau = Ground` if `r1 < 0.55`, `Attract` if
  `r1 < 0.75`, `Repel` if `r1 < 0.92`, else `Abstain`. Set `d = floor(r2 * 64)`.
- `ring(w, h)`: for each cell `(x, y)`, let `dx = x - w/2`, `dy = y - h/2`,
  `r = max(|dx|, |dy|)`. If `r == 14`: `Attract, d=50`. If `r == 15`:
  `Repel, d=30`. If `r < 14` and `(x==40 or x==56)` and `(y==22 or y==42)`:
  `Abstain, d=40`. Otherwise: `Ground, d=8`. (This is the exact geometry of
  QTHE's own A2UI "armor ring" demo — see `corpus/cases.json`'s
  `ring-smoke-04` case, which reproduces the exact hash the project's own
  Looking Glass HUD receipted at tick 4:
  `4f0a62ce5f0393eaa23bd46122b3912400b0d42cc27a93fb34515ff7c1cb66c1`.)

**One tick** (synchronous, toroidal Moore-8 neighborhood):

For every cell, read its 8 neighbors (wrapping at the grid edges) from the
*pre-tick* snapshot. For each neighbor: if its `tau` is `Attract`, add its
`d` to an accumulator `acc`; if `Repel`, subtract it. `Ground` and `Abstain`
neighbors contribute nothing to `acc`.

If the cell's own `tau` is `Abstain` and the wormhole table is enabled: read
64-slot table slot `d` (the cell's own amplitude indexes the table). If that
slot holds a different `(x, y)` with nonzero resonance, add
`resonance * sigma` to the pressure (this is the only place `sigma`, the
bridge scale, enters). Then write this cell's own `(x, y)` and
`resonance = |acc| + 1` into slot `d`, unconditionally (this happens even
when there was no read hit, and even for the writer's own first visit).

Whatever the resulting `pressure` is: if `pressure > 0`, `d` moves toward 63
(saturating, `+1`); if `pressure < 0`, `d` moves toward 0 (saturating, `-1`);
if exactly `0`, `d` is unchanged. `tau` never changes during a tick — only
`d` moves. All cells update from the same pre-tick snapshot (double
buffered), so update order doesn't matter within a tick.

**Determinism contract**: no randomness of any kind is drawn during `tick()`
itself — only during seed construction, and only from the seeded generator
above. Same seed + same sequence of tick options (grid size, tick count,
wormholes on/off, sigma) always produces the same byte sequence, forever, on
any conforming implementation. That is the entire claim this repository
checks.

**Trace hash**: sha256 of the raw `Uint8Array` of packed cell bytes,
row-major, taken after each tick (tick 0 is the raw seed, before any tick
runs). This is the same value QTHE's own Looking Glass HUD displays and its
`demo/smoke/verify-hud-sha.mjs` cross-checks against Node — this tool is that
same check, generalized into a committed, versioned corpus instead of a
manual copy-paste.

## Files

- `verify.mjs` — the reader. Zero dependencies, Node standard library only,
  ~200 lines. This is what an outsider runs and what a second implementer
  should be able to reproduce from the algorithm description above alone.
- `corpus/cases.json` — 12 committed cases: seed, grid size, tick count,
  wormhole on/off, sigma, and the expected hash chain. Covers small and large
  grids, a 1x1 degenerate case, wormholes-on/off paired arms on the same
  seed, a sigma sweep (the C3 claim's parameter), and the project's own
  armor-ring demo geometry at two tick depths.
- `reference/qthe-kernel.mjs` — an unmodified vendored copy of the real,
  sealed kernel, used **only** by `tools/generate-corpus.mjs` to mint the
  corpus's expected hashes. `verify.mjs` never imports this file. Diff it
  against the upstream URL in its header comment if you want to confirm it
  hasn't drifted.
- `tools/generate-corpus.mjs` — regenerates `corpus/cases.json` from the real
  kernel. Not part of the 10-minute outsider path; only needed to add cases
  or re-mint the corpus after an upstream kernel change.

## Pass / kill criteria

This artifact exists to test one falsifiable claim (Wedge 1 of the
reproducible-builds adoption path): **an unaffiliated person can regenerate
a byte-identical trace within 14 days, in 10 minutes of setup or less.**

- **PASS**: `node verify.mjs` exits `0` and every case matches. Run
  `node verify.mjs --self-test` any time you want to see the checker actually
  catch a tampered case — it corrupts one hash in memory (the committed
  corpus file is never touched), shows the exact tick where the replay and
  the (deliberately wrong) expectation diverge, and exits nonzero.
- **KILL**: if a correct, careful, independent implementation of the
  algorithm above cannot reproduce these hashes — or if two runs of this same
  `verify.mjs` on the same machine disagree with each other — the
  determinism claim is false and should be reported as a bug against QTHE,
  not worked around here.

## Why this is spec-only, and why that matters

Reproducible-builds practice doesn't ask you to trust a build artifact
because a trusted party says it's fine — it asks that anyone, independently,
using only public inputs and a public process, can arrive at the same output
and check it themselves. `verify.mjs` is written to that standard: it does
not call into the project it is verifying. If you already have your own
reader for QTHE-shaped substrates, ignore `verify.mjs` entirely, point it at
`corpus/cases.json`'s seeds and actions, and see if you get the same hashes.
That's a stronger result than trusting this repository's own checker, and
it's exactly the check this artifact is for.

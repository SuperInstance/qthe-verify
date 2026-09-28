// tools/generate-corpus.mjs — mints corpus/cases.json from the REAL, sealed
// QTHE kernel (reference/qthe-kernel.mjs, an unmodified vendored copy).
//
// This is the ONLY file in this repo that touches the real kernel. Nothing
// else here imports it, ever. Its job is to answer, once and authoritatively:
// "what does the sealed kernel actually produce for these seeds?" — so that
// verify.mjs's independent, spec-only reimplementation has something honest
// to be checked against.
//
// Not part of the outsider's 10-minute path. Re-run only to regenerate or
// extend the corpus (e.g. `node tools/generate-corpus.mjs > corpus/cases.json`).

import { createHash } from 'node:crypto';
import {
  makeSubstrate, tick, WormholeTable, pack, TAU, DEFAULT_SIGMA,
} from '../reference/qthe-kernel.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── seed generators (the two "seed kinds" this corpus uses; both are
//    specified in full in README.md so an independent reader can rebuild
//    them without reading this file) ────────────────────────────────────────

// "prng": fill w*h cells from a mulberry32 stream seeded by a single integer.
// Every 5th cell (by prng draw) leans toward a non-Ground timbre so wormhole
// activity has something to bridge; see README "Seed kind: prng" for the
// exact draw order this must reproduce.
function prngSeed(w, h, seedInt) {
  let a = seedInt >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return makeSubstrate(w, h, () => {
    const r1 = rand(), r2 = rand();
    let tau;
    if (r1 < 0.55) tau = TAU.GROUND;
    else if (r1 < 0.75) tau = TAU.ATTRACT;
    else if (r1 < 0.92) tau = TAU.REPEL;
    else tau = TAU.ABSTAIN;
    const d = Math.floor(r2 * 64);
    return pack(tau, d);
  });
}

// "ring": the exact armor-ring geometry from demo/a2ui.mjs seed('ring'), as
// replayed by qthe's own demo/smoke/verify-hud-sha.mjs. Ties this corpus
// directly to the receipted Looking Glass smoke test (smoke.md finding c):
// tick 4 sha256 4f0a62ce5f0393eaa23bd46122b3912400b0d42cc27a93fb34515ff7c1cb66c1.
function ringSeed(w, h) {
  return makeSubstrate(w, h, (x, y) => {
    const dx = x - w / 2, dy = y - h / 2, r = Math.max(Math.abs(dx), Math.abs(dy));
    if (r === 14) return pack(TAU.ATTRACT, 50);
    if (r === 15) return pack(TAU.REPEL, 30);
    if (r < 14 && (x === 40 || x === 56) && (y === 22 || y === 42)) return pack(TAU.ABSTAIN, 40);
    return pack(TAU.GROUND, 8);
  });
}

function buildSeed(seed) {
  if (seed.kind === 'prng') return prngSeed(seed.w, seed.h, seed.value);
  if (seed.kind === 'ring') return ringSeed(seed.w, seed.h);
  throw new Error('unknown seed kind: ' + seed.kind);
}

// ── the case manifest: what to run, not what it produces ───────────────────
const MANIFEST = [
  { id: 'prng-01', description: '16x16, wormholes ON, default sigma, 8 ticks',
    seed: { kind: 'prng', w: 16, h: 16, value: 1 }, ticks: 8, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-02', description: '16x16, wormholes OFF (paired arm of prng-01)',
    seed: { kind: 'prng', w: 16, h: 16, value: 1 }, ticks: 8, wormholes: false, sigma: DEFAULT_SIGMA },
  { id: 'prng-03', description: '24x12 wide grid, wormholes ON, 12 ticks',
    seed: { kind: 'prng', w: 24, h: 12, value: 7 }, ticks: 12, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-04', description: '12x24 tall grid, different seed, wormholes ON, 12 ticks',
    seed: { kind: 'prng', w: 12, h: 24, value: 42 }, ticks: 12, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-05', description: '8x8 minimal grid, wormholes ON, 20 ticks (long run, small state)',
    seed: { kind: 'prng', w: 8, h: 8, value: 99 }, ticks: 20, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-06', description: '20x20, wormholes ON, sigma=0.5 (off the C3 default)',
    seed: { kind: 'prng', w: 20, h: 20, value: 314 }, ticks: 10, wormholes: true, sigma: 0.5 },
  { id: 'prng-07', description: '20x20, same seed as prng-06, sigma=2 (C3 sweep point)',
    seed: { kind: 'prng', w: 20, h: 20, value: 314 }, ticks: 10, wormholes: true, sigma: 2 },
  { id: 'prng-08', description: '30x30 larger grid, wormholes ON, 15 ticks',
    seed: { kind: 'prng', w: 30, h: 30, value: 2026 }, ticks: 15, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-09', description: '1x1 degenerate grid (toroidal self-neighbor), 5 ticks',
    seed: { kind: 'prng', w: 1, h: 1, value: 5 }, ticks: 5, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'prng-10', description: '16x16, wormholes ON, 1 tick (single-step sanity case)',
    seed: { kind: 'prng', w: 16, h: 16, value: 1 }, ticks: 1, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'ring-smoke-04', description: 'the armor-ring demo seed, wormholes ON, 4 ticks — the exact configuration behind the Looking Glass HUD smoke test (smoke.md finding c)',
    seed: { kind: 'ring', w: 96, h: 64 }, ticks: 4, wormholes: true, sigma: DEFAULT_SIGMA },
  { id: 'ring-smoke-16', description: 'the same armor-ring seed carried out to 16 ticks',
    seed: { kind: 'ring', w: 96, h: 64 }, ticks: 16, wormholes: true, sigma: DEFAULT_SIGMA },
];

const cases = MANIFEST.map((m) => {
  const sub = buildSeed(m.seed);
  const table = new WormholeTable(m.sigma);
  const tick_hashes = [sha256(sub)];
  for (let i = 0; i < m.ticks; i++) {
    tick(sub, { wormholes: m.wormholes, table, sigma: m.sigma });
    tick_hashes.push(sha256(sub));
  }
  return {
    id: m.id,
    description: m.description,
    seed: m.seed,
    ticks: m.ticks,
    wormholes: m.wormholes,
    sigma: m.sigma,
    expected_trace_hash: tick_hashes[tick_hashes.length - 1],
    tick_hashes,
  };
});

process.stdout.write(JSON.stringify({
  generated_from: 'https://github.com/SuperInstance/qthe/blob/43d741b3a359d593da1a5e9e80575204a499d217/qthe.mjs',
  generated_at: '2026-09-28',
  cases,
}, null, 2) + '\n');

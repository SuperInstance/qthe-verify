// reference/qthe-kernel.mjs — UNMODIFIED vendored copy of the sealed QTHE
// reference kernel, for corpus generation ONLY.
//
// Source: https://github.com/SuperInstance/qthe/blob/43d741b3a359d593da1a5e9e80575204a499d217/qthe.mjs
// Commit: 43d741b3a359d593da1a5e9e80575204a499d217 (branch main, fetched 2026-09-28)
//
// This file is byte-for-byte identical to the upstream qthe.mjs at the
// commit above. It is used ONLY by tools/generate-corpus.mjs to mint the
// "official" expected_trace_hash values in corpus/cases.json from the real,
// sealed kernel — the same mechanism the Looking Glass "Reproduce -> Verify
// byte-identical" button uses.
//
// verify.mjs (the artifact an outsider actually runs) NEVER imports this
// file. It reimplements the algorithm independently, purely from SPEC.md's
// public description, and is checked against the hashes this file produced.
// If you want to confirm this copy has not drifted from upstream, diff it
// against the URL above.

// qthe/qthe.mjs — THE QTHE REFERENCE KERNEL (zero dependencies, ESM,
// integer-exact where the spec says exact).
//
// The primitive: one byte, two planes — 6 bits of spatial amplitude `d`,
// 2 bits of timbre `tau` {Ground, Attract, Repel, Abstain}. Data is geometry,
// control is physics. Source: SPEC.md (the gifted vision, priced by the
// house); this file implements LAYER 0 (algebra facts, exhaustively tested
// by tests/run_tests.mjs) and LAYER 1 (mechanism, determinism-checked).
//
// DETERMINISM CONTRACT: no Math.random anywhere in the kernel. mulberry32()
// lives here as a SEEDED generator for CALLERS (substrate seeding, probes);
// tick() never draws from it. Same substrate + same opts -> byte-identical
// state, always (proof by exhaustion of runs: tests G3).

export const TAU = { GROUND: 0, ATTRACT: 1, REPEL: 2, ABSTAIN: 3 };
export const D_MAX = 63;

// Psi map (SPEC LAYER 0): {0:0, 1:+1, 2:-1, 3:'i'} - the operator character.
export const PSI = [0, 1, -1, 'i'];
export function psi(tau) { return PSI[tau & 3]; }

export function pack(tau, d) { return (((tau & 3) << 6) | (d & D_MAX)) & 0xff; }
export function unpack(c) { return { tau: (c >> 6) & 3, d: c & D_MAX }; }
export function tauOf(c) { return (c >> 6) & 3; }
export function dOf(c) { return c & D_MAX; }

export function vectorPass(weights, xs) {
  const out = [];
  for (let j = 0; j < weights.length; j++) {
    const row = weights[j];
    let re = 0, im = 0;
    for (let k = 0; k < row.length; k++) {
      const c = row[k] & 0xff;
      const dv = c & D_MAX, x = xs[k];
      switch (c >> 6) {
        case 1: re += dv * x; break;
        case 2: re -= dv * x; break;
        case 3: im += dv * x; break;
        default: break;
      }
    }
    out.push({ re, im });
  }
  return out;
}

export const SLOT_COUNT = 64;
export const DEFAULT_SIGMA = Math.log2(3);

export class WormholeTable {
  constructor(sigma = DEFAULT_SIGMA) {
    this.sigma = sigma;
    this.sx = new Int32Array(SLOT_COUNT).fill(-1);
    this.sy = new Int32Array(SLOT_COUNT).fill(-1);
    this.sr = new Int32Array(SLOT_COUNT);
    this.occupied = new Uint8Array(SLOT_COUNT);
    this.totalWrites = 0;
  }
  clear() {
    this.sx.fill(-1); this.sy.fill(-1); this.sr.fill(0);
    this.occupied.fill(0); this.totalWrites = 0;
    return this;
  }
  read(slot) {
    if (!(slot >= 0 && slot < SLOT_COUNT) || !this.occupied[slot]) return null;
    return { x: this.sx[slot], y: this.sy[slot], resonance: this.sr[slot] };
  }
  write(slot, x, y, resonance) {
    if (!(slot >= 0 && slot < SLOT_COUNT)) throw new RangeError('wormhole slot out of range: ' + slot);
    this.sx[slot] = x; this.sy[slot] = y;
    this.sr[slot] = resonance; this.occupied[slot] = 1;
    this.totalWrites++;
  }
  occupiedCount() {
    let n = 0;
    for (let i = 0; i < SLOT_COUNT; i++) n += this.occupied[i];
    return n;
  }
  snapshot() {
    const slots = new Array(SLOT_COUNT).fill(null);
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (this.occupied[i]) slots[i] = { slot: i, x: this.sx[i], y: this.sy[i], resonance: this.sr[i] };
    }
    return slots;
  }
}

export function makeSubstrate(w, h, seedFn) {
  if (!Number.isInteger(w) || w < 1 || !Number.isInteger(h) || h < 1) {
    throw new RangeError('substrate dimensions must be positive integers');
  }
  const cells = new Uint8Array(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) cells[i] = seedFn(x, y, i) & 0xff;
  }
  cells.w = w; cells.h = h; cells.ticks = 0; cells.__wormholes = undefined;
  cells.bytes = cells;
  return cells;
}

export function nextD(d, pressure) {
  if (pressure > 0) return d < D_MAX ? d + 1 : D_MAX;
  if (pressure < 0) return d > 0 ? d - 1 : 0;
  return d;
}

export function tick(cells, opts = {}) {
  const w = cells.w, h = cells.h;
  if (!(w > 0 && h > 0)) throw new Error('not a substrate — use makeSubstrate()');
  const wormholes = opts.wormholes !== false;
  let table = opts.table !== undefined ? opts.table : cells.__wormholes;
  if (wormholes && !(table instanceof WormholeTable)) {
    table = new WormholeTable(opts.sigma);
  }
  const sigma = opts.sigma !== undefined ? opts.sigma : (table ? table.sigma : DEFAULT_SIGMA);
  const n = w * h;
  const snap = cells.__scratch instanceof Uint8Array && cells.__scratch.length === n
    ? cells.__scratch : (cells.__scratch = new Uint8Array(n));
  snap.set(cells);
  const events = [];

  for (let y = 0; y < h; y++) {
    const yUp = (y + h - 1) % h, yDn = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = snap[i];
      const tau = c >> 6, d = c & D_MAX;

      const xL = (x + w - 1) % w, xR = (x + 1) % w;
      let acc = 0;
      let nb = snap[yUp * w + xL]; if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[yUp * w + x];      if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[yUp * w + xR];     if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[y * w + xL];       if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[y * w + xR];       if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[yDn * w + xL];     if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[yDn * w + x];      if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      nb = snap[yDn * w + xR];     if ((nb >> 6) === 1) acc += nb & D_MAX; else if ((nb >> 6) === 2) acc -= nb & D_MAX;

      let pressure = acc;
      if (tau === 3 && wormholes) {
        const hit = table.read(d);
        if (hit && hit.resonance !== 0 && (hit.x !== x || hit.y !== y)) {
          const term = hit.resonance * sigma;
          pressure = acc + term;
          events.push({ kind: 'twin', x, y, slot: d, resonance: hit.resonance, term });
        }
        table.write(d, x, y, Math.abs(acc) + 1);
      }
      cells[i] = (tau << 6) | nextD(d, pressure);
    }
  }
  cells.ticks = (cells.ticks | 0) + 1;
  cells.__wormholes = wormholes ? table : cells.__wormholes;
  cells.lastEvents = events;
  return cells;
}

export function traceView(cells, events) {
  const table = cells.__wormholes instanceof WormholeTable ? cells.__wormholes : null;
  return {
    w: cells.w, h: cells.h, ticks: cells.ticks | 0,
    cells: Array.from(cells),
    wormholes: table && table.occupiedCount() > 0 ? table.snapshot() : null,
    events: events !== undefined ? events : (cells.lastEvents || []),
  };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

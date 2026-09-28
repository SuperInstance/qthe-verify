#!/usr/bin/env node
// verify.mjs — the qthe-verify reader.
//
// Zero dependencies. Node standard library only (node:fs, node:crypto,
// node:path). Reimplements the QTHE substrate + tick rule INDEPENDENTLY,
// from the public spec (see README.md "The algorithm, in full"), and never
// imports the sealed kernel or anything from reference/. This file IS the
// independent rebuild: if you trust nothing else in this repo, read this
// file, compare it to README.md's spec text, and trust your own eyes.
//
// Usage:
//   node verify.mjs                 run the full corpus, print PASS/FAIL
//   node verify.mjs --case=ring-smoke-04   run one case
//   node verify.mjs --self-test      prove the checker can fail: corrupts one
//                                    case's expected hash in memory (the
//                                    committed corpus file is never touched)
//                                    and prints the FAIL + diff it produces
//
// Exit code 0 iff every case checked is byte-identical. Non-zero otherwise.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── LAYER 0: the primitive (SPEC.md) ────────────────────────────────────────
const TAU = { GROUND: 0, ATTRACT: 1, REPEL: 2, ABSTAIN: 3 };
const D_MAX = 63;
const pack = (tau, d) => (((tau & 3) << 6) | (d & D_MAX)) & 0xff;

// ── seeded PRNG (mulberry32 — public domain, fully specified; SPEC.md §7) ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── seed kinds (README.md "Seed kinds" — reproduce EXACTLY, draw order and
//    all: two rand() calls per cell for "prng", row-major, tau before d) ──
function makeCells(w, h, fill) {
  const cells = new Uint8Array(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++, i++) cells[i] = fill(x, y) & 0xff;
  return cells;
}

function prngSeed(w, h, seedInt) {
  const rand = mulberry32(seedInt);
  return makeCells(w, h, () => {
    const r1 = rand(), r2 = rand();
    let tau;
    if (r1 < 0.55) tau = TAU.GROUND;
    else if (r1 < 0.75) tau = TAU.ATTRACT;
    else if (r1 < 0.92) tau = TAU.REPEL;
    else tau = TAU.ABSTAIN;
    return pack(tau, Math.floor(r2 * 64));
  });
}

function ringSeed(w, h) {
  return makeCells(w, h, (x, y) => {
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
  throw new Error(`unknown seed kind: ${seed.kind}`);
}

// ── LAYER 1: the 64-slot wormhole table (SPEC.md item 4) ───────────────────
const SLOT_COUNT = 64;
function newTable() {
  return { sx: new Int32Array(SLOT_COUNT).fill(-1), sy: new Int32Array(SLOT_COUNT).fill(-1), sr: new Int32Array(SLOT_COUNT), occ: new Uint8Array(SLOT_COUNT) };
}
const readSlot = (t, s) => (t.occ[s] ? { x: t.sx[s], y: t.sy[s], r: t.sr[s] } : null);
function writeSlot(t, s, x, y, r) { t.sx[s] = x; t.sy[s] = y; t.sr[s] = r; t.occ[s] = 1; }

// nextD: net-positive pressure saturates toward 63, net-negative toward 0,
// zero pressure holds (SPEC.md item 5 / R3).
function nextD(d, pressure) {
  if (pressure > 0) return d < D_MAX ? d + 1 : D_MAX;
  if (pressure < 0) return d > 0 ? d - 1 : 0;
  return d;
}

// ── LAYER 1: one Moore-8 toroidal tick, synchronous (SPEC.md item 5, R1/R2) ─
function tick(cells, w, h, wormholesOn, sigma, table) {
  const n = w * h;
  const snap = new Uint8Array(n);
  snap.set(cells);
  for (let y = 0; y < h; y++) {
    const yUp = (y + h - 1) % h, yDn = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = snap[i];
      const tau = c >> 6, d = c & D_MAX;
      const xL = (x + w - 1) % w, xR = (x + 1) % w;
      let acc = 0;
      for (const [ny, nx] of [[yUp, xL], [yUp, x], [yUp, xR], [y, xL], [y, xR], [yDn, xL], [yDn, x], [yDn, xR]]) {
        const nb = snap[ny * w + nx];
        if ((nb >> 6) === 1) acc += nb & D_MAX;
        else if ((nb >> 6) === 2) acc -= nb & D_MAX;
      }
      let pressure = acc;
      if (tau === 3 && wormholesOn) {
        const hit = readSlot(table, d);
        if (hit && hit.r !== 0 && (hit.x !== x || hit.y !== y)) pressure = acc + hit.r * sigma;
        writeSlot(table, d, x, y, Math.abs(acc) + 1);
      }
      cells[i] = (tau << 6) | nextD(d, pressure);
    }
  }
}

// ── the replay: seed -> N ticks -> sha256 of the raw cell plane at each
//    checkpoint. This is the same thing the Looking Glass HUD hashes. ──────
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function replay(kase) {
  const { w, h } = kase.seed;
  const cells = buildSeed(kase.seed);
  const table = newTable();
  const tickHashes = [sha256(cells)];
  for (let i = 0; i < kase.ticks; i++) {
    tick(cells, w, h, kase.wormholes, kase.sigma, table);
    tickHashes.push(sha256(cells));
  }
  return tickHashes;
}

// ── runner ──────────────────────────────────────────────────────────────────
function loadCorpus() {
  const raw = readFileSync(path.join(HERE, 'corpus', 'cases.json'), 'utf8');
  return JSON.parse(raw);
}

function checkOne(kase, verbose) {
  const got = replay(kase);
  const gotFinal = got[got.length - 1];
  const pass = gotFinal === kase.expected_trace_hash;
  if (pass) {
    console.log(`PASS  ${kase.id}  (${kase.ticks} ticks, ${gotFinal.slice(0, 16)}...)  ${kase.description}`);
    return true;
  }
  console.log(`FAIL  ${kase.id}  ${kase.description}`);
  console.log(`      expected final  ${kase.expected_trace_hash}`);
  console.log(`      got final       ${gotFinal}`);
  if (Array.isArray(kase.tick_hashes)) {
    let divergedAt = -1;
    for (let t = 0; t < got.length && t < kase.tick_hashes.length; t++) {
      if (got[t] !== kase.tick_hashes[t]) { divergedAt = t; break; }
    }
    if (divergedAt === -1) {
      console.log('      tick-by-tick hashes all matched, but final hash differs — corpus length mismatch?');
    } else {
      console.log(`      diverged at tick ${divergedAt}:`);
      console.log(`        expected  ${kase.tick_hashes[divergedAt]}`);
      console.log(`        got       ${got[divergedAt]}`);
    }
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const caseArg = args.find((a) => a.startsWith('--case='));
  const selfTest = args.includes('--self-test');
  const corpus = loadCorpus();
  let cases = corpus.cases;
  if (caseArg) {
    const id = caseArg.slice('--case='.length);
    cases = cases.filter((c) => c.id === id);
    if (!cases.length) { console.error(`no such case: ${id}`); process.exit(2); }
  }

  if (selfTest) {
    console.log('--- self-test: corrupting one case IN MEMORY ONLY, corpus/cases.json is untouched ---');
    const base = cases.find((c) => c.tick_hashes && c.tick_hashes.length > 3) || cases[0];
    const corruptedTickHashes = base.tick_hashes.slice();
    const flipAt = Math.min(3, corruptedTickHashes.length - 1);
    corruptedTickHashes[flipAt] = '0'.repeat(64); // flip one checkpoint mid-trajectory
    const victim = {
      ...base,
      id: base.id + ' [CORRUPTED FOR SELF-TEST, tick ' + flipAt + ' flipped]',
      tick_hashes: corruptedTickHashes,
      expected_trace_hash: '0'.repeat(64),
    };
    const ok = checkOne(victim, true);
    console.log(ok
      ? '--- self-test FAILED TO DEMONSTRATE A FAILURE (bug in verify.mjs) ---'
      : '--- self-test done: the checker correctly FAILED a tampered case and localized the exact tick it diverged at ---');
    process.exit(ok ? 1 : 0);
  }

  let allPass = true;
  for (const kase of cases) allPass = checkOne(kase, false) && allPass;
  console.log('');
  console.log(allPass
    ? `ALL PASS — ${cases.length}/${cases.length} cases byte-identical to the sealed kernel's replay.`
    : `FAILED — one or more cases diverged. This is either a corrupted corpus or a real reproducibility break; do not ignore it.`);
  process.exit(allPass ? 0 : 1);
}

main();

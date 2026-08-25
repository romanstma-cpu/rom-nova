// Deterministic PRNG for demo mode. The whole synthetic universe derives
// from one seed so screenshots, tests, and dev sessions stay stable.

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** mulberry32 — fast, decent distribution, 32-bit state */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** approximately normal via sum of uniforms (Irwin–Hall, n=6) */
  gaussian(mean = 0, stdev = 1): number {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    return mean + ((sum - 3) / Math.sqrt(0.5)) * stdev;
  }

  /** log-normal-ish positive value with a heavy right tail */
  heavyTail(median: number, spread = 1): number {
    return median * Math.exp(this.gaussian(0, spread));
  }

  /** derive a child generator so subsystems don't perturb each other's streams */
  fork(label: string): Rng {
    let h = this.s;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    }
    return new Rng(h);
  }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Solana-shaped base58 address (44 chars). Deterministic per rng stream. */
export function fakeAddress(rng: Rng): string {
  let out = "";
  for (let i = 0; i < 44; i++) out += BASE58[rng.int(0, BASE58.length - 1)];
  return out;
}

/** Transaction-signature-shaped string (87 chars). */
export function fakeSignature(rng: Rng): string {
  let out = "";
  for (let i = 0; i < 87; i++) out += BASE58[rng.int(0, BASE58.length - 1)];
  return out;
}

export function shortAddr(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

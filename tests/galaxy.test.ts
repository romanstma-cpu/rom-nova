import { describe, it, expect } from "vitest";
import { orbitStep, ORBIT_PERIOD_SEC } from "@/components/three/galaxy/GalaxyScene";
import { tokenColors, coinGeometry } from "@/components/three/galaxy/materials";

/** Integrate the orbit the way the frame loop does, at a given refresh rate. */
function radiansOver(seconds: number, fps: number, speed = 1): number {
  const dt = 1 / fps;
  let total = 0;
  for (let i = 0; i < seconds * fps; i++) total += orbitStep(dt, speed);
  return total;
}

describe("auto-orbit", () => {
  it("completes exactly one revolution per period at speed 1", () => {
    expect(radiansOver(ORBIT_PERIOD_SEC, 60)).toBeCloseTo(2 * Math.PI, 5);
  });

  // The regression this guards: OrbitControls' own autoRotate advances a fixed
  // angle per frame, so the same setting spun 2.4x faster on a 144Hz display.
  it("turns the same amount per second at any frame rate", () => {
    const at60 = radiansOver(10, 60);
    const at144 = radiansOver(10, 144);
    const at30 = radiansOver(10, 30);
    expect(at144).toBeCloseTo(at60, 5);
    expect(at30).toBeCloseTo(at60, 5);
  });

  it("scales linearly with speed, and stops at zero", () => {
    expect(orbitStep(0.016, 2)).toBeCloseTo(orbitStep(0.016, 1) * 2, 10);
    expect(orbitStep(0.016, 0)).toBe(0);
  });

  it("is calm: under four degrees a second at speed 1", () => {
    const degPerSec = (radiansOver(1, 60) * 180) / Math.PI;
    expect(degPerSec).toBeLessThan(4);
    expect(degPerSec).toBeGreaterThan(1);
  });
});

describe("signal colour ramp", () => {
  it("stays on the slate-to-cyan ramp rather than going full hue", () => {
    // Identity hue must not drive the emissive, whatever it is: two tokens with
    // the same score and wildly different hues glow the same colour.
    const a = tokenColors(70, 10);
    const b = tokenColors(70, 300);
    expect(a.emissive.getHexString()).toBe(b.emissive.getHexString());
  });

  it("keeps the middle of the range legible", () => {
    // The old t*t curve left a mid score barely off the slate end, so most of a
    // healthy field rendered as the same dull blue-grey.
    //
    // The threshold is 0.45 on purpose and was calibrated, not guessed: the old
    // curve puts a score of 60 at 34.2% of the way along this measure and the
    // current one puts it at 57.0%. An earlier 0.30 passed under *both*, which
    // made this assertion decoration rather than a test.
    const low = tokenColors(35, 200).emissive;
    const mid = tokenColors(60, 200).emissive;
    const high = tokenColors(90, 200).emissive;
    const blueness = (c: { b: number; r: number }) => c.b - c.r;
    expect(blueness(mid)).toBeGreaterThan(blueness(low));
    expect(blueness(high)).toBeGreaterThan(blueness(mid));
    const span = blueness(high) - blueness(low);
    expect(blueness(mid) - blueness(low)).toBeGreaterThan(span * 0.45);
  });
});

describe("coin geometry", () => {
  it("carries smooth sphere normals, not flat per-face ones", () => {
    // A property three already gives us, pinned so a geometry swap cannot
    // quietly reintroduce faceting: flat normals would stipple every shell at
    // coin size. On a unit sphere centred at the origin the smooth normal
    // equals the normalised position, so each normal matches its own vertex.
    const geo = coinGeometry(3);
    const pos = geo.getAttribute("position");
    const nor = geo.getAttribute("normal");
    expect(nor.count).toBe(pos.count);
    for (let i = 0; i < pos.count; i += 37) {
      const len = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(nor.getX(i)).toBeCloseTo(pos.getX(i) / len, 5);
      expect(nor.getY(i)).toBeCloseTo(pos.getY(i) / len, 5);
      expect(nor.getZ(i)).toBeCloseTo(pos.getZ(i) / len, 5);
    }
    geo.dispose();
  });
});

"use client";

// Whale moves drawn as arcs rather than straight lines.
//
// A quadratic Bézier lifted above the chord makes direction legible: you can
// see which end a move left from and which it arrived at, which a straight
// segment between two spheres cannot show.
//
// These were `lineBasicMaterial` until they weren't. Three things made that
// look cheap, and all three are structural rather than a matter of taste:
//
//   1. WebGL ignores `linewidth` on essentially every platform, so every arc
//      was exactly one pixel no matter how far away it was or how large the
//      move — a $2M transfer and a $10K one drew identically. One-pixel lines
//      also crawl and shimmer badly once the composer resolves MSAA.
//   2. The travelling highlight was a step function (`dash < 0.45 ? 1 : 0.18`),
//      which is the marching-ants look: hard-edged blocks sliding along a wire.
//   3. `#ff4d6d` is a fire-engine red borrowed from the trader's P&L palette.
//      In a scene built from slate, cyan and violet it reads as a foreign
//      object rather than part of the same world.
//
// So: camera-facing ribbons whose width carries the size of the move, a
// gaussian head with a trailing falloff instead of a dash, soft ends so an arc
// resolves into the coin rather than stopping dead against it, and colours that
// belong to the brand axis.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { NetworkPayload, NodePlacement } from "../graph";

const SEGMENTS = 44;
/** Points per arc; one more than the segment count. */
const POINTS = SEGMENTS + 1;
/** Concurrent arcs. Past this the field reads as string art, not as flow. */
const MAX_ARCS = 22;

/** World units at the arc's fattest point, before the per-move size factor. */
const BASE_WIDTH = 0.085;

interface Arc {
  curve: THREE.QuadraticBezierCurve3;
  sell: boolean;
  weight: number;
  born: number;
  life: number;
  seed: number;
}

export function WhaleArcs({
  payload,
  placements,
  enabled,
  speed,
}: {
  payload: NetworkPayload;
  placements: Map<string, NodePlacement>;
  enabled: boolean;
  speed: number;
}) {
  /* eslint-disable react-hooks/immutability --
     Instanced buffers are imperative three.js objects rewritten every frame.
     React never renders from them; treating them as immutable would mean
     reallocating the whole ribbon set sixty times a second. */
  const meshRef = useRef<THREE.Mesh>(null);

  const vertexCount = MAX_ARCS * POINTS * 2;

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const f = (n: number, itemSize: number) =>
      new THREE.BufferAttribute(new Float32Array(n * itemSize), itemSize);

    g.setAttribute("position", f(vertexCount, 3));
    g.setAttribute("aTangent", f(vertexCount, 3));
    g.setAttribute("aColor", f(vertexCount, 3));
    g.setAttribute("aSide", f(vertexCount, 1));
    g.setAttribute("aU", f(vertexCount, 1));
    g.setAttribute("aAlpha", f(vertexCount, 1));
    g.setAttribute("aWidth", f(vertexCount, 1));
    g.setAttribute("aSeed", f(vertexCount, 1));

    // Side and U never change for a given vertex slot — only which arc happens
    // to occupy that slot does. Fill them once.
    const side = g.attributes.aSide.array as Float32Array;
    const u = g.attributes.aU.array as Float32Array;
    for (let a = 0; a < MAX_ARCS; a++) {
      for (let k = 0; k < POINTS; k++) {
        const v = (a * POINTS + k) * 2;
        side[v] = -1;
        side[v + 1] = 1;
        u[v] = k / SEGMENTS;
        u[v + 1] = k / SEGMENTS;
      }
    }

    // Topology is fixed too: two triangles per segment, per arc.
    const idx = new Uint16Array(MAX_ARCS * SEGMENTS * 6);
    let i = 0;
    for (let a = 0; a < MAX_ARCS; a++) {
      const base = a * POINTS * 2;
      for (let k = 0; k < SEGMENTS; k++) {
        const p = base + k * 2;
        idx[i++] = p;
        idx[i++] = p + 1;
        idx[i++] = p + 2;
        idx[i++] = p + 1;
        idx[i++] = p + 3;
        idx[i++] = p + 2;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }, [vertexCount]);

  const material = useMemo(() => {
    const uTime = { value: 0 };
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aTangent;
        attribute vec3 aColor;
        attribute float aSide;
        attribute float aU;
        attribute float aAlpha;
        attribute float aWidth;
        attribute float aSeed;

        varying vec3 vColor;
        varying float vSide;
        varying float vU;
        varying float vAlpha;
        varying float vSeed;

        void main() {
          vColor = aColor;
          vSide  = aSide;
          vU     = aU;
          vAlpha = aAlpha;
          vSeed  = aSeed;

          vec4 mv = modelViewMatrix * vec4(position, 1.0);

          // Expand the line into a ribbon that always faces the camera: offset
          // along the axis perpendicular to both the curve's tangent and the
          // view direction. Done in view space, so the ribbon still narrows
          // with distance like a real object rather than a screen-space stroke.
          vec3 tangent = normalize((modelViewMatrix * vec4(aTangent, 0.0)).xyz);
          vec3 viewDir = normalize(-mv.xyz);
          vec3 across  = normalize(cross(tangent, viewDir));

          // Taper to a point at both ends so the arc grows out of one coin and
          // resolves into the other instead of butting against them.
          float taper = sin(clamp(aU, 0.0, 1.0) * 3.14159265);
          mv.xyz += across * aSide * aWidth * (0.18 + 0.82 * taper);

          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;

        varying vec3 vColor;
        varying float vSide;
        varying float vU;
        varying float vAlpha;
        varying float vSeed;

        void main() {
          if (vAlpha <= 0.001) discard;

          // Soft across the ribbon: a lit core with the edges falling away, so
          // there is no hard silhouette to alias against.
          float across = 1.0 - abs(vSide);
          float core = pow(clamp(across, 0.0, 1.0), 1.6);

          // A head travelling source -> destination, wrapped so it loops
          // cleanly. Gaussian rather than a step: this is the difference
          // between a comet and a marching dash.
          float head = fract(uTime * 0.34 + vSeed);
          float d = vU - head;
          d -= floor(d + 0.5);                       // shortest way round
          float bright = exp(-d * d * 120.0);        // tight leading head
          float trail  = exp(-max(0.0, -d) * 7.0) * 0.42; // fading wake behind it

          // Enough base glow that the whole path stays readable between pulses.
          float lit = 0.16 + bright + trail;

          // Fade the last few percent at each end so an arc never terminates
          // on a hard edge inside a coin.
          float ends = smoothstep(0.0, 0.05, vU) * (1.0 - smoothstep(0.95, 1.0, vU));

          float a = vAlpha * core * lit * ends;
          if (a <= 0.002) discard;

          gl_FragColor = vec4(vColor * lit, a);
        }
      `,
    });
    // Kept off the material object so the frame loop can poke it without
    // reaching through material.uniforms every time.
    (m as THREE.ShaderMaterial & { uTimeRef: { value: number } }).uTimeRef = uTime;
    return m;
  }, []);

  useEffect(() => {
    const g = geometry;
    const m = material;
    return () => {
      g.dispose();
      m.dispose();
    };
  }, [geometry, material]);

  // biggest recent moves — the ones a whale-watcher actually cares about
  const candidates = useMemo(
    () =>
      payload.edges
        .filter((e) => e.kind !== "position")
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 120),
    [payload.edges],
  );

  const st = useRef({ arcs: [] as Arc[], spawn: 0, cursor: 0 });

  // Buy reads as arrival, sell as departure. Both sit on the brand axis now: a
  // mint that belongs with the cyan signal ramp, and a rose carrying the
  // violet-to-pink gradient rather than the trader's P&L red.
  //
  // The mint is deliberately brighter than the coins it flies between. Under
  // additive blending, hue is a weak separator — an aqua arc at coin luminance
  // simply dissolves into a field of cyan spheres and a cyan heat ring, which
  // is what a first pass at #35e8b4 did. Brightness is what makes it read.
  const buy = useMemo(() => new THREE.Color("#6bffd0"), []);
  const sell = useMemo(() => new THREE.Color("#ff5fa8"), []);
  const pt = useMemo(() => new THREE.Vector3(), []);
  const nextPt = useMemo(() => new THREE.Vector3(), []);
  const tan = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }, rawDt) => {
    if (!enabled || rawDt > 0.1) return;
    const mesh = meshRef.current;
    const s = st.current;
    if (!mesh) return;

    const t = clock.elapsedTime;
    const motion = speed || 0;
    (material as THREE.ShaderMaterial & { uTimeRef: { value: number } }).uTimeRef.value =
      t * Math.max(0.15, motion);

    // --- spawn -----------------------------------------------------------
    s.spawn += rawDt * motion;
    if (s.spawn > 0.45 && candidates.length && s.arcs.length < MAX_ARCS) {
      s.spawn = 0;
      // Stride through the candidates rather than marching them in order.
      // They are sorted biggest-first, and at roughly one spawn every half
      // second only the leading third is ever reached — so in a one-sided
      // market (this one is net selling) the whole visible field is a single
      // colour while genuinely large moves the other way sit unseen further
      // down the list. A stride coprime with the pool size still visits every
      // candidate exactly once per cycle; it just stops sampling the extreme
      // head of the distribution over and over.
      const e = candidates[(s.cursor * 47) % candidates.length];
      s.cursor++;
      const a = placements.get(e.from);
      const b = placements.get(e.to);
      if (a && b) {
        const from = new THREE.Vector3(a.x, a.y, a.z);
        const to = new THREE.Vector3(b.x, b.y, b.z);
        const mid = from.clone().add(to).multiplyScalar(0.5);
        // lift proportional to span so long arcs bow more than short ones
        // bow enough to read direction, not so much that the arc leaves frame
        mid.y += Math.min(9, from.distanceTo(to) * 0.16) + 1.5;
        s.arcs.push({
          curve: new THREE.QuadraticBezierCurve3(from, mid, to),
          sell: e.kind === "sell",
          weight: Math.min(1, Math.log10(Math.max(e.usd, 100)) / 6),
          born: t,
          life: 2.6 + Math.min(1.6, e.usd / 250_000),
          // Decorrelates the pulses; without it every arc flashes in lockstep
          // and the field pumps like a heartbeat.
          seed: (s.cursor * 0.6180339887) % 1,
        });
      }
    }

    // --- retire ----------------------------------------------------------
    for (let i = s.arcs.length - 1; i >= 0; i--) {
      if (t - s.arcs[i].born > s.arcs[i].life) s.arcs.splice(i, 1);
    }

    // --- write geometry ---------------------------------------------------
    const attrs = mesh.geometry.attributes;
    const pos = attrs.position.array as Float32Array;
    const tanA = attrs.aTangent.array as Float32Array;
    const colA = attrs.aColor.array as Float32Array;
    const alphaA = attrs.aAlpha.array as Float32Array;
    const widthA = attrs.aWidth.array as Float32Array;
    const seedA = attrs.aSeed.array as Float32Array;

    for (let i = 0; i < MAX_ARCS; i++) {
      const arc = s.arcs[i];
      const slot = i * POINTS * 2;

      if (!arc) {
        // Alpha zero is enough for the shader to discard; no need to move the
        // vertices anywhere expensive.
        for (let k = 0; k < POINTS * 2; k++) alphaA[slot + k] = 0;
        continue;
      }

      const age = (t - arc.born) / arc.life;
      // draw-on: the arc grows from its source rather than appearing whole
      const grown = Math.min(1, age / 0.35);
      // ease the fade rather than ramping it linearly out of nothing
      const fadeRaw = age > 0.66 ? 1 - (age - 0.66) / 0.34 : 1;
      const fade = fadeRaw * fadeRaw * (3 - 2 * fadeRaw); // smoothstep
      const alpha = Math.max(0, fade) * (0.4 + arc.weight * 0.6);
      // Size of the move now reaches the eye as thickness, which is the one
      // thing a one-pixel line could never say.
      const width = BASE_WIDTH * (0.55 + arc.weight * 1.5);
      const base = arc.sell ? sell : buy;

      for (let k = 0; k < POINTS; k++) {
        const u = (k / SEGMENTS) * grown;
        arc.curve.getPoint(u, pt);
        // Forward difference for the tangent; at the last point look backwards
        // so the ribbon does not collapse on the final vertex.
        const uN = Math.min(1, u + 1 / SEGMENTS);
        arc.curve.getPoint(k === POINTS - 1 ? Math.max(0, u - 1 / SEGMENTS) : uN, nextPt);
        tan.copy(k === POINTS - 1 ? pt : nextPt).sub(k === POINTS - 1 ? nextPt : pt);
        if (tan.lengthSq() < 1e-9) tan.set(0, 1, 0);
        tan.normalize();

        const v = slot + k * 2;
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const o = v + sIdx;
          pos[o * 3] = pt.x;
          pos[o * 3 + 1] = pt.y;
          pos[o * 3 + 2] = pt.z;
          tanA[o * 3] = tan.x;
          tanA[o * 3 + 1] = tan.y;
          tanA[o * 3 + 2] = tan.z;
          colA[o * 3] = base.r;
          colA[o * 3 + 1] = base.g;
          colA[o * 3 + 2] = base.b;
          alphaA[o] = alpha;
          widthA[o] = width;
          seedA[o] = arc.seed;
        }
      }
    }

    attrs.position.needsUpdate = true;
    attrs.aTangent.needsUpdate = true;
    attrs.aColor.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
    attrs.aWidth.needsUpdate = true;
    attrs.aSeed.needsUpdate = true;
  });

  if (!enabled) return null;

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} raycast={() => null} />
  );
}

"use client";

// Whale moves drawn as arcs rather than straight lines.
//
// A quadratic Bézier lifted above the chord makes direction legible: you can
// see which end a move left from and which it arrived at, which a straight
// segment between two spheres cannot show. The dash pattern travels from the
// source, so the arc reads as flow with a direction rather than a static tube.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { NetworkPayload, NodePlacement } from "../graph";

const SEGMENTS = 48;
/** Concurrent arcs. Past this the field reads as string art, not as flow. */
const MAX_ARCS = 22;

interface Arc {
  curve: THREE.QuadraticBezierCurve3;
  sell: boolean;
  weight: number;
  born: number;
  life: number;
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
  const lineRef = useRef<THREE.LineSegments>(null);

  const vertexCount = MAX_ARCS * SEGMENTS * 2;
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    return g;
  }, [vertexCount]);
  useEffect(() => () => geometry.dispose(), [geometry]);

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
  const buy = useMemo(() => new THREE.Color("#2ee6a8"), []);
  const sell = useMemo(() => new THREE.Color("#ff4d6d"), []);
  const pt = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }, rawDt) => {
    if (!enabled || rawDt > 0.1) return;
    const line = lineRef.current;
    const s = st.current;
    if (!line) return;

    const t = clock.elapsedTime;
    const motion = speed || 0;

    // --- spawn -----------------------------------------------------------
    s.spawn += rawDt * motion;
    if (s.spawn > 0.45 && candidates.length && s.arcs.length < MAX_ARCS) {
      s.spawn = 0;
      const e = candidates[s.cursor % candidates.length];
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
        });
      }
    }

    // --- retire ----------------------------------------------------------
    for (let i = s.arcs.length - 1; i >= 0; i--) {
      if (t - s.arcs[i].born > s.arcs[i].life) s.arcs.splice(i, 1);
    }

    // --- write geometry ---------------------------------------------------
    const pos = line.geometry.attributes.position.array as Float32Array;
    const col = line.geometry.attributes.color.array as Float32Array;
    let v = 0;

    for (const arc of s.arcs) {
      const age = (t - arc.born) / arc.life;
      // draw-on: the arc grows from its source rather than appearing whole
      const grown = Math.min(1, age / 0.35);
      // fade out over the last third of life
      const alpha = (age > 0.66 ? 1 - (age - 0.66) / 0.34 : 1) * (0.35 + arc.weight * 0.65);
      const base = arc.sell ? sell : buy;

      for (let k = 0; k < SEGMENTS; k++) {
        const u0 = (k / SEGMENTS) * grown;
        const u1 = ((k + 1) / SEGMENTS) * grown;

        // travelling dash: a moving window of brightness along the curve
        const phase = (u0 * 5 - t * 1.4 * motion) % 1;
        const dash = phase < 0 ? phase + 1 : phase;
        const lit = dash < 0.45 ? 1 : 0.18;
        const f = alpha * lit;

        arc.curve.getPoint(u0, pt);
        pos[v * 3] = pt.x;
        pos[v * 3 + 1] = pt.y;
        pos[v * 3 + 2] = pt.z;
        col[v * 3] = base.r * f;
        col[v * 3 + 1] = base.g * f;
        col[v * 3 + 2] = base.b * f;
        v++;

        arc.curve.getPoint(u1, pt);
        pos[v * 3] = pt.x;
        pos[v * 3 + 1] = pt.y;
        pos[v * 3 + 2] = pt.z;
        col[v * 3] = base.r * f;
        col[v * 3 + 1] = base.g * f;
        col[v * 3 + 2] = base.b * f;
        v++;
      }
    }

    // park the unused tail of the buffer rather than reallocating
    for (; v < vertexCount; v++) {
      pos[v * 3] = 0;
      pos[v * 3 + 1] = -9999;
      pos[v * 3 + 2] = 0;
      col[v * 3] = 0;
      col[v * 3 + 1] = 0;
      col[v * 3 + 2] = 0;
    }

    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.attributes.color.needsUpdate = true;
  });

  if (!enabled) return null;

  return (
    <lineSegments ref={lineRef} geometry={geometry} frustumCulled={false} raycast={() => null}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

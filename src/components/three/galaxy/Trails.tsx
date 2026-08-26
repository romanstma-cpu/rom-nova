"use client";

// Orbital trails: each coin leaves a fading ribbon of where it has been.
//
// One LineSegments for the whole field rather than a Line per coin — N line
// objects is N draw calls and N geometry uploads per frame. Positions live in
// a per-coin ring buffer so appending a sample is O(1) with no array shifting.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { NetworkPayload, NodePlacement } from "../graph";
import { tokenColors } from "./materials";

/** Samples retained per coin. 100 at ~20Hz is about five seconds of history —
 *  long enough to read the orbit, short enough not to smear the field. */
const TRAIL_LEN = 100;
const SAMPLE_HZ = 20;

export function Trails({
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

  // trails are for the coins worth following; every coin trailing at once is
  // a hairball that hides the structure it is meant to reveal
  const tracked = useMemo(
    () => [...payload.tokens].sort((a, b) => b.signalScore - a.signalScore).slice(0, 28),
    [payload.tokens],
  );

  const segsPerCoin = TRAIL_LEN - 1;
  const vertexCount = tracked.length * segsPerCoin * 2;

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, vertexCount) * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(Math.max(1, vertexCount) * 3), 3));
    return g;
  }, [vertexCount]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const st = useRef({
    ring: [] as Float32Array[], // per coin: TRAIL_LEN * 3
    head: [] as number[],
    filled: [] as number[],
    clock: 0,
  });

  useEffect(() => {
    const s = st.current;
    s.ring = tracked.map((t) => {
      const buf = new Float32Array(TRAIL_LEN * 3);
      const p = placements.get(t.id);
      if (p) for (let i = 0; i < TRAIL_LEN; i++) buf.set([p.x, p.y, p.z], i * 3);
      return buf;
    });
    s.head = tracked.map(() => 0);
    s.filled = tracked.map(() => 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked]);

  const colors = useMemo(
    () => tracked.map((t) => tokenColors(t.signalScore, t.hue).emissive),
    [tracked],
  );

  useFrame(({ clock }, rawDt) => {
    if (!enabled || rawDt > 0.1) return;
    const line = lineRef.current;
    const s = st.current;
    if (!line || s.ring.length !== tracked.length) return;

    // sample on a fixed clock so trail length is time-based, not frame-based —
    // otherwise a fast machine draws a short trail and a slow one a long trail
    s.clock += rawDt * (speed || 0);
    const sample = s.clock > 1 / SAMPLE_HZ;
    if (sample) s.clock = 0;

    const t = clock.elapsedTime;
    const pos = line.geometry.attributes.position.array as Float32Array;
    const col = line.geometry.attributes.color.array as Float32Array;

    let v = 0;
    for (let c = 0; c < tracked.length; c++) {
      const buf = s.ring[c];
      const place = placements.get(tracked[c].id);

      if (sample && place) {
        // match TokenField's idle drift so the trail tracks the drawn body
        let h = 0;
        const id = tracked[c].id;
        for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 6283;
        const ph = h / 1000;
        const m = speed || 0;
        const head = s.head[c];
        buf[head * 3] = place.x + Math.sin(t * 0.31 + ph) * 0.34 * m;
        buf[head * 3 + 1] = place.y + Math.sin(t * 0.24 + ph * 1.7) * 0.46 * m;
        buf[head * 3 + 2] = place.z + Math.cos(t * 0.27 + ph * 0.6) * 0.34 * m;
        s.head[c] = (head + 1) % TRAIL_LEN;
        s.filled[c] = Math.min(TRAIL_LEN, s.filled[c] + 1);
      }

      const base = colors[c];
      const filled = s.filled[c];
      for (let k = 0; k < segsPerCoin; k++) {
        // walk backwards from the newest sample
        const i0 = (s.head[c] - 1 - k + TRAIL_LEN * 2) % TRAIL_LEN;
        const i1 = (s.head[c] - 2 - k + TRAIL_LEN * 2) % TRAIL_LEN;
        const live = k < filled - 1;
        // opacity is baked into vertex colour: additive lines have no per-vertex
        // alpha, so fading means dimming toward black
        const fade = live ? Math.pow(1 - k / segsPerCoin, 1.8) * 0.55 : 0;

        pos[v * 3] = buf[i0 * 3];
        pos[v * 3 + 1] = buf[i0 * 3 + 1];
        pos[v * 3 + 2] = buf[i0 * 3 + 2];
        col[v * 3] = base.r * fade;
        col[v * 3 + 1] = base.g * fade;
        col[v * 3 + 2] = base.b * fade;
        v++;

        pos[v * 3] = buf[i1 * 3];
        pos[v * 3 + 1] = buf[i1 * 3 + 1];
        pos[v * 3 + 2] = buf[i1 * 3 + 2];
        const fade2 = live ? Math.pow(1 - (k + 1) / segsPerCoin, 1.8) * 0.55 : 0;
        col[v * 3] = base.r * fade2;
        col[v * 3 + 1] = base.g * fade2;
        col[v * 3 + 2] = base.b * fade2;
        v++;
      }
    }

    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.attributes.color.needsUpdate = true;
  });

  if (!enabled) return null;

  return (
    <lineSegments ref={lineRef} geometry={geometry} frustumCulled={false} raycast={() => null}>
      <lineBasicMaterial vertexColors transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

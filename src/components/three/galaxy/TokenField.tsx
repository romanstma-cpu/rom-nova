"use client";

// Every coin in the galaxy, drawn in a fixed number of draw calls instead of N.
//
// Two InstancedMeshes form the LOD pair: a near tier (detail-4 icosahedron,
// full PBR + Fresnel aura) and a far tier (detail-1, flat, no emissive, no env
// sampling). Membership is repartitioned on a slow clock — repartitioning every
// frame costs more than it saves and makes coins flicker between tiers as the
// camera drifts across the boundary.

import { useMemo, useRef, useCallback, useEffect, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { NetworkPayload, NodePlacement } from "../graph";
import {
  coinGeometry,
  coinWireGeometry,
  makeCoinMaterial,
  makeEnvironment,
  tokenColors,
} from "./materials";

const NEAR_DETAIL = 4;
const FAR_DETAIL = 2;
// The field spans ~30 units and the camera sits ~52 out, so a 48-unit
// boundary demoted most of the galaxy to the far tier and the split was
// plainly visible. Push it past the far edge of the disc.
const LOD_DISTANCE = 95;
const LOD_HZ = 6;

export interface HoverInfo {
  id: string;
  symbol: string;
  signalScore: number;
  momentum24h: number;
  x: number;
  y: number;
  z: number;
}

export function TokenField({
  payload,
  placements,
  selectedId,
  onSelect,
  pulsesRef,
  speed,
  wireframe,
  onHoverChange,
}: {
  payload: NetworkPayload;
  placements: Map<string, NodePlacement>;
  selectedId: string | null;
  onSelect: (id: string | null, kind: "token" | "wallet" | null) => void;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
  speed: number;
  wireframe: boolean;
  onHoverChange?: (h: HoverInfo | null) => void;
}) {
  /* eslint-disable react-hooks/immutability --
     Instanced matrix/attribute buffers and the per-frame scratch state are
     imperative three.js objects mutated inside useFrame. React never renders
     from them; treating them as immutable would mean reallocating every frame. */
  const nearRef = useRef<THREE.InstancedMesh>(null);
  const farRef = useRef<THREE.InstancedMesh>(null);
  const wireRef = useRef<THREE.InstancedMesh>(null);
  const { gl } = useThree();

  const tokens = payload.tokens;
  const count = Math.max(1, tokens.length);

  const [hovered, setHovered] = useState<HoverInfo | null>(null);
  const hoveredRef = useRef<string | null>(null);

  // ---- static per-token derived data -------------------------------------
  const meta = useMemo(
    () =>
      tokens.map((t) => {
        const { emissive } = tokenColors(t.signalScore, t.hue);
        let h = 0;
        for (let i = 0; i < t.id.length; i++) h = (h * 31 + t.id.charCodeAt(i)) % 6283;
        return {
          id: t.id,
          emissive,
          score: Math.min(1, Math.max(0, (t.signalScore - 35) / 55)),
          // volatility drives a secondary wobble: a violently moving coin looks
          // unsettled before you read a single number off it
          volatility: Math.min(1, Math.abs(t.momentum24h) / 120),
          phase: h / 1000,
        };
      }),
    [tokens],
  );

  const geoNear = useMemo(() => coinGeometry(NEAR_DETAIL), []);
  const geoFar = useMemo(() => coinGeometry(FAR_DETAIL), []);
  const geoWire = useMemo(() => coinWireGeometry(1), []);
  const env = useMemo(() => makeEnvironment(gl), [gl]);
  const coin = useMemo(() => makeCoinMaterial(env), [env]);

  useEffect(
    () => () => {
      geoNear.dispose();
      geoFar.dispose();
      geoWire.dispose();
      env.dispose();
      coin.dispose();
    },
    [geoNear, geoFar, geoWire, env, coin],
  );

  // per-instance attributes, sized to the full token count; the LOD split only
  // changes how many entries the near mesh actually draws
  const attrs = useMemo(
    () => ({
      emissive: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      score: new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
    }),
    [count],
  );

  // mutable per-frame state, deliberately in a ref rather than on `meta`
  const st = useRef({
    obj: new THREE.Object3D(),
    tmp: new THREE.Vector3(),
    live: [] as THREE.Vector3[],
    mats: [] as THREE.Matrix4[],
    glow: new Float32Array(0),
    nearIdx: [] as number[],
    farIdx: [] as number[],
    lodClock: 0,
  });

  useEffect(() => {
    const s = st.current;
    s.live = tokens.map((t) => {
      const p = placements.get(t.id);
      return new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
    });
    s.mats = tokens.map(() => new THREE.Matrix4());
    s.glow = new Float32Array(tokens.length);
    s.nearIdx = tokens.map((_, i) => i);
    s.farIdx = [];
    // placements are lerped toward, so they intentionally do not reseed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  const emitHover = useCallback(
    (h: HoverInfo | null) => {
      hoveredRef.current = h?.id ?? null;
      setHovered(h);
      onHoverChange?.(h);
    },
    [onHoverChange],
  );

  const handleMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      const inst = e.instanceId;
      const s = st.current;
      if (inst == null || inst >= s.nearIdx.length) return;
      const ti = s.nearIdx[inst];
      const t = tokens[ti];
      if (!t || hoveredRef.current === t.id) return;
      const p = s.live[ti];
      document.body.style.cursor = "pointer";
      emitHover({
        id: t.id,
        symbol: t.symbol,
        signalScore: t.signalScore,
        momentum24h: t.momentum24h,
        x: p.x,
        y: p.y,
        z: p.z,
      });
    },
    [tokens, emitHover],
  );

  const handleOut = useCallback(() => {
    document.body.style.cursor = "default";
    emitHover(null);
  }, [emitHover]);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      const inst = e.instanceId;
      const s = st.current;
      if (inst == null || inst >= s.nearIdx.length) return;
      const t = tokens[s.nearIdx[inst]];
      if (t) onSelect(t.id, "token");
    },
    [tokens, onSelect],
  );

  useFrame(({ clock, camera }, rawDt) => {
    // Frame-rate throttle: a backgrounded tab returns with a huge delta.
    // Integrating it teleports every coin, so skip the frame entirely.
    if (rawDt > 0.1) return;

    const s = st.current;
    const near = nearRef.current;
    const far = farRef.current;
    const wire = wireRef.current;
    if (!near || !far || s.mats.length !== tokens.length) return;

    const t = clock.elapsedTime;
    coin.setTime(t);

    s.lodClock += rawDt;
    const repartition = s.lodClock > 1 / LOD_HZ;
    if (repartition) {
      s.lodClock = 0;
      s.nearIdx.length = 0;
      s.farIdx.length = 0;
    }

    const now = Date.now();
    const motion = speed || 0;
    for (let i = 0; i < tokens.length; i++) {
      const m = meta[i];
      const place = placements.get(m.id);
      const live = s.live[i];
      if (place) {
        const dx = Math.sin(t * 0.31 + m.phase) * 0.34 * motion;
        const dy = Math.sin(t * 0.24 + m.phase * 1.7) * 0.46 * motion;
        const dz = Math.cos(t * 0.27 + m.phase * 0.6) * 0.34 * motion;
        s.tmp.set(place.x + dx, place.y + dy, place.z + dz);
        live.lerp(s.tmp, Math.min(1, rawDt * 2.2));
      }
      if (repartition) {
        (live.distanceTo(camera.position) < LOD_DISTANCE ? s.nearIdx : s.farIdx).push(i);
      }

      const until = pulsesRef.current.get(m.id) ?? 0;
      const raw = until > now ? Math.min(1, (until - now) / 600) : 0;
      const eased = raw * raw * (3 - 2 * raw);

      const wob = 1 + Math.sin(t * (2.2 + m.volatility * 5.5) + m.phase) * 0.055 * m.volatility * motion;
      const sel = selectedId === m.id ? 1.25 : 1;
      const hov = hoveredRef.current === m.id ? 1.18 : 1;

      const o = s.obj;
      o.position.copy(live);
      o.rotation.set(t * 0.06 * motion + m.phase, t * 0.11 * motion + m.phase, 0);
      o.scale.setScalar((place?.radius ?? 0.5) * wob * (1 + 0.42 * eased) * sel * hov);
      o.updateMatrix();
      s.mats[i].copy(o.matrix);
      s.glow[i] = Math.min(
        2,
        m.score + eased * 0.6 + (hoveredRef.current === m.id ? 0.45 : 0) + (selectedId === m.id ? 0.3 : 0),
      );
    }

    // --- near tier --------------------------------------------------------
    const ea = attrs.emissive.array as Float32Array;
    const sa = attrs.score.array as Float32Array;
    for (let k = 0; k < s.nearIdx.length; k++) {
      const i = s.nearIdx[k];
      near.setMatrixAt(k, s.mats[i]);
      ea[k * 3] = meta[i].emissive.r;
      ea[k * 3 + 1] = meta[i].emissive.g;
      ea[k * 3 + 2] = meta[i].emissive.b;
      sa[k] = s.glow[i];
      if (wire) wire.setMatrixAt(k, s.mats[i]);
    }
    near.count = s.nearIdx.length;
    near.instanceMatrix.needsUpdate = true;
    attrs.emissive.needsUpdate = true;
    attrs.score.needsUpdate = true;
    if (wire) {
      wire.count = wireframe ? s.nearIdx.length : 0;
      wire.instanceMatrix.needsUpdate = true;
    }

    // --- far tier ---------------------------------------------------------
    for (let k = 0; k < s.farIdx.length; k++) far.setMatrixAt(k, s.mats[s.farIdx[k]]);
    far.count = s.farIdx.length;
    far.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={nearRef}
        args={[undefined, undefined, count]}
        frustumCulled={false}
        onPointerMove={handleMove}
        onPointerOut={handleOut}
        onClick={handleClick}
      >
        <primitive object={geoNear} attach="geometry" />
        <primitive object={attrs.emissive} attach="geometry-attributes-aEmissive" />
        <primitive object={attrs.score} attach="geometry-attributes-aScore" />
        <primitive object={coin.material} attach="material" />
      </instancedMesh>

      {/* far tier — cheap, no emissive, no env sampling */}
      <instancedMesh ref={farRef} args={[undefined, undefined, count]} frustumCulled={false} raycast={() => null}>
        <primitive object={geoFar} attach="geometry" />
        <meshBasicMaterial color="#131c30" />
      </instancedMesh>

      {/* wireframe overlay, near tier only */}
      <instancedMesh ref={wireRef} args={[undefined, undefined, count]} frustumCulled={false} raycast={() => null}>
        <primitive object={geoWire} attach="geometry" />
        <lineBasicMaterial color="#5d7fbb" transparent opacity={0.22} depthWrite={false} />
      </instancedMesh>

      {hovered && (
        <Html position={[hovered.x, hovered.y + 1.7, hovered.z]} center distanceFactor={26} zIndexRange={[20, 0]}>
          <div className="galaxy-tip">
            <div className="galaxy-tip-sym">{hovered.symbol}</div>
            <div className="galaxy-tip-row">
              <span>signal</span>
              <b>{hovered.signalScore}</b>
            </div>
            <div className="galaxy-tip-row">
              <span>24h</span>
              <b className={hovered.momentum24h >= 0 ? "pos" : "neg"}>
                {hovered.momentum24h >= 0 ? "+" : ""}
                {hovered.momentum24h.toFixed(1)}%
              </b>
            </div>
          </div>
        </Html>
      )}
    </>
  );
}
/* eslint-enable react-hooks/immutability */

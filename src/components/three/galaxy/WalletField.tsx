"use client";

// Wallets, instanced into three draw calls by kind rather than one mesh each.
//
// Smart money gets a rotating octahedron (cut-crystal read under the rim
// light), whales a larger low-poly sphere, everyone else a small dim one. Kind
// is a static property of the wallet, so the buckets are computed once instead
// of every frame.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { NetworkPayload, NodePlacement } from "../graph";
import { SMART_MONEY_THRESHOLD } from "@/lib/engine/thresholds";

type Kind = "smart" | "whale" | "plain";

const STYLE: Record<Kind, { color: string; emissive: number; rough: number; metal: number }> = {
  smart: { color: "#cfe4ff", emissive: 0.78, rough: 0.22, metal: 0.5 },
  whale: { color: "#8b7cff", emissive: 0.5, rough: 0.4, metal: 0.3 },
  plain: { color: "#44546e", emissive: 0.32, rough: 0.5, metal: 0.15 },
};

export function WalletField({
  payload,
  placements,
  selectedId,
  onSelect,
  pulsesRef,
  speed,
}: {
  payload: NetworkPayload;
  placements: Map<string, NodePlacement>;
  selectedId: string | null;
  onSelect: (id: string | null, kind: "token" | "wallet" | null) => void;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
  speed: number;
}) {
  const buckets = useMemo(() => {
    const out: Record<Kind, { id: string; idx: number }[]> = { smart: [], whale: [], plain: [] };
    payload.wallets.forEach((w, idx) => {
      const kind: Kind =
        w.smartMoneyScore >= SMART_MONEY_THRESHOLD ? "smart" : w.labels.includes("whale") || w.labels.includes("fund") ? "whale" : "plain";
      out[kind].push({ id: w.id, idx });
    });
    return out;
  }, [payload.wallets]);

  return (
    <>
      {(Object.keys(buckets) as Kind[]).map((kind) => (
        <WalletBucket
          key={kind}
          kind={kind}
          members={buckets[kind]}
          placements={placements}
          selectedId={selectedId}
          onSelect={onSelect}
          pulsesRef={pulsesRef}
          speed={speed}
        />
      ))}
    </>
  );
}

function WalletBucket({
  kind,
  members,
  placements,
  selectedId,
  onSelect,
  pulsesRef,
  speed,
}: {
  kind: Kind;
  members: { id: string; idx: number }[];
  placements: Map<string, NodePlacement>;
  selectedId: string | null;
  onSelect: (id: string | null, kind: "token" | "wallet" | null) => void;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
  speed: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = Math.max(1, members.length);
  const style = STYLE[kind];

  const st = useRef({
    obj: new THREE.Object3D(),
    tmp: new THREE.Vector3(),
    live: [] as THREE.Vector3[],
  });

  useEffect(() => {
    st.current.live = members.map((m) => {
      const p = placements.get(m.id);
      return new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  useFrame(({ clock }, dt) => {
    if (dt > 0.1) return;
    const mesh = ref.current;
    const s = st.current;
    if (!mesh || s.live.length !== members.length) return;

    const t = clock.elapsedTime;
    const motion = speed || 0;
    const now = Date.now();

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const place = placements.get(m.id);
      const live = s.live[i];
      if (place) {
        s.tmp.set(place.x, place.y, place.z);
        live.lerp(s.tmp, Math.min(1, dt * 2.2));
      }

      const until = pulsesRef.current.get(m.id) ?? 0;
      const raw = until > now ? Math.min(1, (until - now) / 600) : 0;
      const eased = raw * raw * (3 - 2 * raw);

      const o = s.obj;
      o.position.copy(live);
      // smart money turns slowly so its facets catch the rim light
      if (kind === "smart") o.rotation.set(Math.sin(t * 0.4) * 0.25, t * 0.5 * motion, 0);
      else o.rotation.set(0, 0, 0);
      o.scale.setScalar((place?.radius ?? 0.3) * (1 + 0.5 * eased) * (selectedId === m.id ? 1.6 : 1));
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    }
    mesh.count = members.length;
    mesh.instanceMatrix.needsUpdate = true;
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const inst = e.instanceId;
    if (inst == null || inst >= members.length) return;
    onSelect(members[inst].id, "wallet");
  };

  if (!members.length) return null;

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false} onClick={handleClick}>
      {kind === "smart" ? <octahedronGeometry args={[1.4, 0]} /> : <icosahedronGeometry args={[1, 1]} />}
      <meshStandardMaterial
        color={style.color}
        emissive={style.color}
        emissiveIntensity={style.emissive}
        roughness={style.rough}
        metalness={style.metal}
        flatShading={kind === "smart"}
      />
    </instancedMesh>
  );
}

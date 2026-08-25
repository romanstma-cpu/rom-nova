"use client";

// The 3D intelligence scene. Wallets are stars, tokens are planets, trades
// are particle streams between them. Node positions lerp between mode
// layouts; a frame-time governor sheds particle budget before it sheds
// usability.

import { useMemo, useRef, useCallback, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars, Text, Billboard } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  layoutNetwork,
  edgeIntensity,
  type NetworkPayload,
  type SceneMode,
  type NodePlacement,
} from "./graph";

export interface SceneSettings {
  mode: SceneMode;
  particles: boolean;
  labels: boolean;
  trails: boolean;
  riskOverlay: boolean;
  autoRotate: boolean;
  speed: number; // 0 = paused
}

/** shared soft radial glow texture for node halos (one canvas, all sprites) */
function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.32)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface SelectHandler {
  (id: string | null, kind: "token" | "wallet" | null): void;
}

// ---------------------------------------------------------------- particles

const MAX_PARTICLES = 700;

interface Particle {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  speed: number;
  color: THREE.Color;
  size: number;
  sell: boolean;
  alive: boolean;
}

function ParticleField({
  payload,
  placements,
  settings,
  budgetRef,
  burstsRef,
  pulsesRef,
}: {
  payload: NetworkPayload;
  placements: Map<string, NodePlacement>;
  settings: SceneSettings;
  budgetRef: React.MutableRefObject<number>;
  burstsRef: React.MutableRefObject<{ from: string; to: string; sell: boolean; usd: number }[]>;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
}) {
  /* eslint-disable react-hooks/immutability --
     The particle pool and its Float32Array attribute buffers are an
     imperative three.js animation mutated per-frame inside useFrame.
     React never re-renders from these values; treating them as immutable
     would mean reallocating 700×3 floats at 60fps. */
  const geomRef = useRef<THREE.BufferGeometry>(null);
  const pool = useMemo<Particle[]>(
    () =>
      Array.from({ length: MAX_PARTICLES }, () => ({
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 0,
        speed: 0.4,
        color: new THREE.Color(),
        size: 1,
        sell: false,
        alive: false,
      })),
    [],
  );
  // double-size buffers: every live particle also draws a trailing echo one
  // beat behind itself, which reads as motion streaks under bloom
  const positions = useMemo(() => new Float32Array(MAX_PARTICLES * 2 * 3), []);
  const colors = useMemo(() => new Float32Array(MAX_PARTICLES * 2 * 3), []);
  const sizes = useMemo(() => new Float32Array(MAX_PARTICLES * 2), []);
  const spawnClock = useRef(0);

  const tradeEdges = useMemo(() => payload.edges.filter((e) => e.kind !== "position"), [payload.edges]);

  const spawn = useCallback(
    (fromId: string, toId: string, sell: boolean, usd: number) => {
      const a = placements.get(fromId);
      const b = placements.get(toId);
      if (!a || !b) return;
      const p = pool.find((x) => !x.alive);
      if (!p) return;
      // buys travel wallet -> token; sells travel token -> wallet
      const src = sell ? b : a;
      const dst = sell ? a : b;
      p.from.set(src.x, src.y, src.z);
      p.to.set(dst.x, dst.y, dst.z);
      p.t = 0;
      p.speed = 0.22 + Math.random() * 0.38;
      p.sell = sell;
      p.color.set(sell ? "#ff4d6d" : "#2ee6a8");
      p.size = 0.6 + Math.min(2.4, Math.log10(Math.max(usd, 100)) / 2.2);
      p.alive = true;
      // the destination node feels the arrival — a short pulse of scale
      const targetId = sell ? fromId : toId;
      pulsesRef.current.set(targetId, Date.now() + 550 + Math.min(650, usd / 400));
    },
    [placements, pool, pulsesRef],
  );

  useFrame((_, dt) => {
    if (settings.speed === 0) return;
    const step = Math.min(dt, 0.1) * settings.speed;

    // steady ambient spawning from recent trade edges, capped by the budget
    spawnClock.current += step;
    const liveCount = pool.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
    if (settings.particles && spawnClock.current > 0.08 && liveCount < budgetRef.current && tradeEdges.length) {
      spawnClock.current = 0;
      const e = tradeEdges[Math.floor(Math.random() * tradeEdges.length)];
      spawn(e.from, e.to, e.kind === "sell", e.usd);
    }
    // event bursts (SSE): several particles at once
    while (burstsRef.current.length) {
      const b = burstsRef.current.shift()!;
      const n = Math.min(8, 2 + Math.floor(Math.log10(Math.max(b.usd, 1000))));
      for (let i = 0; i < n; i++) spawn(b.from, b.to, b.sell, b.usd / n);
    }

    let i = 0;
    const wobble = performance.now() / 1000;
    const place = (idx: number, p: Particle, t: number, dim: number) => {
      const ease = t * t * (3 - 2 * t);
      positions[idx * 3] = p.from.x + (p.to.x - p.from.x) * ease;
      positions[idx * 3 + 1] = p.from.y + (p.to.y - p.from.y) * ease + Math.sin(t * Math.PI) * 1.6;
      positions[idx * 3 + 2] = p.from.z + (p.to.z - p.from.z) * ease;
      colors[idx * 3] = p.color.r * dim;
      colors[idx * 3 + 1] = p.color.g * dim;
      colors[idx * 3 + 2] = p.color.b * dim;
      const twinkle = 0.9 + 0.18 * Math.sin(wobble * 11 + idx * 1.7);
      sizes[idx] = p.size * Math.sin(Math.max(0.05, t) * Math.PI) * dim * twinkle;
    };
    const hide = (idx: number) => {
      positions[idx * 3 + 1] = -9999;
      sizes[idx] = 0;
    };
    for (const p of pool) {
      if (p.alive) {
        p.t += step * p.speed;
        if (p.t >= 1) p.alive = false;
      }
      if (p.alive) {
        place(i, p, p.t, 1);
        const echoT = p.t - 0.055;
        if (echoT > 0.01) place(MAX_PARTICLES + i, p, echoT, 0.45);
        else hide(MAX_PARTICLES + i);
      } else {
        hide(i);
        hide(MAX_PARTICLES + i);
      }
      i++;
    }
    if (geomRef.current) {
      geomRef.current.attributes.position.needsUpdate = true;
      geomRef.current.attributes.color.needsUpdate = true;
      (geomRef.current.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    }
  });

  return (
    <points frustumCulled={false}>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
      </bufferGeometry>
      <pointsMaterial vertexColors size={0.5} sizeAttenuation transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}
/* eslint-enable react-hooks/immutability */

// ---------------------------------------------------------------- edges

function EdgeLines({ payload, placements }: { payload: NetworkPayload; placements: Map<string, NodePlacement> }) {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const cols: number[] = [];
    const c = new THREE.Color();
    for (const e of payload.edges) {
      if (e.kind !== "position") continue;
      const a = placements.get(e.from);
      const b = placements.get(e.to);
      if (!a || !b) continue;
      const alpha = 0.12 + edgeIntensity(e) * 0.25;
      c.set("#3d5a8a").multiplyScalar(alpha * 2.4);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [payload, placements]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

// ---------------------------------------------------------------- nodes

function TokenNode({
  node,
  placement,
  selected,
  settings,
  onSelect,
  labeled,
  glowMap,
  pulsesRef,
}: {
  node: NetworkPayload["tokens"][0];
  placement: NodePlacement;
  selected: boolean;
  settings: SceneSettings;
  onSelect: SelectHandler;
  labeled: boolean;
  glowMap: THREE.Texture;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
}) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const target = useMemo(() => new THREE.Vector3(placement.x, placement.y, placement.z), [placement]);
  // one instrument palette: signal strength drives a slate→cyan ramp; the
  // token's identity hue survives only as a 12% tint. State glows, identity
  // whispers — the opposite produces rainbow marbles.
  const { color, emissive } = useMemo(() => {
    const t = Math.min(1, Math.max(0, (node.signalScore - 35) / 55));
    const body = new THREE.Color("#1a2440").lerp(new THREE.Color(`hsl(${node.hue}, 45%, 34%)`), 0.14);
    const em = new THREE.Color("#42557d").lerp(new THREE.Color("#38e1ff"), t * t);
    if (node.signalScore >= 88) em.lerp(new THREE.Color("#d7f8ff"), 0.5);
    return { color: body, emissive: em };
  }, [node.hue, node.signalScore]);
  const hot = node.signalScore >= 76;

  useFrame(({ clock }, dt) => {
    if (!group.current || !mesh.current) return;
    group.current.position.lerp(target, Math.min(1, dt * 2.2));
    const breathe = hot ? 1 + Math.sin(clock.elapsedTime * 2.4 + node.hue) * 0.07 : 1;
    // arrival pulse: an incoming trade briefly swells the node and its glow
    const until = pulsesRef.current.get(node.id) ?? 0;
    const now = Date.now();
    const kick = until > now ? 1 + 0.42 * Math.min(1, (until - now) / 600) : 1;
    mesh.current.scale.setScalar(placement.radius * breathe * kick * (selected ? 1.25 : 1));
    const mat = mesh.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity =
      (0.22 + (node.signalScore / 100) * (hot ? 1.3 : 0.6) + (selected ? 0.8 : 0)) * (kick > 1 ? 1.6 : 1);
  });

  return (
    <group ref={group} position={[placement.x, placement.y, placement.z]}>
      <mesh
        ref={mesh}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.id, "token");
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
      >
        <sphereGeometry args={[1, 24, 24]} />
        <meshStandardMaterial color={color} emissive={emissive} roughness={0.55} metalness={0.1} />
      </mesh>
      {(hot || selected) && (
        <sprite scale={placement.radius * (selected ? 7 : 5)}>
          <spriteMaterial
            map={glowMap}
            color={emissive}
            transparent
            opacity={selected ? 0.55 : 0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      )}
      {settings.riskOverlay && node.riskHigh && (
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[placement.radius * 1.9, 0.045, 8, 48]} />
          <meshBasicMaterial color="#ff4d6d" transparent opacity={0.7} />
        </mesh>
      )}
      {(labeled || selected) && settings.labels && (
        <Billboard position={[0, placement.radius + 1.1, 0]}>
          <Text fontSize={0.85} color={selected ? "#38e1ff" : "#9fb0cc"} anchorX="center" anchorY="bottom" outlineWidth={0.05} outlineColor="#04060a">
            {node.symbol}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

function WalletNode({
  node,
  placement,
  selected,
  settings,
  onSelect,
  pulsesRef,
}: {
  node: NetworkPayload["wallets"][0];
  placement: NodePlacement;
  selected: boolean;
  settings: SceneSettings;
  onSelect: SelectHandler;
  pulsesRef: React.MutableRefObject<Map<string, number>>;
}) {
  const group = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh>(null);
  const target = useMemo(() => new THREE.Vector3(placement.x, placement.y, placement.z), [placement]);
  const smart = node.smartMoneyScore >= 65;
  const whale = node.labels.includes("whale") || node.labels.includes("fund");
  const color = smart ? "#e9f4ff" : whale ? "#8b7cff" : "#44546e";

  useFrame((_, dt) => {
    group.current?.position.lerp(target, Math.min(1, dt * 2.2));
    if (inner.current) {
      const until = pulsesRef.current.get(node.id) ?? 0;
      const now = Date.now();
      const kick = until > now ? 1 + 0.5 * Math.min(1, (until - now) / 600) : 1;
      inner.current.scale.setScalar(placement.radius * kick * (selected ? 1.6 : 1));
    }
  });

  return (
    <group ref={group} position={[placement.x, placement.y, placement.z]}>
      <mesh
        ref={inner}
        scale={placement.radius}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.id, "wallet");
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
      >
        {smart ? <octahedronGeometry args={[1.4, 0]} /> : <sphereGeometry args={[1, 12, 12]} />}
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={smart ? 1.2 : 0.5} roughness={0.4} />
      </mesh>
      {selected && settings.labels && (
        <Billboard position={[0, 1.6, 0]}>
          <Text fontSize={0.8} color="#38e1ff" anchorX="center" outlineWidth={0.05} outlineColor="#04060a">
            {node.entity ?? `${node.id.slice(0, 4)}…${node.id.slice(-4)}`}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

// ---------------------------------------------------------------- camera + governor

function CameraRig({
  focus,
  autoRotate,
  resetSignal,
}: {
  focus: THREE.Vector3 | null;
  autoRotate: boolean;
  resetSignal: number;
}) {
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const seenReset = useRef(resetSignal);
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    if (seenReset.current !== resetSignal) {
      seenReset.current = resetSignal;
      c.reset();
    }
    if (focus) c.target.lerp(focus, 0.06);
    c.update();
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      maxDistance={130}
      minDistance={4}
      autoRotate={autoRotate && !focus}
      autoRotateSpeed={0.35}
    />
  );
}

function QualityGovernor({
  budgetRef,
  onFps,
  onDegrade,
}: {
  budgetRef: React.MutableRefObject<number>;
  onFps?: (fps: number) => void;
  onDegrade?: () => void;
}) {
  const { setDpr } = useThree();
  const acc = useRef({ t: 0, frames: 0 });
  useFrame((_, dt) => {
    acc.current.t += dt;
    acc.current.frames++;
    if (acc.current.t >= 1.5) {
      const fps = acc.current.frames / acc.current.t;
      onFps?.(fps);
      if (fps < 28) {
        budgetRef.current = Math.max(120, budgetRef.current - 150);
        setDpr(1);
        onDegrade?.();
      } else if (fps > 50 && budgetRef.current < MAX_PARTICLES) {
        budgetRef.current = Math.min(MAX_PARTICLES, budgetRef.current + 60);
      }
      acc.current = { t: 0, frames: 0 };
    }
  });
  return null;
}

// ---------------------------------------------------------------- scene root

export function Network3D({
  payload,
  settings,
  selectedId,
  onSelect,
  burstsRef,
  onFps,
  className,
  resetSignal = 0,
  mobile = false,
}: {
  payload: NetworkPayload;
  settings: SceneSettings;
  selectedId: string | null;
  onSelect: SelectHandler;
  burstsRef: React.MutableRefObject<{ from: string; to: string; sell: boolean; usd: number }[]>;
  onFps?: (fps: number) => void;
  className?: string;
  resetSignal?: number;
  mobile?: boolean;
}) {
  const placements = useMemo(() => layoutNetwork(payload, settings.mode), [payload, settings.mode]);
  const budgetRef = useRef(mobile ? 180 : 420);
  const pulsesRef = useRef<Map<string, number>>(new Map());
  const glowMap = useMemo(() => makeGlowTexture(), []);
  useEffect(() => () => glowMap.dispose(), [glowMap]);
  // post-processing degrades sticky: once the governor sees sustained low
  // FPS, bloom stays off for the session rather than oscillating
  const [fx, setFx] = useState(!mobile);
  const onDegrade = useCallback(() => setFx(false), []);
  const labeledTokens = useMemo(
    () => new Set([...payload.tokens].sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 14).map((t) => t.id)),
    [payload.tokens],
  );
  const focus = useMemo(() => {
    if (!selectedId) return null;
    const p = placements.get(selectedId);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  }, [selectedId, placements]);

  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, 22, 52], fov: 50 }}
        dpr={mobile ? [1, 1.25] : [1, 1.75]}
        gl={{ antialias: !mobile, powerPreference: "high-performance" }}
        onPointerMissed={() => onSelect(null, null)}
      >
        <color attach="background" args={["#04060a"]} />
        <fog attach="fog" args={["#04060a", 70, 175]} />
        <ambientLight intensity={0.18} />
        <pointLight position={[0, 34, 8]} intensity={650} color="#9fd8ff" />
        <pointLight position={[42, -22, 42]} intensity={320} color="#8b7cff" />
        <Stars radius={140} depth={60} count={mobile ? 1200 : 2600} factor={3.2} saturation={0} fade speed={settings.speed * 0.5} />

        {payload.tokens.map((t) => {
          const p = placements.get(t.id);
          return p ? (
            <TokenNode
              key={t.id}
              node={t}
              placement={p}
              selected={selectedId === t.id}
              settings={settings}
              onSelect={onSelect}
              labeled={labeledTokens.has(t.id)}
              glowMap={glowMap}
              pulsesRef={pulsesRef}
            />
          ) : null;
        })}
        {payload.wallets.map((w) => {
          const p = placements.get(w.id);
          return p ? (
            <WalletNode key={w.id} node={w} placement={p} selected={selectedId === w.id} settings={settings} onSelect={onSelect} pulsesRef={pulsesRef} />
          ) : null;
        })}

        {settings.trails && <EdgeLines payload={payload} placements={placements} />}
        {settings.particles && (
          <ParticleField
            payload={payload}
            placements={placements}
            settings={settings}
            budgetRef={budgetRef}
            burstsRef={burstsRef}
            pulsesRef={pulsesRef}
          />
        )}

        <CameraRig focus={focus} autoRotate={settings.autoRotate} resetSignal={resetSignal} />
        <QualityGovernor budgetRef={budgetRef} onFps={onFps} onDegrade={onDegrade} />
        {fx && (
          <EffectComposer multisampling={0}>
            <Bloom intensity={0.85} luminanceThreshold={0.32} luminanceSmoothing={0.28} mipmapBlur radius={0.72} />
            <Vignette eskil={false} offset={0.26} darkness={0.55} />
          </EffectComposer>
        )}
      </Canvas>
    </div>
  );
}

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

/* Fresnel atmosphere shell. A back-side sphere that only lights where the
   surface turns away from the eye, so every node gets a silhouette rim instead
   of reading as a matte billiard ball. Cheap: two triangles' worth of math per
   fragment, no lights, no shadow pass. */
const ATMO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const ATMO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float f = 1.0 - abs(dot(normalize(vNormal), normalize(vView)));
    f = pow(clamp(f, 0.0, 1.0), uPower);
    gl_FragColor = vec4(uColor * f * uIntensity, f * uIntensity);
  }
`;

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

/* Holding every position edge on screen produced a spider-web that buried the
   nodes. Keep only the strongest relationships, ramp their colour toward the
   accent with conviction, and run a slow travelling wave along the set so the
   lattice reads as a live circuit instead of static string art. */
const MAX_EDGES = 190;

function EdgeLines({ payload, placements }: { payload: NetworkPayload; placements: Map<string, NodePlacement> }) {
  const linesRef = useRef<THREE.LineSegments>(null);
  const { geometry, base } = useMemo(() => {
    const scored = payload.edges
      .filter((e) => e.kind === "position" && placements.has(e.from) && placements.has(e.to))
      .map((e) => ({ e, w: edgeIntensity(e) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_EDGES);

    const pts: number[] = [];
    const cols: number[] = [];
    const weights: number[] = [];
    const cold = new THREE.Color("#2f4a78");
    const warm = new THREE.Color("#38e1ff");
    const c = new THREE.Color();
    for (const { e, w } of scored) {
      const a = placements.get(e.from)!;
      const b = placements.get(e.to)!;
      c.copy(cold).lerp(warm, Math.min(1, w * w * 0.85));
      const alpha = 0.14 + w * 0.4;
      c.multiplyScalar(alpha);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
      weights.push(w, w);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return { geometry: g, base: { colors: Float32Array.from(cols), weights: Float32Array.from(weights) } };
  }, [payload, placements]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(({ clock }) => {
    const g = linesRef.current?.geometry;
    if (!g) return;
    const attr = g.attributes.color as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const t = clock.elapsedTime;
    for (let i = 0; i < base.weights.length; i++) {
      // one wave sweeping the ranked list; strong edges swing wider
      const pulse = 0.86 + 0.2 * Math.sin(t * 1.1 - i * 0.16) * (0.3 + base.weights[i]);
      arr[i * 3] = base.colors[i * 3] * pulse;
      arr[i * 3 + 1] = base.colors[i * 3 + 1] * pulse;
      arr[i * 3 + 2] = base.colors[i * 3 + 2] * pulse;
    }
    attr.needsUpdate = true;
  });

  return (
    <lineSegments ref={linesRef} geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

// ---------------------------------------------------------------- nodes

/** Risk marker. Two counter-rotating additive rings read as a warning field
 *  around the body rather than a red ellipse drawn on top of the picture. */
function RiskHalo({ radius, phase }: { radius: number; phase: number }) {
  const outer = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (outer.current) {
      outer.current.rotation.z = t * 0.22 + phase;
      const m = outer.current.material as THREE.MeshBasicMaterial;
      m.opacity = 0.34 + 0.16 * Math.sin(t * 1.6 + phase);
    }
    if (inner.current) inner.current.rotation.z = -t * 0.31 + phase;
  });
  return (
    <group rotation={[Math.PI / 2.4, 0, 0]} raycast={() => null}>
      <mesh ref={outer}>
        <torusGeometry args={[radius * 2.05, 0.055, 8, 56]} />
        <meshBasicMaterial color="#ff4d6d" transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={inner}>
        <torusGeometry args={[radius * 1.72, 0.03, 8, 48]} />
        <meshBasicMaterial color="#ff8098" transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

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
  const atmo = useRef<THREE.Mesh>(null);
  const atmoMat = useRef<THREE.ShaderMaterial>(null);
  const target = useMemo(() => new THREE.Vector3(placement.x, placement.y, placement.z), [placement]);
  // deterministic per-node phase so idle drift never syncs into a pulsing mass
  const phase = useMemo(() => {
    let h = 0;
    for (let i = 0; i < node.id.length; i++) h = (h * 31 + node.id.charCodeAt(i)) % 6283;
    return h / 1000;
  }, [node.id]);
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
  const atmoUniforms = useMemo(
    () => ({
      uColor: { value: emissive.clone() },
      uPower: { value: 2.7 },
      uIntensity: { value: 0.0 },
    }),
    [emissive],
  );

  useFrame(({ clock }, dt) => {
    if (!group.current || !mesh.current) return;
    const t = clock.elapsedTime;
    // idle orbital drift — every node keeps a slow, per-node-phased float so the
    // field reads alive when nothing is trading, without a synced "breathing" tell
    const driftX = Math.sin(t * 0.31 + phase) * 0.34;
    const driftY = Math.sin(t * 0.24 + phase * 1.7) * 0.46;
    const driftZ = Math.cos(t * 0.27 + phase * 0.6) * 0.34;
    group.current.position.lerp(target, Math.min(1, dt * 2.2));
    group.current.position.x += driftX * dt * 2.2;
    group.current.position.y += driftY * dt * 2.2;
    group.current.position.z += driftZ * dt * 2.2;

    const breathe = hot ? 1 + Math.sin(t * 2.4 + phase) * 0.06 : 1;
    // arrival pulse: an incoming trade swells the node. Eased (cubic-out) so it
    // snaps on impact and settles softly, instead of the old linear ramp-down.
    const until = pulsesRef.current.get(node.id) ?? 0;
    const now = Date.now();
    const raw = until > now ? Math.min(1, (until - now) / 600) : 0;
    const eased = raw * raw * (3 - 2 * raw);
    const kick = 1 + 0.42 * eased;
    const scale = placement.radius * breathe * kick * (selected ? 1.25 : 1);
    mesh.current.scale.setScalar(scale);
    mesh.current.rotation.y += dt * 0.12;
    if (atmo.current) atmo.current.scale.setScalar(scale * 1.34);

    const mat = mesh.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = (0.22 + (node.signalScore / 100) * (hot ? 1.3 : 0.6) + (selected ? 0.8 : 0)) * (1 + eased * 0.6);
    // the rim tracks signal strength, so the strongest ideas are the ones that
    // glow at the edges — and flares briefly when a trade lands. Reached through
    // the material ref: the memoized uniforms object is a hook argument and the
    // compiler (rightly) refuses direct mutation of it.
    const am = atmoMat.current;
    if (am) am.uniforms.uIntensity.value = 0.28 + (node.signalScore / 100) * 0.72 + (selected ? 0.5 : 0) + eased * 0.9;
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
        <meshStandardMaterial color={color} emissive={emissive} roughness={0.42} metalness={0.22} />
      </mesh>
      {/* silhouette rim — the single change that turns matte spheres into bodies */}
      <mesh ref={atmo} scale={placement.radius * 1.34} raycast={() => null}>
        <sphereGeometry args={[1, 20, 20]} />
        <shaderMaterial
          ref={atmoMat}
          uniforms={atmoUniforms}
          vertexShader={ATMO_VERT}
          fragmentShader={ATMO_FRAG}
          transparent
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
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
      {settings.riskOverlay && node.riskHigh && <RiskHalo radius={placement.radius} phase={phase} />}
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

  useFrame(({ clock }, dt) => {
    group.current?.position.lerp(target, Math.min(1, dt * 2.2));
    if (inner.current) {
      const until = pulsesRef.current.get(node.id) ?? 0;
      const now = Date.now();
      const raw = until > now ? Math.min(1, (until - now) / 600) : 0;
      const eased = raw * raw * (3 - 2 * raw);
      inner.current.scale.setScalar(placement.radius * (1 + 0.5 * eased) * (selected ? 1.6 : 1));
      // smart money turns slowly — the facets catch the rim light and read as
      // cut crystal rather than a white blob
      if (smart) {
        inner.current.rotation.y += dt * 0.5;
        inner.current.rotation.x = Math.sin(clock.elapsedTime * 0.4) * 0.25;
      }
      const m = inner.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = (smart ? 0.78 : 0.42) + eased * 0.9;
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
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={smart ? 0.78 : 0.42}
          roughness={smart ? 0.22 : 0.45}
          metalness={smart ? 0.5 : 0.15}
          flatShading={smart}
        />
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

/** WebGL contexts die for reasons outside the app's control — a driver reset, a
 *  GPU process restart, the tab being backgrounded too long. Three does not
 *  recover on its own, so the panel stayed black for the rest of the session.
 *  Calling preventDefault on the lost event is what makes the browser willing
 *  to hand the context back; on restore we re-render the frame. */
function ContextGuard({ onLost }: { onLost?: (lost: boolean) => void }) {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault();
      onLost?.(true);
    };
    const restored = () => {
      onLost?.(false);
      invalidate();
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    };
  }, [gl, invalidate, onLost]);
  return null;
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
  const [glLost, setGlLost] = useState(false);
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
      {glLost && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center"
          style={{ background: "rgba(4,6,10,0.82)" }}
        >
          <div className="panel-title">3D context interrupted</div>
          <div className="text-[12px] dim max-w-[280px]">
            The graphics context was reset. It restores automatically — reload the page if this persists.
          </div>
        </div>
      )}
      <Canvas
        camera={{ position: [0, 22, 52], fov: 50 }}
        dpr={mobile ? [1, 1.25] : [1, 1.75]}
        gl={{ antialias: !mobile, powerPreference: "high-performance" }}
        onPointerMissed={() => onSelect(null, null)}
      >
        <color attach="background" args={["#04060a"]} />
        {/* tighter falloff: distance now reads as depth instead of every node
            sitting on one flat plane */}
        <fog attach="fog" args={["#04060a", 52, 158]} />
        <ambientLight intensity={0.22} />
        <pointLight position={[0, 34, 8]} intensity={650} color="#9fd8ff" />
        <pointLight position={[42, -22, 42]} intensity={320} color="#8b7cff" />
        <pointLight position={[-46, 10, -30]} intensity={220} color="#38e1ff" />
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
        <ContextGuard onLost={setGlLost} />
        <QualityGovernor budgetRef={budgetRef} onFps={onFps} onDegrade={onDegrade} />
        {fx && (
          <EffectComposer multisampling={0}>
            {/* threshold raised with the new rim light so only genuinely hot
                nodes bloom — at 0.32 the whole field washed out */}
            <Bloom intensity={1.05} luminanceThreshold={0.42} luminanceSmoothing={0.22} mipmapBlur radius={0.78} />
            <Vignette eskil={false} offset={0.22} darkness={0.62} />
          </EffectComposer>
        )}
      </Canvas>
    </div>
  );
}

"use client";

// GalaxyScene — the dedicated 3D module.
//
// Owns the camera, the render loop policy and the composition of every visual
// layer. The React surface above it (Network3D) only passes data in and
// selection out, so the page never touches three.js directly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { layoutNetwork, type NetworkPayload, type SceneMode } from "../graph";
import { TokenField, type HoverInfo } from "./TokenField";
import { Trails } from "./Trails";
import { WhaleArcs } from "./WhaleArcs";
import { Starfield, HeatRing } from "./Ambience";
import { SignalPods } from "./SignalPods";
import { WalletField } from "./WalletField";

export interface GalaxySettings {
  mode: SceneMode;
  particles: boolean;
  labels: boolean;
  trails: boolean;
  riskOverlay: boolean;
  autoRotate: boolean;
  speed: number;
  wireframe?: boolean;
  pods?: boolean;
}

/** Market temperature: how much of the tracked universe is currently running
 *  hot. Drives the heat ring's gradient. Derived, never invented. */
export function marketTemperature(payload: NetworkPayload): number {
  if (!payload.tokens.length) return 0.5;
  const mean = payload.tokens.reduce((a, t) => a + t.signalScore, 0) / payload.tokens.length;
  return THREE.MathUtils.clamp((mean - 30) / 45, 0, 1);
}

/* ------------------------------------------------------------ camera rig */

function CameraRig({
  focus,
  autoRotate,
  resetSignal,
  speed,
}: {
  focus: THREE.Vector3 | null;
  autoRotate: boolean;
  resetSignal: number;
  speed: number;
}) {
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null);
  const seen = useRef(resetSignal);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c || dt > 0.1) return;
    if (seen.current !== resetSignal) {
      seen.current = resetSignal;
      c.reset();
    }
    // easing the target rather than snapping keeps focus changes cinematic
    if (focus) c.target.lerp(focus, 0.06);
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.075}
      maxDistance={150}
      minDistance={5}
      // a user drag always wins; auto-orbit resumes only when nothing is focused
      autoRotate={autoRotate && !focus}
      autoRotateSpeed={0.32 * (speed || 0)}
    />
  );
}

/* ------------------------------------------------- adaptive quality governor */

/**
 * No fixed FPS target: this watches the frame-time trend and sheds the most
 * expensive things first (post-processing, then pixel ratio) so motion stays
 * smooth on whatever hardware it lands on. Degradation is sticky — oscillating
 * between quality tiers is more distracting than sitting one tier lower.
 */
function QualityGovernor({
  onFps,
  onTier,
}: {
  onFps?: (fps: number) => void;
  onTier: (tier: number) => void;
}) {
  const { setDpr } = useThree();
  const acc = useRef({ t: 0, frames: 0, tier: 2 });

  useFrame((_, dt) => {
    if (dt > 0.1) return;
    const a = acc.current;
    a.t += dt;
    a.frames++;
    if (a.t < 1.2) return;

    const fps = a.frames / a.t;
    onFps?.(fps);
    a.t = 0;
    a.frames = 0;

    if (fps < 30 && a.tier > 0) {
      a.tier -= 1;
      onTier(a.tier);
      if (a.tier === 1) setDpr(Math.min(1.25, typeof window !== "undefined" ? window.devicePixelRatio : 1));
      if (a.tier === 0) setDpr(1);
    }
  });

  return null;
}

/* --------------------------------------------------------- context guard */

function ContextGuard({ onLost }: { onLost: (lost: boolean) => void }) {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault();
      onLost(true);
    };
    const restored = () => {
      onLost(false);
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

/* ------------------------------------------------------------------ scene */

export function GalaxyScene({
  payload,
  settings,
  selectedId,
  onSelect,
  burstsRef,
  onFps,
  onContextLost,
  resetSignal = 0,
  mobile = false,
}: {
  payload: NetworkPayload;
  settings: GalaxySettings;
  selectedId: string | null;
  onSelect: (id: string | null, kind: "token" | "wallet" | null) => void;
  burstsRef: React.MutableRefObject<{ from: string; to: string; sell: boolean; usd: number }[]>;
  onFps?: (fps: number) => void;
  onContextLost: (lost: boolean) => void;
  resetSignal?: number;
  mobile?: boolean;
}) {
  const placements = useMemo(() => layoutNetwork(payload, settings.mode), [payload, settings.mode]);
  const pulsesRef = useRef<Map<string, number>>(new Map());
  const [, setHover] = useState<HoverInfo | null>(null);

  // tier 2 = full (post fx), 1 = no post fx, 0 = minimum
  const [tier, setTier] = useState(mobile ? 1 : 2);
  const onTier = useCallback((t: number) => setTier(t), []);

  const temperature = useMemo(() => marketTemperature(payload), [payload]);

  const focus = useMemo(() => {
    if (!selectedId) return null;
    const p = placements.get(selectedId);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  }, [selectedId, placements]);

  // drain SSE bursts into arrival pulses so a live whale move lights the coin
  // it lands on even when the arc layer is switched off
  useFrame(() => {
    const q = burstsRef.current;
    while (q.length) {
      const b = q.shift()!;
      pulsesRef.current.set(b.sell ? b.from : b.to, Date.now() + 600);
    }
  });

  return (
    <>
      <color attach="background" args={["#04060a"]} />
      <fog attach="fog" args={["#04060a", 52, 168]} />
      <ambientLight intensity={0.24} />
      <pointLight position={[0, 34, 8]} intensity={650} color="#9fd8ff" />
      <pointLight position={[42, -22, 42]} intensity={320} color="#8b7cff" />
      <pointLight position={[-46, 10, -30]} intensity={220} color="#38e1ff" />

      <Starfield count={mobile ? 3500 : 10000} />
      <HeatRing temperature={temperature} radius={44} />

      <TokenField
        payload={payload}
        placements={placements}
        selectedId={selectedId}
        onSelect={onSelect}
        pulsesRef={pulsesRef}
        speed={settings.speed}
        wireframe={settings.wireframe ?? !mobile}
        onHoverChange={setHover}
      />

      <WalletField
        payload={payload}
        placements={placements}
        selectedId={selectedId}
        onSelect={onSelect}
        pulsesRef={pulsesRef}
        speed={settings.speed}
      />

      <Trails payload={payload} placements={placements} enabled={settings.trails && tier > 0} speed={settings.speed} />
      <WhaleArcs
        payload={payload}
        placements={placements}
        enabled={settings.particles}
        speed={settings.speed}
      />

      {settings.pods !== false && tier > 0 && (
        <SignalPods payload={payload} placements={placements} onSelect={onSelect} enabled={settings.labels} />
      )}

      <CameraRig focus={focus} autoRotate={settings.autoRotate} resetSignal={resetSignal} speed={settings.speed} />
      <ContextGuard onLost={onContextLost} />
      <QualityGovernor onFps={onFps} onTier={onTier} />

      {tier >= 2 && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={1.05} luminanceThreshold={0.42} luminanceSmoothing={0.22} mipmapBlur radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.62} />
        </EffectComposer>
      )}
    </>
  );
}

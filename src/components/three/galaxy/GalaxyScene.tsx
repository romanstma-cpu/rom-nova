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

/** Seconds for one full revolution at speed 1 — slow enough to read a label off
 *  a coin without chasing it, fast enough that the scene is alive. */
export const ORBIT_PERIOD_SEC = 120;
const ORBIT_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Radians to advance the auto-orbit for a frame of `dt` seconds.
 *
 * Exported and pure so the frame-rate independence can actually be asserted:
 * the bug this replaced was OrbitControls' `autoRotateSpeed`, which advances a
 * fixed angle per *frame* and therefore ran 2.4× faster on a 144Hz display than
 * on a 60Hz one.
 */
export function orbitStep(dt: number, speed: number): number {
  return ((2 * Math.PI) / ORBIT_PERIOD_SEC) * (speed || 0) * dt;
}

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
  const arm = useRef(new THREE.Vector3());

  useFrame(({ camera }, dt) => {
    const c = controls.current;
    if (!c || dt > 0.1) return;
    if (seen.current !== resetSignal) {
      seen.current = resetSignal;
      c.reset();
    }
    // easing the target rather than snapping keeps focus changes cinematic
    if (focus) c.target.lerp(focus, 0.06);

    // The orbit is driven here, from elapsed time, instead of by OrbitControls'
    // own autoRotate. three-stdlib advances a FIXED angle per frame —
    // `2π/60/60 × autoRotateSpeed`, a hard-coded 60fps assumption — so the same
    // setting spun 2.4× faster on a 144Hz display than on a 60Hz one, with no
    // setting that could be correct on both.
    if (autoRotate && !focus) {
      arm.current
        .copy(camera.position)
        .sub(c.target)
        .applyAxisAngle(ORBIT_AXIS, -orbitStep(dt, speed));
      camera.position.copy(c.target).add(arm.current);
    }

    // Deliberately no c.update() here. drei's OrbitControls already calls it
    // every frame at priority -1; calling it again double-stepped both the
    // damping and the auto-rotation, which is the other half of why the scene
    // span too fast.
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.075}
      maxDistance={150}
      minDistance={5}
      autoRotate={false}
    />
  );
}

/* ------------------------------------------------- adaptive quality governor */

/**
 * No fixed FPS target: this watches the frame-time trend and sheds the most
 * expensive things first (post-processing, then pixel ratio) so motion stays
 * smooth on whatever hardware it lands on.
 *
 * It used to demote on a single bad window and never climb back. The first
 * window is also the one that contains shader compilation, texture upload and
 * the PMREM bake, so a perfectly capable GPU could be measured mid-warm-up,
 * dropped to dpr 1, and left there — looking permanently soft — for the rest
 * of the session. Now: warm-up windows are ignored, demotion needs two bad
 * windows in a row, and the tier climbs back after a sustained good run. The
 * thresholds are far apart (shed under 30, restore over 52) so the hysteresis
 * still cannot oscillate.
 */
function QualityGovernor({
  onFps,
  onTier,
  maxDpr,
}: {
  onFps?: (fps: number) => void;
  onTier: (tier: number) => void;
  maxDpr: number;
}) {
  const { setDpr } = useThree();
  const acc = useRef({ t: 0, frames: 0, tier: 2, windows: 0, slow: 0, fast: 0 });

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
    a.windows++;

    // Warm-up: measuring these is measuring the compiler, not the GPU.
    if (a.windows <= 2) return;

    if (fps < 30) {
      a.slow++;
      a.fast = 0;
    } else if (fps > 52) {
      a.fast++;
      a.slow = 0;
    } else {
      a.slow = 0;
      a.fast = 0;
    }

    const applyDpr = (tier: number) => {
      if (tier >= 2) setDpr(maxDpr);
      else if (tier === 1) setDpr(Math.min(1.5, maxDpr));
      else setDpr(1);
    };

    if (a.slow >= 2 && a.tier > 0) {
      a.tier -= 1;
      a.slow = 0;
      onTier(a.tier);
      applyDpr(a.tier);
      return;
    }

    if (a.fast >= 5 && a.tier < 2) {
      a.tier += 1;
      a.fast = 0;
      onTier(a.tier);
      applyDpr(a.tier);
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

  // The ceiling the governor restores to, matching the Canvas's own dpr cap so
  // a recovery can never ask for more resolution than the canvas was set up for.
  const maxDpr = useMemo(() => {
    const native = typeof window === "undefined" ? 1 : window.devicePixelRatio;
    return mobile ? Math.min(1.25, native) : Math.min(2, native);
  }, [mobile]);

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
      {/* Point lights fall off with the square of distance, and the field sits
          30-45 units from each of these — so a 650 key was delivering roughly
          half a unit of light by the time it arrived and the shells came out
          charcoal. Raised to give them actual form, plus a directional key that
          does not fall off at all, which is what makes a sphere read as a
          sphere rather than a flat disc. */}
      <ambientLight intensity={0.34} />
      <directionalLight position={[18, 30, 24]} intensity={1.5} color="#cfe9ff" />
      <pointLight position={[0, 34, 8]} intensity={1700} color="#9fd8ff" />
      <pointLight position={[42, -22, 42]} intensity={900} color="#8b7cff" />
      <pointLight position={[-46, 10, -30]} intensity={700} color="#38e1ff" />

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
      <QualityGovernor onFps={onFps} onTier={onTier} maxDpr={maxDpr} />

      {tier >= 2 && (
        // multisampling was 0, which is the whole reason the scene looked soft:
        // the composer renders into its own off-screen buffer, so the canvas's
        // `antialias: true` does nothing once post-processing is on, and 0
        // turned it off in the buffer too. Every edge in the scene was raw
        // aliased pixels, then bloom smeared them. 4 is plenty here and costs
        // far less than the library's default of 8.
        <EffectComposer multisampling={4}>
          {/* 0.42 bloomed anything above 42% luminance, which was very nearly
              everything, so the glow stopped reading as glow and became a haze
              over the whole image. 0.62 went too far the other way and left
              the hot coins with no glow at all. 0.52 is the line where only
              emissive rims and bright cores cross it. */}
          <Bloom intensity={1.0} luminanceThreshold={0.52} luminanceSmoothing={0.2} mipmapBlur radius={0.62} />
          <Vignette eskil={false} offset={0.24} darkness={0.58} />
        </EffectComposer>
      )}
    </>
  );
}

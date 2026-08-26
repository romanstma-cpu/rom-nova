"use client";

// Public surface for the 3D scene. Owns the <Canvas>, the renderer policy and
// the loss/fallback UI; every visual layer lives in ./galaxy, so pages never
// touch three.js directly.

import { useCallback, useState } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import type { NetworkPayload, SceneMode } from "./graph";
import { GalaxyScene, type GalaxySettings } from "./galaxy/GalaxyScene";

export type { SceneMode };

/** Kept as the historical name so existing pages import unchanged. */
export type SceneSettings = GalaxySettings;

interface SelectHandler {
  (id: string | null, kind: "token" | "wallet" | null): void;
}

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
  const [glLost, setGlLost] = useState(false);
  const onContextLost = useCallback((lost: boolean) => setGlLost(lost), []);

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
        // Cap the pixel ratio: a 3x phone screen quadruples the fragment cost
        // for detail nobody can resolve. The governor may lower it further.
        dpr={mobile ? [1, 1.25] : [1, Math.min(2, typeof window === "undefined" ? 2 : window.devicePixelRatio)]}
        gl={{ antialias: !mobile, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
        onPointerMissed={() => onSelect(null, null)}
      >
        <GalaxyScene
          payload={payload}
          settings={settings}
          selectedId={selectedId}
          onSelect={onSelect}
          burstsRef={burstsRef}
          onFps={onFps}
          onContextLost={onContextLost}
          resetSignal={resetSignal}
          mobile={mobile}
        />
      </Canvas>
    </div>
  );
}

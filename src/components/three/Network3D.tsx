"use client";

// Public surface for the 3D scene. Owns the <Canvas>, the renderer policy and
// the loss/fallback UI; every visual layer lives in ./galaxy, so pages never
// touch three.js directly.

import { useCallback, useState, useSyncExternalStore } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { isWebGLFailure } from "@/lib/error-report";
import type { NetworkPayload, SceneMode } from "./graph";
import { GalaxyScene, type GalaxySettings } from "./galaxy/GalaxyScene";

// A machine without WebGL — remote desktop, some virtual machines, a
// hardened browser profile — used to get an empty black panel and an
// unhandled rejection in the console. The fibre builds its renderer inside
// a promise, so the failure never reaches a React boundary (measured: with
// getContext returning null the page rendered its HUD over nothing and the
// boundary below stayed silent). So the context is probed BEFORE <Canvas>
// mounts, once per tab, and a machine that cannot draw gets this panel
// instead of a scene that was never going to appear.
type GlSupport = "unknown" | "yes" | "no";
let glCached: GlSupport | null = null;

/**
 * One probe of the browser's WebGL support. The canvas arrives as an argument
 * so the suite can hand this the two answers no real browser gives on demand:
 * a getContext that returns null, and one that throws — a hardened profile
 * blocks the call rather than failing it, and an unguarded probe there takes
 * the page down instead of the scene.
 */
export function probeGl(makeCanvas: () => HTMLCanvasElement = () => document.createElement("canvas")): GlSupport {
  try {
    const probe = makeCanvas();
    const ctx = (probe.getContext("webgl2") ?? probe.getContext("webgl")) as WebGLRenderingContext | null;
    // Hand the slot back: browsers cap live contexts at around sixteen.
    ctx?.getExtension("WEBGL_lose_context")?.loseContext();
    return ctx ? "yes" : "no";
  } catch {
    return "no";
  }
}

function readGlSupport(): GlSupport {
  if (glCached) return glCached;
  glCached = probeGl();
  return glCached;
}
const readGlSupportServer = (): GlSupport => "unknown";
const subscribeNever = () => () => {};

function NoScene({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center p-4" style={{ background: "rgba(4,6,10,0.82)" }}>
      <div className="panel-title">3D unavailable here</div>
      <div className="text-[12px] dim max-w-[300px]">{detail}</div>
      <button type="button" className="btn text-[10.5px]" onClick={onRetry}>
        try again
      </button>
    </div>
  );
}

// Deliberately not the page boundary's wording. describeError's WebGL advice
// ends "Every other page works without it", which is a sentence about a page
// that is broken; this panel covers one scene inside a page whose other panels
// are still reading, so it says that instead. Only the test the two surfaces
// apply is shared, never the words.
export const NO_GL_DETAIL =
  "This browser could not create a WebGL context — common over remote desktop, in virtual machines and in hardened profiles. Everything else on this page works without it.";

/**
 * What the panel says about a scene that threw. Whether a failure is the
 * browser refusing 3D has one owner — isWebGLFailure in src/lib/error-report.ts,
 * which the page boundary already asks and the suite already tests. This file
 * used to answer it a second time with its own regex over the message alone,
 * so an error carrying the marker in `name` read as WebGL on the boundary and
 * as an unexplained crash here. Pure and exported because the node suite
 * cannot render a boundary to read this string off the panel.
 */
export function sceneFailureDetail(error: unknown): string {
  const like = error instanceof Error ? error : { message: String(error) };
  return isWebGLFailure(like) ? NO_GL_DETAIL : `The scene failed to build: ${like.message}`;
}

// The boundary still stands for the synchronous case: a layer throwing over
// a payload it did not expect takes the scene, not the page.
function SceneFallback(_props: object, { error, retry }: ErrorInfo) {
  return <NoScene detail={sceneFailureDetail(error)} onRetry={() => retry()} />;
}
const SceneBoundary = catchError(SceneFallback);

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
  // Re-probing after a retry: clearing the cache makes the next read ask
  // the browser again, and the state bump is what causes that read.
  const [, setProbeAttempt] = useState(0);
  const glSupport = useSyncExternalStore(subscribeNever, readGlSupport, readGlSupportServer);
  const reprobe = () => {
    glCached = null;
    setProbeAttempt((n) => n + 1);
  };

  if (glSupport === "no") {
    return (
      <div className={className}>
        <NoScene detail={NO_GL_DETAIL} onRetry={reprobe} />
      </div>
    );
  }

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
      <SceneBoundary>
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
      </SceneBoundary>
    </div>
  );
}

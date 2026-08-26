"use client";

// Signal pods — the top-conviction coins get a floating card pinned above them
// with symbol, score and a confidence ring.
//
// drei's <Html> rather than CSS2DRenderer: R3F already owns the render loop and
// the canvas, and mounting a second renderer alongside it means two DOM trees
// fighting over the same overlay. Html gives the same billboarded-DOM result
// through the existing loop, with occlusion and distance falloff for free.
//
// Deliberately capped at a handful of pods. One per coin is 64 cards orbiting
// a 64-node field — unreadable, and it buries the thing they annotate.

import { useMemo } from "react";
import { Html } from "@react-three/drei";
import type { NetworkPayload, NodePlacement } from "../graph";

const MAX_PODS = 5;
/** Below this the coin has not earned a card. */
const MIN_SCORE = 58;

export function SignalPods({
  payload,
  placements,
  onSelect,
  enabled,
}: {
  payload: NetworkPayload;
  placements: Map<string, NodePlacement>;
  onSelect: (id: string | null, kind: "token" | "wallet" | null) => void;
  enabled: boolean;
}) {
  const pods = useMemo(
    () =>
      [...payload.tokens]
        .filter((t) => t.signalScore >= MIN_SCORE)
        .sort((a, b) => b.signalScore - a.signalScore)
        .slice(0, MAX_PODS)
        .map((t) => ({ token: t, place: placements.get(t.id) }))
        .filter((p) => p.place),
    [payload.tokens, placements],
  );

  if (!enabled || !pods.length) return null;

  return (
    <>
      {pods.map(({ token, place }) => {
        const p = place!;
        const pct = Math.min(100, Math.max(0, token.signalScore));
        return (
          <Html
            key={token.id}
            position={[p.x, p.y + p.radius + 2.4, p.z]}
            center
            distanceFactor={30}
            zIndexRange={[15, 0]}
            occlude={false}
          >
            <button
              type="button"
              className="galaxy-pod"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(token.id, "token");
              }}
            >
              <span className="galaxy-pod-ring" style={{ ["--pct" as string]: `${pct}` }}>
                <span className="galaxy-pod-score">{token.signalScore}</span>
              </span>
              <span className="galaxy-pod-body">
                <span className="galaxy-pod-sym">{token.symbol}</span>
                <span className={`galaxy-pod-mom ${token.momentum24h >= 0 ? "pos" : "neg"}`}>
                  {token.momentum24h >= 0 ? "+" : ""}
                  {token.momentum24h.toFixed(1)}%
                </span>
              </span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

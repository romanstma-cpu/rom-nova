"use client";

// What the picture means.
//
// The scene encodes four independent variables — market cap in the sphere's
// size, signal score in its colour, whale flow direction in the arc colour,
// and risk in the halo — and until this existed it explained none of them. An
// audit at 1440px found roughly sixty spheres of near-identical blue with two
// labels between them and nothing anywhere on the page saying what any of it
// meant. Beautiful and undecodable is a worse outcome than plain.
//
// Position is deliberately described per scene mode, because it is the one
// channel whose meaning changes: in Signal Galaxy distance from the centre is
// the score, in Whale Clusters it is co-ownership, and in Whale Universe it is
// nothing at all. A legend that claimed one meaning for all five would be
// wrong in four of them.

import { SLATE, CYAN, HOT } from "./galaxy/materials";
import type { SceneMode } from "./graph";

/** Sampled from the same ramp the shader uses, so the swatch cannot drift. */
function ramp(stops: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < stops; i++) {
    const score = 35 + (55 * i) / (stops - 1);
    const t = Math.min(1, Math.max(0, (score - 35) / 55));
    const c = SLATE.clone().lerp(CYAN, Math.pow(t, 1.35));
    if (score >= 88) c.lerp(HOT, 0.5);
    out.push(`#${c.getHexString()}`);
  }
  return out;
}

const POSITION: Record<SceneMode, string> = {
  universe: "scattered — position carries nothing here",
  flow: "sorted by net whale flow, buyers to one side",
  constellation: "linked coins drawn together",
  clusters: "wallets that trade alike, grouped",
  signals: "distance from the centre is the score — strongest nearest",
};

export function Legend({ mode, open, onToggle }: { mode: SceneMode; open: boolean; onToggle: () => void }) {
  const stops = ramp(7);

  return (
    <div className="galaxy-legend panel">
      <button type="button" className="galaxy-legend-head" onClick={onToggle} aria-expanded={open}>
        <span className="panel-title">What you are looking at</span>
        <span className="galaxy-legend-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="galaxy-legend-body">
          <div className="galaxy-legend-row">
            <span className="galaxy-legend-key">
              <span className="galaxy-dot sm" />
              <span className="galaxy-dot md" />
              <span className="galaxy-dot lg" />
            </span>
            <span className="galaxy-legend-text">
              <b>Size</b> is market cap
            </span>
          </div>

          <div className="galaxy-legend-row">
            <span className="galaxy-legend-key">
              <span
                className="galaxy-ramp"
                style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }}
              />
            </span>
            <span className="galaxy-legend-text">
              <b>Colour</b> is the signal score — slate 35, cyan 90
            </span>
          </div>

          <div className="galaxy-legend-row">
            <span className="galaxy-legend-key">
              <span className="galaxy-arc buy" />
              <span className="galaxy-arc sell" />
            </span>
            <span className="galaxy-legend-text">
              <b>Arcs</b> are whale money — mint in, pink out
            </span>
          </div>

          <div className="galaxy-legend-row">
            <span className="galaxy-legend-key">
              <span className="galaxy-halo" />
            </span>
            <span className="galaxy-legend-text">
              <b>Red halo</b> flags a risk the scanner raised
            </span>
          </div>

          <div className="galaxy-legend-row">
            <span className="galaxy-legend-key">
              <span className="galaxy-pos" />
            </span>
            <span className="galaxy-legend-text">
              <b>Position</b>: {POSITION[mode]}
            </span>
          </div>

          <p className="galaxy-legend-foot">
            Cards appear above the five strongest only. Click any sphere for the rest.
          </p>
        </div>
      )}
    </div>
  );
}

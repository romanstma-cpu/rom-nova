// Layout math for the 3D network. Pure functions — position targets are
// derived from the API payload and the active scene mode; the scene lerps
// nodes toward these targets so mode changes glide instead of snapping.

export interface NetTokenNode {
  id: string;
  kind: "token";
  symbol: string;
  narrative: string;
  hue: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  momentum24h: number;
  signalScore: number;
  riskHigh: boolean;
}

export interface NetWalletNode {
  id: string;
  kind: "wallet";
  entity?: string;
  labels: string[];
  smartMoneyScore: number;
  solBalance: number;
  cluster: string | null;
}

export interface NetEdge {
  from: string;
  to: string;
  kind: "position" | "buy" | "sell";
  usd: number;
  ts: number;
}

export interface NetworkPayload {
  asOf: number;
  historical: boolean;
  tokens: NetTokenNode[];
  wallets: NetWalletNode[];
  edges: NetEdge[];
  clusters: { id: string; name: string; members: string[] }[];
}

export type SceneMode = "universe" | "flow" | "constellation" | "clusters" | "signals";

export interface NodePlacement {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function tokenRadius(n: NetTokenNode): number {
  return 0.4 + Math.min(1.35, Math.log10(Math.max(n.marketCapUsd, 10_000)) / 5.2);
}

function walletRadius(n: NetWalletNode): number {
  const whale = n.labels.includes("whale") || n.labels.includes("fund");
  return whale ? 0.42 : 0.26;
}

export function layoutNetwork(payload: NetworkPayload, mode: SceneMode): Map<string, NodePlacement> {
  const out = new Map<string, NodePlacement>();
  const tokens = payload.tokens;
  const wallets = payload.wallets;

  if (mode === "constellation") {
    // group tokens by narrative into separate constellations on a wide ring
    const narratives = [...new Set(tokens.map((t) => t.narrative))].sort();
    const perN = new Map<string, NetTokenNode[]>();
    for (const t of tokens) {
      const arr = perN.get(t.narrative) ?? [];
      arr.push(t);
      perN.set(t.narrative, arr);
    }
    narratives.forEach((nar, ni) => {
      const angle = (ni / narratives.length) * Math.PI * 2;
      const cx = Math.cos(angle) * 26;
      const cz = Math.sin(angle) * 26;
      const members = perN.get(nar)!;
      members.forEach((t, i) => {
        const a = i * GOLDEN;
        const r = 1.8 * Math.sqrt(i + 0.5);
        out.set(t.id, {
          id: t.id,
          x: cx + Math.cos(a) * r,
          y: Math.sin(i * 2.4) * 2.2,
          z: cz + Math.sin(a) * r,
          radius: tokenRadius(t),
        });
      });
    });
  } else if (mode === "signals") {
    // signal galaxy: high scores near the luminous center, weak scores far out
    const sorted = [...tokens].sort((a, b) => b.signalScore - a.signalScore);
    sorted.forEach((t, i) => {
      const a = i * GOLDEN;
      const r = 3 + (1 - t.signalScore / 100) * 30;
      out.set(t.id, {
        id: t.id,
        x: Math.cos(a) * r,
        y: ((t.signalScore / 100) * 6 - 2) + Math.sin(a * 3) * 0.8,
        z: Math.sin(a) * r,
        radius: tokenRadius(t) * (0.7 + t.signalScore / 120),
      });
    });
  } else {
    // universe / flow / clusters: volume-ranked spiral disc with enough air
    // between planets that the structure reads as a system, not a pile
    const sorted = [...tokens].sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    sorted.forEach((t, i) => {
      const a = i * GOLDEN;
      const r = 4.5 + 3.1 * Math.sqrt(i);
      out.set(t.id, {
        id: t.id,
        x: Math.cos(a) * r,
        y: Math.sin(a * 2.1) * (2.2 + i * 0.07),
        z: Math.sin(a) * r,
        radius: tokenRadius(t),
      });
    });
  }

  // wallets: cluster members orbit their cluster anchor; the rest sit on an outer shell
  const clusterAnchors = new Map<string, { x: number; y: number; z: number }>();
  payload.clusters.forEach((c, i) => {
    const angle = (i / Math.max(1, payload.clusters.length)) * Math.PI * 2 + 0.7;
    const spread = mode === "clusters" ? 24 : 34;
    clusterAnchors.set(c.id, {
      x: Math.cos(angle) * spread,
      y: 7 + i * 2.5,
      z: Math.sin(angle) * spread,
    });
  });

  let solo = 0;
  const soloCount = wallets.filter((w) => !w.cluster).length;
  for (const w of wallets) {
    if (w.cluster && clusterAnchors.has(w.cluster)) {
      const anchor = clusterAnchors.get(w.cluster)!;
      const members = payload.clusters.find((c) => c.id === w.cluster)!.members;
      const idx = members.indexOf(w.id);
      const a = (idx / Math.max(1, members.length)) * Math.PI * 2;
      const orbitR = mode === "clusters" ? 4.5 : 2.6;
      out.set(w.id, {
        id: w.id,
        x: anchor.x + Math.cos(a) * orbitR,
        y: anchor.y + Math.sin(a * 2) * 0.9,
        z: anchor.z + Math.sin(a) * orbitR,
        radius: walletRadius(w) * (mode === "clusters" ? 1.5 : 1),
      });
    } else {
      const a = (solo / Math.max(1, soloCount)) * Math.PI * 2 + 0.35;
      const r = 38 + (solo % 3) * 4;
      out.set(w.id, {
        id: w.id,
        x: Math.cos(a) * r,
        y: -4 + (solo % 5) * 2.4,
        z: Math.sin(a) * r,
        radius: walletRadius(w),
      });
      solo++;
    }
  }

  return out;
}

export function edgeIntensity(e: NetEdge): number {
  return Math.min(1, Math.log10(Math.max(e.usd, 100)) / 6);
}

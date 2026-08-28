// Where the OpenRouter key lives, and the honest account of what that means.
//
// ROM Nova ships as a static site and an Electron shell around the same build.
// There is no server, so there is nowhere to keep a shared key — and a shared
// key would be the wrong answer anyway: baked into a public bundle it would be
// readable by every visitor within a minute of the first request.
//
// So the key is the USER'S, entered by them, kept in their own browser's
// localStorage, and sent to exactly one place: openrouter.ai. It is never
// transmitted to romapps.xyz, never logged, and never leaves the machine in
// any other direction. That is the same bargain ROM Trader already makes for
// the Kalshi key, minus the DPAPI vault that only the desktop app can offer.
//
// It is also genuinely optional. Every answer in this app is computed without
// it; the model only rewords what the engine already worked out.

const LS_KEY = "rom_nova_ai_v1";

/**
 * Free models on OpenRouter, verified against their live /models endpoint —
 * $0 prompt and $0 completion, no card required to use them.
 *
 * Ordered by how well they follow a short instruction, not by size. The task
 * is "reword this paragraph and invent nothing", which a small instruction
 * -tuned model does about as well as a large one and considerably faster.
 */
export const FREE_MODELS: { id: string; label: string; note: string }[] = [
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", note: "instruction-tuned, reliable phrasing — a good default" },
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", note: "smaller and quicker" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super", note: "larger, slower, more fluent" },
  { id: "minimax/minimax-m3:free", label: "MiniMax M3", note: "very large context" },
  { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron Lightning", note: "fastest of the free tier" },
];

export const DEFAULT_MODEL = FREE_MODELS[0].id;

export interface AiSettings {
  enabled: boolean;
  apiKey: string;
  model: string;
}

export const EMPTY_AI: AiSettings = { enabled: false, apiKey: "", model: DEFAULT_MODEL };

/**
 * An OpenRouter key looks like `sk-or-v1-…`. Checked so a pasted placeholder
 * or a stray quote is caught at entry rather than surfacing as a puzzling 401
 * three screens later.
 */
export function looksLikeKey(key: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9._-]{16,}$/.test(key.trim());
}

/** Never render a key in full — enough to recognise, not enough to use. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return "•".repeat(k.length);
  return `${k.slice(0, 10)}…${k.slice(-4)}`;
}

export function loadAi(): AiSettings {
  if (typeof localStorage === "undefined") return EMPTY_AI;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return EMPTY_AI;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      // A model that has since been retired or made paid falls back rather
      // than 404ing on every question.
      model: FREE_MODELS.some((m) => m.id === parsed.model) ? parsed.model! : DEFAULT_MODEL,
    };
  } catch {
    return EMPTY_AI;
  }
}

export function saveAi(settings: AiSettings): void {
  cached = settings;
  notify();
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch {
    // Private-browsing quota refusal. The feature is optional; losing the
    // setting must not break the page.
  }
}

export function clearAi(): void {
  cached = EMPTY_AI;
  notify();
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // as above
  }
}

// ------------------------------------------------------ reading it in React
//
// Settings live in localStorage, which does not exist during the prerender and
// does exist on hydration — so reading it in useState's initialiser renders one
// thing on the server and another in the browser, and reading it in an effect
// means calling setState from an effect, which the React Compiler rules
// correctly refuse. useSyncExternalStore is the shape built for exactly this:
// a server snapshot that is always EMPTY_AI, a client snapshot read once and
// cached, and a subscription so a save anywhere updates every reader.

let cached: AiSettings | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to settings changes. Returns the unsubscribe function. */
export function subscribeAi(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Client snapshot. Must return a STABLE reference between changes — rebuilding
 * the object on every call makes useSyncExternalStore re-render forever.
 */
export function getAiSnapshot(): AiSettings {
  if (cached === null) cached = loadAi();
  return cached;
}

/** Server snapshot: nothing is configured during a prerender, by definition. */
export function getAiServerSnapshot(): AiSettings {
  return EMPTY_AI;
}

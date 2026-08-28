// Shared helpers for the keyless providers.
//
// The demo universe assigns a narrative and a colour at generation time and
// knows both for certain. Real providers know neither: DEX Screener and
// GeckoTerminal return a name, a symbol and an address, so both have to be
// derived. Kept in one file because two copies of a classifier drift, and a
// token that is "Dogs" on the token list and "Community" in the 3D scene is a
// bug nobody would think to look for.

import type { Narrative } from "../types";

/**
 * Narrative guessed from the token's own name and symbol.
 *
 * Pattern matching on a ticker, and worth being honest about what that is
 * worth: it steers grouping and colour in the UI and feeds nothing that
 * scores. Ordered most specific first, so a "Doge AI Agent" lands in AI rather
 * than falling into Dogs on the first loose match.
 */
export function narrativeOf(name: string, symbol: string): Narrative {
  const s = `${name} ${symbol}`.toLowerCase();
  if (/(\bai\b|gpt|agent|neural|llm|model)/.test(s)) return "AI";
  if (/(defi|swap|lend|yield|stake|vault|perp|dex)/.test(s)) return "DeFi";
  if (/(game|play|quest|arena|pixel|craft)/.test(s)) return "Gaming";
  if (/(trump|biden|maga|elect|senate|potus|politic)/.test(s)) return "Politics";
  if (/(dog|inu|shib|bonk|wif|floki|corgi)/.test(s)) return "Dogs";
  if (/(cat|kitty|meow|paw|neko)/.test(s)) return "Cats";
  if (/(elon|musk|kanye|celeb|star)/.test(s)) return "Celebrity";
  if (/(pepe|wojak|chad|meme|lol|based|gm\b)/.test(s)) return "Internet";
  return "Community";
}

/**
 * A stable hue per mint, so the 3D scene can colour a token without a hosted
 * logo and without the colour changing between sessions.
 */
export function hueOf(mint: string): number {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) % 360;
  return h;
}

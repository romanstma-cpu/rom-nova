// The two numbers that decide what "smart money" and "a whale" mean, once.
//
// They were written five times. The whole-build review measured the result on
// one screen: the dashboard's "Smart $ Flow 24h" read -$2.34M with a smart
// wallet at `>= 70` in `marketState`, while `/flow` with the 24h button
// selected read "Smart money net" -$2.85M with the same wallet at `>= 65` in
// `buildFlowSeries` — same universe, same window, same label, 22% apart, and
// nothing on either page could say why. "Active Whales 24h" counted a trade
// at $25,000 while every other whale column in the app counted one at $20,000.
//
// A threshold that lives in one file is a definition. The same threshold in
// five files is five definitions that happen to agree today, and the review
// caught the day they stopped. Nothing in this file imports anything, so every
// side of the engine — the simulator, the live vector, the flow chart, the
// event stream — can read it without a cycle.

/**
 * A wallet whose smart-money composite reaches this is "smart" everywhere a
 * page says the words. Simulated wallets only: the live stack carries no
 * wallet reputation, and every live surface declares smart money UNMEASURED
 * rather than testing a score nobody computed against this number.
 */
export const SMART_MONEY_THRESHOLD = 65;

/**
 * A single movement of this many dollars is whale-sized, on every path.
 *
 * The live vector (`live-features.ts`) counts a wallet's net delta over its
 * flow window against this; the simulator's feature extractor, flow chart,
 * event classifier and research answers count a single trade against it. They
 * have to agree, or a live vector and a simulated one stop meaning the same
 * thing when they reach the scorer.
 */
export const WHALE_TRADE_USD = 20_000;

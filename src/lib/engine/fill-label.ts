// What one movement should be CALLED, in one place.
//
// The wallet page and the alert path each grew their own answer to this and
// gave different ones for the same fill. The page tested `priceUsd ===
// undefined` and printed IN/OUT; the alert tested `classification` and printed
// SELL. A real swap that fell through pricing (no SOL/USD bar covering that
// hour) therefore appeared as OUT on the page and "sold" in a notification —
// two surfaces, one fill, two claims.
//
// The two questions are genuinely different and both matter:
//
//   WAS IT A TRADE?  classification. A rotation is a trade nobody could price.
//   DO WE KNOW WHAT IT WAS WORTH?  pricing. A priced sale is a sale.
//
// So the label answers the first and the pricing note answers the second, and
// nothing infers one from the other.

import type { TradeClassification } from "../types";

export interface LabelledMovement {
  side: "buy" | "sell";
  classification?: TradeClassification;
  /** Undefined when nothing could price it. */
  priceUsd?: number;
}

export interface MovementLabel {
  /** Column/headline word: BUY, SELL, IN, OUT, ROTATE, LP. */
  short: string;
  /** Sentence verb: "bought", "sent", "swapped"… */
  verb: string;
  /**
   * The clause that may follow, or "" — present ONLY for a movement nobody
   * paid for. A rotation is unpriced and still a trade, so it gets no such
   * clause; saying "nothing was paid or received" over a token-for-token swap
   * contradicts the reason printed beside it.
   */
  note: string;
}

export function movementLabel(f: LabelledMovement): MovementLabel {
  const inbound = f.side === "buy";
  switch (f.classification) {
    case "transfer":
      // The only case where "nobody paid" is established rather than assumed.
      return {
        short: inbound ? "IN" : "OUT",
        verb: inbound ? "received" : "sent",
        note: " — a transfer, not a trade: nothing was paid or received for it.",
      };
    case "rotate":
      return {
        short: "ROTATE",
        verb: inbound ? "swapped into" : "swapped out of",
        note: " — a token-for-token swap, real but unpriceable from a browser.",
      };
    case "lp":
      return {
        short: "LP",
        verb: inbound ? "withdrew" : "deposited",
        note: " — a pool position, not a trade: the two legs moved the same way.",
      };
    case "unknown":
      return {
        short: inbound ? "IN" : "OUT",
        verb: inbound ? "received" : "sent",
        // Deliberately no claim either way. The chain read could not tell a
        // payment from account rent, and an ambiguity must not be resolved by
        // whichever sentence reads better.
        note: " — what was paid for it, if anything, could not be determined.",
      };
    default:
      // open / add / reduce / exit — a trade the reader can take at face value.
      return { short: inbound ? "BUY" : "SELL", verb: inbound ? "bought" : "sold", note: "" };
  }
}

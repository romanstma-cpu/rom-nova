"use client";

// The reader's own wallet address, remembered in this browser — an address
// and nothing else. No key, no signature, no connection: it is the one
// they paste on the wallet page and ask to be remembered, so the page can
// offer "my wallet" instead of a paste every time.

const KEY = "whalenova_my_wallet_v1";
const PLAUSIBLE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const listeners = new Set<() => void>();
let cached: string | null = null;

function read(): string {
  if (cached !== null) return cached;
  try {
    const v = typeof localStorage === "undefined" ? "" : (localStorage.getItem(KEY) ?? "");
    cached = PLAUSIBLE.test(v) ? v : "";
  } catch {
    cached = "";
  }
  return cached;
}

export const myWalletSnapshot = (): string => read();
export const myWalletServer = (): string => "";

export function subscribeMyWallet(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Remember an address, or forget it with null or "". */
export function setMyWallet(address: string | null): void {
  const v = address && PLAUSIBLE.test(address) ? address : "";
  cached = v;
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage — remembered for this page load */
  }
  for (const l of listeners) l();
}

/** Tests only. */
export function resetMyWallet(): void {
  cached = null;
}

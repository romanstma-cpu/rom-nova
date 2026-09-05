import Link from "next/link";

export const metadata = { title: "Disclaimer & Privacy" };

export default function LegalPage() {
  return (
    <div className="p-4 max-w-[760px] flex flex-col gap-4">
      <h1 className="text-[16px] font-semibold tracking-wide">DISCLAIMER &amp; PRIVACY</h1>

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">What this is</h2>
        <p>
          ROM Nova is an <b className="text-[var(--text)]">analytics demonstration</b>: a Solana-style intelligence terminal
          that shows how explainable signal scoring, whale tracking, backtesting and risk analysis can work. It is an
          educational and research tool, not a brokerage, exchange, or advisory service.
        </p>
      </section>

      {/* This section used to be headed "The data is simulated" and said the SOL
          reference price was "the single live number". That was true when it was
          written and has been progressively falser ever since — and a page that
          tells a reader real chain data is fake is not a cautious error, it is
          the same drift as the opposite one, teaching people to ignore the
          labels that still matter. Which halves are which is computed, not
          asserted: the chip in the nav reads the same provider resolution the
          terminal does. */}
      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">Some of this is real, and some is simulated</h2>
        <p>
          This terminal is <b className="text-[var(--text)]">mixed</b>, and the data-mode chip in the navigation names
          which halves are which on every screen. It is computed from the same provider resolution the app uses, so it
          cannot drift away from what you are actually looking at.
        </p>
        <p>
          <b className="text-[var(--text)]">Real, from keyless public sources, fetched in your browser:</b> the token list
          and its holder counts, top-holder share, dev balance, organic-activity score, launchpad and creator mint history
          (Jupiter); the price chart — minute bars from Jupiter&apos;s chart endpoint, which is the default view, and the
          hourly view from GeckoTerminal, falling back to Jupiter when GeckoTerminal throttles (each chart names which one
          drew it); mint and freeze authority read from the chain (Solana JSON-RPC); token creations pushed over a
          keyless socket (PumpPortal) and per-account chain notifications (Solana JSON-RPC over WebSocket);
          wallet-level flow (SQD); rug risk and liquidity-pool lock state (RugCheck); and the SOL reference price
          (CoinGecko and Crypto.com, cross-checked).
        </p>
        <p>
          <b className="text-[var(--warn)]">Still simulated:</b> wallet activity, wallet PnL, smart-money scoring, the
          cluster graph, and the backtester — all generated from a{" "}
          <b className="text-[var(--warn)]">deterministic synthetic universe</b> with a fixed seed. None of those wallets
          are real people. Names that resemble entities (&ldquo;Meridian Desk&rdquo;, &ldquo;Tidewater Capital&rdquo;) are
          invented. Backtest results and accuracy statistics measure the engine against its own simulation — they
          demonstrate the <i>method</i>, not real-market performance.
        </p>
        <p>
          Where a number was never measured at all, this terminal shows a dash and says why, rather than a zero. A zero
          in a holder-concentration column would read as a perfectly distributed token; the truth is usually that nobody
          looked.
        </p>
      </section>

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">The score keeps its own record</h2>
        <p>
          <Link href="/track" className="text-[var(--accent)] hover:underline">
            Track Record
          </Link>{" "}
          logs every scan pass and resolves it against later prices, then reports whether any score band beat the average
          of <i>everything the scanner listed</i>. It compares against that baseline rather than against zero, because in
          a rising market every band goes up and calling that skill would be crediting the market to the model. Its
          intervals resample whole scan passes, not individual rows — tokens seen in the same pass share a market and are
          not independent trials.
        </p>
        <p>
          It is designed to be able to report no edge, and that is the usual answer. The ledger is stored only in your own
          browser and is never uploaded.
        </p>
      </section>

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">Not investment advice</h2>
        <p>
          Nothing here is financial, investment, legal, or tax advice, and nothing here predicts or guarantees any outcome.
          Signal scores are ranked evidence with stated confidence, explicit risks, a bear case, and invalidation
          conditions — and the engine frequently concludes <b className="text-[var(--text)]">NO TRADE</b>. Memecoin markets
          in the real world carry extreme risk, including total loss. If you trade, that decision and its consequences are
          entirely yours; do your own research and consider consulting a licensed professional.
        </p>
      </section>

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">Privacy</h2>
        <p>
          The app needs no account and never asks for one, and there is no tracking of you. The one optional account, on
          the Account page, exists for the hosted Whale Radar alone: it stores your email with the sign-in provider
          (Supabase Auth) and, if you subscribe, a Stripe customer id; card details go to Stripe&apos;s own page and never
          touch this app. The entire engine runs inside your browser. Your
          watchlists, alerts, paper portfolio, and research notes are stored only in your browser&apos;s local storage on
          your device — they are never uploaded, and clearing your browser data removes them completely. The only network
          requests this app makes are to the public price APIs named above; those requests carry no personal data or
          identifiers beyond what any HTTP request includes.
        </p>
        <p>
          There is no wallet connection, no private-key or seed-phrase handling of any kind, and no way to move real funds
          from this application.
        </p>
      </section>

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">Contact</h2>
        <p>
          ROM Nova is part of <a className="link" href="https://romapps.xyz" target="_blank" rel="noopener">ROM Apps</a> —
          free, honest software. Found a problem? The{" "}
          <a className="link" href="https://romapps.xyz" target="_blank" rel="noopener">ROM Apps site</a> links to the
          project&apos;s repositories and contact points.
        </p>
      </section>

      <Link href="/" className="link text-[12px]">
        ← Back to the terminal
      </Link>
    </div>
  );
}

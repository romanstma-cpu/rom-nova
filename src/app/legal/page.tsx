import Link from "next/link";

export const metadata = { title: "Disclaimer & Privacy — ROM Nova" };

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

      <section className="panel p-4 text-[12.5px] leading-relaxed dim flex flex-col gap-2">
        <h2 className="panel-title">The data is simulated</h2>
        <p>
          Every token, wallet, trade, cluster, signal, and portfolio in this terminal belongs to a{" "}
          <b className="text-[var(--warn)]">deterministic synthetic universe</b> generated from a fixed seed. None of the
          tokens exist. None of the wallets are real people. Names that resemble entities (&ldquo;Meridian Desk&rdquo;,
          &ldquo;Tidewater Capital&rdquo;) are invented. Backtest results, accuracy statistics, and wallet PnL measure the engine against its own
          simulation — they demonstrate the <i>method</i>, not real-market performance.
        </p>
        <p>
          The single live number is the <b className="text-[var(--text)]">SOL reference price</b> in the top bar, fetched in
          your browser from public keyless APIs (CoinGecko and Crypto.com Exchange) and cross-checked between them. It is
          always labeled LIVE and is never mixed into the simulated analytics.
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
          There are no accounts, no sign-ups, and no tracking of you. The entire engine runs inside your browser. Your
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

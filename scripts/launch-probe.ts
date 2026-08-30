// Does the launch feed actually see launches, and how late?
//
// A fixture test proves the parser. Only this proves the design, and the design
// rests entirely on numbers no test can produce: how far behind the chain the
// freshest keyless source runs, how much of Solana one page of it covers, and
// whether a verdict can be attached before the launch stops mattering.
//
// THE MEASUREMENT PROBLEM THIS SCRIPT SOLVES FIRST
//
// "Feed lag" is (when we saw it) minus (when the source says the pool was
// created), and those two timestamps come off two different clocks. The machine
// this was written on ran 1.6 seconds behind Jupiter's, which is most of the
// figure being measured — reported uncorrected it would have turned a real
// ~2.5s lag into ~1s and made the feed look twice as fast as it is.
//
// So section 1 brackets the skew NTP-style off the HTTP `Date` header before
// anything else runs, and every latency below is reported both raw and
// corrected. `Date` has one-second resolution and is floored, which is why the
// result is an interval rather than a number.
//
//   npm run probe:launches            everything, ~4 minutes
//   npm run probe:launches -- --quick skips the sustained poll and the streams

import { JupiterTokenProvider } from "../src/lib/providers/jupiter";
import { GeckoTerminalTokenProvider, GRADUATION_DEXES } from "../src/lib/providers/geckoterminal";
import { RugCheckRiskProvider } from "../src/lib/providers/rugcheck";
import { triageLaunch, triageHeadline } from "../src/lib/engine/triage";
import { launchFeed, LAUNCH_POLL_MS, resetLaunchFeed } from "../src/lib/api/launches";
import type { LaunchObservation } from "../src/lib/types";

const APP_ORIGIN = "app://rom-nova";
const QUICK = process.argv.includes("--quick");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stats(xs: number[]): { n: number; min: number; p50: number; p90: number; max: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

function head(title: string) {
  console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}`);
}

// ---------------------------------------------------------------- 1. clocks

/**
 * Brackets this machine's clock against the source's.
 *
 * `Date` is floored to the second, so one sample only tells us the true skew
 * lies in a 1s-wide interval. Repeated sampling narrows it: the tightest lower
 * bound comes from the request that was SENT latest relative to its response's
 * second boundary, and vice versa.
 */
async function measureSkew(url: string, samples = 8): Promise<{ lo: number; hi: number; mid: number }> {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { Origin: APP_ORIGIN } });
    await res.text();
    const t1 = Date.now();
    const d = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isFinite(d)) continue;
    // Server generated the header somewhere in [d, d+1000) and somewhere in
    // [t0, t1] on our clock. skew = ours - theirs.
    lo = Math.max(lo, t0 - (d + 1000));
    hi = Math.min(hi, t1 - d);
    await sleep(220);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 0, mid: 0 };
  return { lo, hi, mid: (lo + hi) / 2 };
}

// ---------------------------------------------------------------- 2. reach

/**
 * Retried once on 429, because a rate-limited response answers the wrong
 * question.
 *
 * GeckoTerminal returns 429 with no CORS header at all, so a probe that hit its
 * limit reported "NOT usable in the shell" for a source the app uses every
 * twenty seconds. Being throttled is not being refused, and conflating them
 * would have condemned a working adapter on the strength of the probe's own
 * impatience.
 */
async function corsCheck(label: string, url: string) {
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { Origin: APP_ORIGIN } });
      const body = await res.text();
      // GeckoTerminal's window is longer than one gap. Backing off in steps
      // rather than giving up after one retry, because the alternative is a
      // probe that reports a working adapter as unreachable.
      if (res.status === 429 && attempt < attempts - 1) {
        await sleep(5_000 * (attempt + 1));
        continue;
      }
      const acao = res.headers.get("access-control-allow-origin");
      // A bare GET returns no CORS header from several of these and would look
      // like a refusal. The Origin header above is what makes the answer real.
      const ok = acao === "*" || acao === APP_ORIGIN;
      console.log(
        `  ${label.padEnd(30)} ${res.status} ${String(Date.now() - t0).padStart(5)}ms  ` +
          `ACAO=${(acao ?? "(none)").padEnd(16)} ` +
          `${ok ? "reachable from app://" : res.status === 429 ? "throttled — inconclusive, retry" : "NOT usable in the shell"}  ${body.length}B`,
      );
      return;
    } catch (err) {
      console.log(`  ${label.padEnd(30)} FAILED ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
}

// ---------------------------------------------------------------- 3. latency

interface Seen {
  mint: string;
  symbol: string;
  poolCreatedAt: number;
  firstSeenAt: number;
  obs: LaunchObservation;
}

/**
 * Polls the primary source at the feed's own interval and records, for every
 * mint, the first moment it was visible.
 *
 * This is the headline number. It is deliberately measured against the RAW
 * adapter rather than through `launchFeed`, so the figure is the SOURCE's lag
 * and not this app's caching.
 */
async function pollLatency(seconds: number, intervalMs: number) {
  const jup = new JupiterTokenProvider();
  const seen = new Map<string, Seen>();
  const windows: number[] = [];
  const callLatency: number[] = [];
  const codes = new Map<string, number>();
  const until = Date.now() + seconds * 1000;
  /**
   * The newest row on the FIRST page. Everything at or before it was already
   * indexed when this run started, and counting it would measure when the probe
   * began rather than how fast the source is — the first version reported a p50
   * of 6.3s that way against a true 2.5s.
   */
  let backfillMark = 0;

  while (Date.now() < until) {
    const t0 = Date.now();
    try {
      const rows = await jup.getRecentLaunches(t0);
      callLatency.push(Date.now() - t0);
      codes.set("200", (codes.get("200") ?? 0) + 1);
      const created = rows.map((r) => r.poolCreatedAt).sort((a, b) => a - b);
      if (created.length > 1) windows.push((created[created.length - 1] - created[0]) / 1000);
      if (backfillMark === 0) backfillMark = created[created.length - 1];
      for (const r of rows) {
        if (seen.has(r.mint) || r.poolCreatedAt <= backfillMark) continue;
        seen.set(r.mint, {
          mint: r.mint,
          symbol: r.symbol,
          poolCreatedAt: r.poolCreatedAt,
          firstSeenAt: t0,
          obs: r,
        });
      }
    } catch (err) {
      const m = String(err).match(/HTTP (\d+)/);
      const key = m ? m[1] : "error";
      codes.set(key, (codes.get(key) ?? 0) + 1);
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
  }
  return { seen, windows, callLatency, codes };
}

// ---------------------------------------------------------------- 4. streams

/**
 * The two genuine push feeds that exist without a key, measured rather than
 * described.
 *
 * Both were reachable. Neither replaced the poll, and the numbers below are why
 * — printed here so the decision can be re-checked rather than trusted.
 */
async function probeStreams() {
  const measure = (
    label: string,
    url: string,
    sub: unknown,
    ms: number,
    isPayload: (s: string) => boolean,
  ) =>
    new Promise<void>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers: { Origin: APP_ORIGIN } } as unknown as string[]);
      } catch (err) {
        console.log(`  ${label}: could not open — ${err instanceof Error ? err.message : String(err)}`);
        return resolve();
      }
      let msgs = 0;
      let bytes = 0;
      let payloads = 0;
      let openedIn = 0;
      let firstPayloadIn = 0;
      const t0 = Date.now();
      const done = () => {
        const s = (Date.now() - t0) / 1000;
        console.log(
          `  ${label}\n` +
            `    opened in ${openedIn}ms · ${msgs} frames in ${s.toFixed(0)}s (${(msgs / s).toFixed(0)}/s)\n` +
            `    ${(bytes / 1e6).toFixed(2)}MB total = ${(bytes / 1e6 / s).toFixed(3)} MB/s = ${((bytes / 1e6 / s) * 3600).toFixed(0)} MB/hr in a browser tab\n` +
            `    ${payloads} of those frames were the event we wanted` +
            (firstPayloadIn ? `, first at ${firstPayloadIn}ms` : ""),
        );
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve();
      };
      const timer = setTimeout(done, ms);
      ws.onopen = () => {
        openedIn = Date.now() - t0;
        if (sub) ws.send(JSON.stringify(sub));
      };
      ws.onmessage = (e) => {
        msgs++;
        const s = String(e.data);
        bytes += s.length;
        if (isPayload(s)) {
          payloads++;
          if (!firstPayloadIn) firstPayloadIn = Date.now() - t0;
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        console.log(`  ${label}: socket error`);
        resolve();
      };
    });

  await measure(
    "pumpportal wss://pumpportal.fun/api/data · subscribeNewToken",
    "wss://pumpportal.fun/api/data",
    { method: "subscribeNewToken" },
    20_000,
    (s) => s.includes('"txType":"create"'),
  );
  await measure(
    "solana rpc wss://solana-rpc.publicnode.com · logsSubscribe(pump.fun)",
    "wss://solana-rpc.publicnode.com",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }, { commitment: "processed" }],
    },
    20_000,
    (s) => s.includes("Program log: Instruction: Create"),
  );
}

// ---------------------------------------------------------------- main

void (async () => {
  head("1. CLOCK SKEW — everything below is meaningless without this");
  const skew = await measureSkew("https://lite-api.jup.ag/tokens/v2/recent");
  console.log(
    `  vs lite-api.jup.ag        this machine is ${skew.mid >= 0 ? "AHEAD BY" : "BEHIND BY"} ` +
      `${Math.abs(skew.mid / 1000).toFixed(2)}s  (bracketed to [${(skew.lo / 1000).toFixed(2)}s, ${(skew.hi / 1000).toFixed(2)}s])`,
  );
  // Cross-checked against unrelated hosts, because the whole latency claim
  // rests on this one number. Three independent servers agreeing means the
  // offset is this machine's clock; one disagreeing would mean the offset is
  // that server's, and correcting for it would corrupt rather than fix the
  // measurement.
  for (const [label, url] of [
    ["api.rugcheck.xyz", "https://api.rugcheck.xyz/v1/tokens/So11111111111111111111111111111111111111112/report/summary"],
    ["api.geckoterminal.com", "https://api.geckoterminal.com/api/v2/networks/solana"],
  ] as const) {
    const s = await measureSkew(url, 4);
    console.log(
      `  vs ${label.padEnd(24)} ${s.mid >= 0 ? "AHEAD BY" : "BEHIND BY"} ${Math.abs(s.mid / 1000).toFixed(2)}s  ` +
        `(bracketed to [${(s.lo / 1000).toFixed(2)}s, ${(s.hi / 1000).toFixed(2)}s])`,
    );
  }
  console.log(`  every "corrected" figure below subtracts ${(skew.mid / 1000).toFixed(2)}s.`);

  head("2. CORS FROM THE ELECTRON SHELL ORIGIN (app://rom-nova)");
  await corsCheck("jupiter recent", "https://lite-api.jup.ag/tokens/v2/recent");
  await corsCheck("jupiter search (batched)", "https://lite-api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112");
  await corsCheck("rugcheck summary", "https://api.rugcheck.xyz/v1/tokens/So11111111111111111111111111111111111111112/report/summary");
  await corsCheck("geckoterminal new_pools", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools");

  head("3. SOURCE FRESHNESS — how old is the newest thing each source can see?");
  {
    const jup = new JupiterTokenProvider();
    const t = Date.now();
    const rows = await jup.getRecentLaunches(t);
    const ages = rows.map((r) => t - r.poolCreatedAt - skew.mid).sort((a, b) => a - b);
    const span = (rows.map((r) => r.poolCreatedAt).sort((a, b) => b - a)[0] - rows.map((r) => r.poolCreatedAt).sort((a, b) => a - b)[0]) / 1000;
    console.log(`  jupiter recent : ${rows.length} rows (the endpoint caps here; limit= is ignored)`);
    console.log(`      newest ${secs(ages[0])} old · median ${secs(ages[Math.floor(ages.length / 2)])} · oldest ${secs(ages[ages.length - 1])}`);
    console.log(`      one page spans ${span.toFixed(0)}s of Solana — the entire history this endpoint holds`);
    const priced = rows.filter((r) => r.priceUsd !== undefined).length;
    const audited = rows.filter((r) => r.authorityKnown).length;
    const withCreator = rows.filter((r) => r.devMints !== undefined).length;
    console.log(`      priced ${priced}/${rows.length} · authorities read ${audited}/${rows.length} · creator history ${withCreator}/${rows.length}`);

    // The CORS check above, and its 429 retries, already spent several of
    // GeckoTerminal's tokens. Four requests with no gap returned 200,200,200,
    // 200 then four straight 429s, and its window is longer than the adapter's
    // own 2.1s queue gap, so this waits well clear of it.
    await sleep(12_000);
    const gt = new GeckoTerminalTokenProvider();
    const t2 = Date.now();
    try {
      const pools = await gt.getNewPools(1);
      const pAges = pools.map((p) => t2 - p.createdAt).sort((a, b) => a - b);
      const dexes = new Map<string, number>();
      for (const p of pools) dexes.set(p.dex, (dexes.get(p.dex) ?? 0) + 1);
      console.log(`  geckoterminal  : ${pools.length} pools/page`);
      console.log(`      newest ${secs(pAges[0])} old · oldest ${secs(pAges[pAges.length - 1])}`);
      console.log(`      dexes: ${[...dexes].map(([d, n]) => `${d}=${n}`).join(" ")}`);
      console.log(`      of which non-launchpad (graduations / direct AMM pools): ${pools.filter((p) => GRADUATION_DEXES.test(p.dex)).length}`);
    } catch (err) {
      console.log(`  geckoterminal  : unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  head("4. TRIAGE COST AND COMPLETENESS ON A SECONDS-OLD MINT");
  {
    const jup = new JupiterTokenProvider();
    const rc = new RugCheckRiskProvider();
    const rows = (await jup.getRecentLaunches()).slice(0, 8);
    const lat: number[] = [];
    console.log(
      "  age".padEnd(9) +
        "sym".padEnd(13) +
        "rc ms".padStart(7) +
        "  verdict / what could and could not be checked",
    );
    for (const r of rows) {
      const t0 = Date.now();
      const risk = await rc.getTokenRisk(r.mint, false).catch(() => null);
      const ms = Date.now() - t0;
      lat.push(ms);
      const tri = triageLaunch(r, risk ?? undefined, ms);
      console.log(
        `  ${secs(Date.now() - r.poolCreatedAt - skew.mid).padEnd(7)}` +
          (r.symbol || r.mint.slice(0, 6)).slice(0, 12).padEnd(13) +
          String(ms).padStart(7) +
          `  ${triageHeadline(tri)}`,
      );
      await sleep(150);
    }
    const s = stats(lat)!;
    console.log(`\n  rugcheck summary: n=${s.n} min ${s.min}ms p50 ${s.p50}ms p90 ${s.p90}ms max ${s.max}ms`);
    console.log("  Everything except the two rugcheck-fed checks costs NOTHING extra — it ships");
    console.log("  inside the same listing response as the price.");
  }

  if (!QUICK) {
    head(`5. SUSTAINED POLL — the real end-to-end latency, ${LAUNCH_POLL_MS / 1000}s interval, 120s`);
    const { seen, windows, callLatency, codes } = await pollLatency(120, LAUNCH_POLL_MS);
    const raw = [...seen.values()].map((s) => s.firstSeenAt - s.poolCreatedAt);
    const corrected = raw.map((x) => x - skew.mid);
    const r = stats(raw)!;
    const c = stats(corrected)!;
    const w = stats(windows)!;
    const l = stats(callLatency)!;
    console.log(`  ${seen.size} launches ARRIVED during the 120s window (${(seen.size / 2).toFixed(1)}/min); the opening page of backfill is excluded`);
    console.log(`  lag RAW        min ${secs(r.min)} p50 ${secs(r.p50)} p90 ${secs(r.p90)} max ${secs(r.max)}`);
    console.log(`  lag CORRECTED  min ${secs(c.min)} p50 ${secs(c.p50)} p90 ${secs(c.p90)} max ${secs(c.max)}`);
    console.log(`     (that lag = source indexing delay + up to one ${LAUNCH_POLL_MS / 1000}s poll interval)`);
    console.log(`  page window    min ${w.min.toFixed(0)}s p50 ${w.p50.toFixed(0)}s max ${w.max.toFixed(0)}s`);
    console.log(
      `     safety margin at the ${LAUNCH_POLL_MS / 1000}s poll: ${(w.min / (LAUNCH_POLL_MS / 1000)).toFixed(1)}x at the WORST observed window.`,
    );
    console.log(`     below 1.0x, launches fall off the 30-row page unseen and nothing reports it.`);
    console.log(`  http           ${[...codes].map(([k, n]) => `${k}=${n}`).join(" ")} · latency p50 ${l.p50}ms p90 ${l.p90}ms max ${l.max}ms`);
    console.log(`     ${l.n} requests in 120s = ${((l.n / 120) * 3600).toFixed(0)}/hr sustained. Zero 429s means headroom, not a limit found.`);
  }

  head("6. THE REAL PATH — what a reader would actually see");
  {
    resetLaunchFeed();
    const t0 = Date.now();
    const opened = Date.now();
    let feed = await launchFeed();
    console.log(`  first paint: ${feed ? feed.launches.length : 0} rows in ${Date.now() - t0}ms`);
    // Driven at the PAGE's poll rate, not the feed's. The feed self-throttles,
    // so calling it faster than it refreshes is exactly what the browser does
    // and is what keeps the effective refresh interval at a clean 3s instead of
    // drifting out to 4s or more while each poll waits for the last one's risk
    // fan-out to finish.
    const pagePollMs = 1_500;
    const runFor = QUICK ? 30_000 : 90_000;
    const stopAt = Date.now() + runFor;
    while (Date.now() < stopAt) {
      await sleep(pagePollMs);
      feed = await launchFeed();
    }
    console.log(`  after ${runFor / 1000}s of running at the page's ${pagePollMs}ms poll:`);
    if (!feed) {
      console.log("  NO FEED — no live token provider resolved.");
    } else {
      // Rows that ARRIVED while the feed was running, as opposed to the page of
      // backfill it opened with. Only these describe the feed's own behaviour.
      const live = feed.launches.filter((l) => l.poolCreatedAt > opened);
      const liveTri = stats(live.filter((l) => l.triage.completedInMs !== undefined).map((l) => l.triage.completedInMs!));
      console.log(
        `  of ${feed.launches.length} rows, ${live.length} launched AFTER the feed opened — those are the ones that measure it:`,
      );
      console.log(
        `     lag p50 ${feed.lagP50Ms === null ? "?" : secs(feed.lagP50Ms)} p90 ${feed.lagP90Ms === null ? "?" : secs(feed.lagP90Ms)} (n=${feed.lagSamples}, raw; subtract ${(skew.mid / 1000).toFixed(2)}s of clock skew → p50 ${feed.lagP50Ms === null ? "?" : secs(feed.lagP50Ms - skew.mid)})`,
      );
      console.log(
        `     verdict within ${liveTri ? `p50 ${liveTri.p50}ms / p90 ${liveTri.p90}ms` : "—"} of first sight` +
          `, complete for ${live.filter((l) => l.triage.completedInMs !== undefined).length}/${live.length}`,
      );
      const verdicts = new Map<string, number>();
      for (const l of feed.launches) verdicts.set(l.triage.verdict, (verdicts.get(l.triage.verdict) ?? 0) + 1);
      const triaged = feed.launches.filter((l) => l.triage.completedInMs !== undefined);
      console.log(`\n  whole feed: ${feed.launches.length} rows · listing page window ${feed.windowSeconds?.toFixed(0)}s`);
      console.log(`  verdicts: ${[...verdicts].map(([v, n]) => `${v}=${n}`).join(" ")}`);
      console.log(`  risk grade attached to ${triaged.length}/${feed.launches.length}; ${feed.awaitingTriage} still pending`);
      const grads = feed.launches.filter((l) => l.event === "graduation").length;
      console.log(`  graduations / direct AMM pools in the feed: ${grads}`);

      // Every check, every state. The tally that says whether a verdict rests
      // on evidence or on the absence of it — and whether any single check is
      // quietly driving the whole AVOID rate.
      const tally = new Map<string, Map<string, number>>();
      for (const l of feed.launches) {
        for (const c of l.triage.checks) {
          const row = tally.get(c.key) ?? new Map<string, number>();
          row.set(c.state, (row.get(c.state) ?? 0) + 1);
          tally.set(c.key, row);
        }
      }
      console.log(`\n  every check, every state, over ${feed.launches.length} rows:`);
      console.log(`    ${"check".padEnd(18)}${"fail".padStart(6)}${"warn".padStart(6)}${"pass".padStart(6)}${"n/a".padStart(6)}${"unchecked".padStart(11)}`);
      for (const [k, row] of tally) {
        console.log(
          `    ${k.padEnd(18)}` +
            String(row.get("fail") ?? 0).padStart(6) +
            String(row.get("warn") ?? 0).padStart(6) +
            String(row.get("pass") ?? 0).padStart(6) +
            String(row.get("n/a") ?? 0).padStart(6) +
            String(row.get("unchecked") ?? 0).padStart(11),
        );
      }

      console.log("\n  worst ten by verdict:");
      const worst = feed.launches
        .filter((l) => l.triage.verdict === "avoid")
        .sort((a, b) => (b.triage.riskScore ?? 0) - (a.triage.riskScore ?? 0))
        .slice(0, 10);
      for (const l of worst) {
        const failed = l.triage.checks.filter((c) => c.state === "fail");
        console.log(
          `    ${(l.symbol || l.mint.slice(0, 6)).slice(0, 12).padEnd(13)}` +
            `${secs(Date.now() - l.poolCreatedAt).padStart(8)} old  ` +
            failed.map((c) => c.key + (c.assumed ? "(assumed)" : "")).join(", "),
        );
      }
      if (worst.length === 0) console.log("    none");
    }
  }

  if (!QUICK) {
    head("7. PUSH INSTEAD OF POLL — the two keyless streams, and their real cost");
    await probeStreams();
    console.log(
      "\n  Read the MB/hr column before reaching for the RPC one: that stream is every\n" +
        "  pump.fun instruction, and the creates are a fraction of a percent of it. Filtering\n" +
        "  client-side means paying the whole bill in the visitor's tab.",
    );
  }

  console.log("");
})();

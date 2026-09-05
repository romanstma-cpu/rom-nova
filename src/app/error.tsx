"use client";

// Whatever a page throws lands here, inside the chrome.
//
// The rail, the top bar and the footer live in the root layout, which this
// boundary does not wrap, so a reader keeps every way out of a broken page.
// Before this file existed a thrown render error took the whole terminal
// down to Next's blank "Application error: a client-side exception has
// occurred", with the data in this browser intact but no way to reach it.
//
// Next's `retry` re-renders this segment; the message is shown as it is,
// because on a client-only build there is nothing sensitive in it and it is
// exactly what a bug report needs.

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle } from "@/components/ui/PageTitle";
import { APP_VERSION } from "@/lib/version";
import { isDesktop } from "@/lib/desktop";
import { describeError, errorReport } from "@/lib/error-report";

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    console.error(error);
  }, [error]);

  const d = describeError(error);

  const copy = async () => {
    const text = errorReport({
      error,
      version: APP_VERSION,
      path: `${location.pathname}${location.search}`,
      userAgent: navigator.userAgent,
      at: new Date(),
      desktop: isDesktop(),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="p-3 flex flex-col gap-3 max-w-[760px]">
      <PageTitle title="SOMETHING BROKE" lede="This page hit an error; the rest of the app is fine" />
      <div className="panel p-5 flex flex-col gap-3">
        <div className="text-[13.5px] font-semibold">{d.title}</div>
        <p className="text-[12.5px] dim leading-relaxed">{d.advice}</p>
        <pre className="num text-[11px] text-[var(--neg)] whitespace-pre-wrap break-words bg-[rgba(255,77,109,0.06)] border border-[rgba(255,77,109,0.25)] rounded-md p-3 max-h-[160px] overflow-auto">
          {error.message || String(error)}
        </pre>
        <div className="flex gap-2 flex-wrap">
          {d.reload ? (
            <button type="button" className="btn btn-primary text-[11px]" onClick={() => location.reload()}>
              RELOAD
            </button>
          ) : (
            <button type="button" className="btn btn-primary text-[11px]" onClick={() => retry()}>
              TRY AGAIN
            </button>
          )}
          {d.reload && (
            <button type="button" className="btn text-[11px]" onClick={() => retry()}>
              TRY AGAIN
            </button>
          )}
          <Link href="/" className="btn text-[11px]">
            DASHBOARD
          </Link>
          <button type="button" className="btn text-[11px]" onClick={() => void copy()}>
            {copied === "done" ? "COPIED" : copied === "failed" ? "COULD NOT COPY" : "COPY DETAILS"}
          </button>
        </div>
        <p className="text-[10.5px] faint">
          Your watchlists, alerts, ledger and radar journal live in this browser and are untouched. Version {APP_VERSION}
          {error.digest ? ` · ${error.digest}` : ""}.
        </p>
      </div>
    </div>
  );
}

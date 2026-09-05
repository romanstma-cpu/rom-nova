"use client";

// A wrong address, in the app's own voice — inside the chrome, with the
// rail still there, so a mistyped link is a detour and not a dead end.
// Next's default here was a bare "404" on a white page.

import Link from "next/link";
import { PageTitle } from "@/components/ui/PageTitle";

export default function NotFound() {
  return (
    <div className="p-3 flex flex-col gap-3 max-w-[760px]">
      <PageTitle title="NOT FOUND" lede="Nothing lives at this address" />
      <div className="panel p-5 flex flex-col gap-3">
        <div className="num text-[44px] leading-none text-[var(--accent)]">404</div>
        <p className="text-[12.5px] dim leading-relaxed">
          The page you asked for is not part of ROM Nova. Links inside the app never lead here; a pasted address with a
          typo, or one from an older version, can.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Link href="/" className="btn btn-primary text-[11px]">
            DASHBOARD
          </Link>
          <Link href="/radar" className="btn text-[11px]">
            WHALE RADAR
          </Link>
          <Link href="/whales" className="btn text-[11px]">
            TRACK A WALLET
          </Link>
        </div>
        <p className="text-[10.5px] faint">
          The search box at the top right, or <span className="num">Ctrl K</span>, goes to any page or token by name.
        </p>
      </div>
    </div>
  );
}

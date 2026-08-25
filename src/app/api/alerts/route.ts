import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleAlertsGet, handleAlertOp } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";
import type { AlertCondition } from "@/lib/types";

export async function GET() {
  return NextResponse.json(handleAlertsGet(ensureSimulator()));
}

const Condition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("whale_buy"), minUsd: z.number().min(0), mint: z.string().optional() }),
  z.object({ type: z.literal("whale_sell"), minUsd: z.number().min(0), mint: z.string().optional() }),
  z.object({ type: z.literal("signal_score_above"), threshold: z.number().min(0).max(100), mint: z.string().optional() }),
  z.object({ type: z.literal("risk_score_above"), threshold: z.number().min(0).max(100), mint: z.string().optional() }),
  z.object({ type: z.literal("volume_spike"), multiple: z.number().min(1), mint: z.string().optional() }),
  z.object({ type: z.literal("liquidity_drop"), pct: z.number().min(1).max(100), mint: z.string().optional() }),
  z.object({ type: z.literal("wallet_activity"), wallet: z.string() }),
]);

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().min(1).max(80), condition: Condition }),
  z.object({ op: z.literal("toggle"), id: z.string() }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("mark_read") }),
]);

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;
  return respond(() =>
    handleAlertOp(
      store,
      body.op === "create" ? { op: "create", name: body.name, condition: body.condition as AlertCondition } : body,
    ),
  );
}

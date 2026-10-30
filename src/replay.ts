import {
  record,
  closed,
  text,
  integer,
  category,
  timestamp,
  parseReadState,
  type ReadState,
  type Category,
} from "./contract.ts";
import { digest } from "./canonical.ts";
export type Strategy = "baseline" | "model-fixture" | "hold";
export interface Config {
  category: Category;
  allowlist: string[];
  maxAgeMs: number;
  maxFutureMs: number;
  perProposalCents: number;
  maxTotalCents: number;
  maxProposals: number;
  signalThresholdBps: number;
}
export interface Frame {
  frameId: string;
  clockMs: number;
  state: ReadState;
  market: { mint: string; observedAtMs: number; signalBps: number };
  portfolio: {
    observedAtMs: number;
    cashCents: number | null;
    positions: null | { mint: string; valueCents: number | null }[];
  };
  modelReply?: string;
}
export type Decision =
  | { action: "HOLD" }
  | { action: "BUY" | "SELL"; mint: string; amountCents: number };
export interface Entry {
  frameId: string;
  action: "HOLD" | "BUY" | "SELL";
  reason: string;
  amountCents: number;
  mint: string | null;
  inputDigest: string;
}
export interface ReplayResult {
  protocol: "audacefi.offline.replay.v1";
  synthetic: true;
  executionAuthorized: false;
  entries: Entry[];
  spentCents: number;
  proposalCount: number;
  digest: string;
}
export function parseConfig(raw: unknown): Config {
  const v = closed(raw, [
    "category",
    "allowlist",
    "maxAgeMs",
    "maxFutureMs",
    "perProposalCents",
    "maxTotalCents",
    "maxProposals",
    "signalThresholdBps",
  ]);
  if (
    !Array.isArray(v.allowlist) ||
    v.allowlist.length === 0 ||
    v.allowlist.length > 32
  )
    throw new Error("INVALID_ALLOWLIST");
  const allowlist = v.allowlist.map(text).sort();
  if (new Set(allowlist).size !== allowlist.length)
    throw new Error("DUPLICATE_MINT");
  return {
    category: category(v.category),
    allowlist,
    maxAgeMs: integer(v.maxAgeMs, 1, 300000),
    maxFutureMs: integer(v.maxFutureMs, 0, 30000),
    perProposalCents: integer(v.perProposalCents, 1),
    maxTotalCents: integer(v.maxTotalCents, 1),
    maxProposals: integer(v.maxProposals, 1, 10000),
    signalThresholdBps: integer(v.signalThresholdBps, 1, 10000),
  };
}
export function parseFrame(raw: unknown): Frame {
  const v = closed(raw, [
    "frameId",
    "clockMs",
    "state",
    "market",
    "portfolio",
    "modelReply",
  ]);
  const market = closed(v.market, ["mint", "observedAtMs", "signalBps"]),
    p = closed(v.portfolio, ["observedAtMs", "cashCents", "positions"]);
  let positions: Frame["portfolio"]["positions"] = null;
  if (p.positions !== null) {
    if (!Array.isArray(p.positions) || p.positions.length > 32)
      throw new Error("INVALID_POSITIONS");
    positions = p.positions
      .map((raw) => {
        const a = closed(raw, ["mint", "valueCents"]);
        return {
          mint: text(a.mint),
          valueCents: a.valueCents === null ? null : integer(a.valueCents),
        };
      })
      .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    if (new Set(positions.map((x) => x.mint)).size !== positions.length)
      throw new Error("DUPLICATE_POSITION");
  }
  const frame: Frame = {
    frameId: text(v.frameId),
    clockMs: integer(v.clockMs, 0, 8_000_000_000_000),
    state: parseReadState(v.state),
    market: {
      mint: text(market.mint),
      observedAtMs: integer(market.observedAtMs, 0, 8_000_000_000_000),
      signalBps: integer(market.signalBps, -10000, 10000),
    },
    portfolio: {
      observedAtMs: integer(p.observedAtMs, 0, 8_000_000_000_000),
      cashCents: p.cashCents === null ? null : integer(p.cashCents),
      positions,
    },
  };
  if (v.modelReply !== undefined) {
    if (typeof v.modelReply !== "string" || v.modelReply.length > 4096)
      throw new Error("INVALID_MODEL_TEXT");
    frame.modelReply = v.modelReply;
  }
  return frame;
}
export function parseModelReply(raw: string): Decision {
  if (raw.length > 4096) throw new Error("INVALID_MODEL_TEXT");
  // Flat JSON object: identify real string tokens followed by a colon, not text inside a value.
  const keys = new Set<string>();
  for (const token of raw.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (
      raw
        .slice(token.index! + token[0].length)
        .trimStart()
        .startsWith(":")
    ) {
      const key = JSON.parse(token[0]) as string;
      if (keys.has(key)) throw new Error("DUPLICATE_MODEL_KEY");
      keys.add(key);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_MODEL_JSON");
  }
  const v = record(value);
  if (v.action === "HOLD") {
    closed(v, ["action"]);
    return { action: "HOLD" };
  }
  closed(v, ["action", "mint", "amountCents"]);
  if (v.action !== "BUY" && v.action !== "SELL")
    throw new Error("INVALID_MODEL_ACTION");
  return {
    action: v.action,
    mint: text(v.mint),
    amountCents: integer(v.amountCents, 1),
  };
}
function evidenceReason(f: Frame, c: Config): string | null {
  if (f.state.category !== c.category || f.state.mode !== "real")
    return "CONTEXT_MISMATCH";
  const s = f.state.season.active,
    w = f.state.wallet;
  if (!s || s.status !== "active" || s.executionMode !== "devnet_onchain")
    return "NO_ACTIVE_DEVNET_SEASON";
  if (s.startsAt === null || s.endsAt === null) return "UNKNOWN_WINDOW";
  const start = timestamp(s.startsAt),
    end = timestamp(s.endsAt);
  if (start >= end || f.clockMs < start || f.clockMs >= end)
    return "OUTSIDE_WINDOW";
  if (w.state !== "ok") return "WALLET_UNAVAILABLE";
  if (
    w.seasonId !== s.id ||
    w.seasonExecutionMode !== "devnet_onchain" ||
    w.mode !== "real" ||
    w.category !== c.category.replace("-", "_") ||
    w.walletAddress === null
  )
    return "WALLET_CONTEXT_MISMATCH";
  for (const at of [
    timestamp(f.state.asOf),
    f.market.observedAtMs,
    f.portfolio.observedAtMs,
  ]) {
    if (at > f.clockMs + c.maxFutureMs) return "FUTURE_EVIDENCE";
    if (f.clockMs - at > c.maxAgeMs) return "STALE_EVIDENCE";
  }
  if (
    f.portfolio.cashCents === null ||
    f.portfolio.positions === null ||
    f.portfolio.positions.some((p) => p.valueCents === null)
  )
    return "UNKNOWN_BALANCE";
  return null;
}
export function replay(
  rawFrames: unknown[],
  rawConfig: unknown,
  strategy: Strategy = "baseline",
): ReplayResult {
  if (!["baseline", "model-fixture", "hold"].includes(strategy))
    throw new Error("UNKNOWN_STRATEGY");
  if (
    !Array.isArray(rawFrames) ||
    rawFrames.length === 0 ||
    rawFrames.length > 10000
  )
    throw new Error("INVALID_FRAME_COUNT");
  const config = parseConfig(rawConfig),
    frames = rawFrames.map(parseFrame),
    entries: Entry[] = [],
    seen = new Map<string, string>(),
    reservedSell = new Map<string, number>();
  let spentCents = 0,
    proposalCount = 0,
    reservedBuy = 0,
    lastClock = -1;
  for (const f of frames) {
    const inputDigest = digest({ frame: f, config, strategy });
    const hold = (reason: string) =>
      entries.push({
        frameId: f.frameId,
        action: "HOLD",
        reason,
        amountCents: 0,
        mint: null,
        inputDigest,
      });
    const prior = seen.get(f.frameId);
    if (prior) {
      if (prior !== inputDigest) throw new Error("FRAME_ID_CONFLICT");
      hold("DUPLICATE_FRAME");
      continue;
    }
    if (f.clockMs < lastClock) throw new Error("CLOCK_REGRESSION");
    lastClock = f.clockMs;
    seen.set(f.frameId, inputDigest);
    const blocked = evidenceReason(f, config);
    if (blocked) {
      hold(blocked);
      continue;
    }
    let proposal: Decision = { action: "HOLD" };
    if (strategy === "model-fixture") {
      try {
        if (f.modelReply === undefined) throw new Error("MISSING_MODEL_REPLY");
        proposal = parseModelReply(f.modelReply);
      } catch {
        hold("INVALID_MODEL_REPLY");
        continue;
      }
    } else if (
      strategy === "baseline" &&
      Math.abs(f.market.signalBps) >= config.signalThresholdBps
    ) {
      proposal = {
        action: f.market.signalBps > 0 ? "BUY" : "SELL",
        mint: f.market.mint,
        amountCents: config.perProposalCents,
      };
    }
    if (proposal.action === "HOLD") {
      hold("STRATEGY_HOLD");
      continue;
    }
    if (
      proposal.mint !== f.market.mint ||
      !config.allowlist.includes(proposal.mint)
    ) {
      hold("MINT_NOT_ALLOWED");
      continue;
    }
    if (
      proposal.amountCents > config.perProposalCents ||
      spentCents + proposal.amountCents > config.maxTotalCents ||
      proposalCount >= config.maxProposals
    ) {
      hold("PROPOSAL_BUDGET_EXHAUSTED");
      continue;
    }
    if (
      proposal.action === "BUY" &&
      proposal.amountCents > f.portfolio.cashCents! - reservedBuy
    ) {
      hold("INSUFFICIENT_SYNTHETIC_CASH");
      continue;
    }
    const position =
      f.portfolio.positions!.find((x) => x.mint === proposal.mint)
        ?.valueCents ?? 0;
    if (
      proposal.action === "SELL" &&
      proposal.amountCents > position - (reservedSell.get(proposal.mint) ?? 0)
    ) {
      hold("INSUFFICIENT_SYNTHETIC_POSITION");
      continue;
    }
    spentCents += proposal.amountCents;
    proposalCount++;
    if (proposal.action === "BUY") reservedBuy += proposal.amountCents;
    else
      reservedSell.set(
        proposal.mint,
        (reservedSell.get(proposal.mint) ?? 0) + proposal.amountCents,
      );
    entries.push({
      frameId: f.frameId,
      action: proposal.action,
      reason: "SYNTHETIC_PROPOSAL_ONLY",
      mint: proposal.mint,
      amountCents: proposal.amountCents,
      inputDigest,
    });
  }
  const result = {
    protocol: "audacefi.offline.replay.v1" as const,
    synthetic: true as const,
    executionAuthorized: false as const,
    entries,
    spentCents,
    proposalCount,
  };
  return { ...result, digest: digest(result) };
}

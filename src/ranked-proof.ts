import { mint, rawAmount, uuid } from "./client.ts";
import { closed, integer, timestamp } from "./contract.ts";
import type { FileJournal } from "./journal.ts";
import type { Operation } from "./operation.ts";
import { decode58 } from "./solana.ts";

export interface RankedOperationContext {
  operationKey: string;
  origin: string;
  apiBasePath?: "/api";
  genesisHash: string;
  seasonId: string;
  accountId: string;
  actor: Operation["actor"];
  category: "crypto-bro";
  playerPublicKey: string;
}

export interface RankedEvidenceRequest extends RankedOperationContext {
  intentId: string;
  txid: string;
}

interface RankedTradeAmounts {
  amountInRaw: string;
  amountOutRaw: string;
  feeRaw: string;
}

export interface RankedEvidence {
  trade: RankedEvidenceRequest & RankedTradeAmounts;
  leaderboard: {
    seasonId: string;
    accountId: string;
    category: "crypto-bro";
    division: "A" | "B" | "C";
    rank: number;
    asOf: string;
    includedIntentId: string;
    includedTxid: string;
  };
}

/** An authenticated reader of indexed trades and ranking inputs for the specified target. */
export type ReadRankedEvidence = (request: Readonly<RankedEvidenceRequest>) => Promise<RankedEvidence | null>;

export type RankedOperationStatus =
  | { status: "not-finalized"; ranked: false }
  | { status: "ranking-pending"; ranked: false; intentId: string; txid: string }
  | (RankedTradeAmounts & {
      status: "ranked";
      ranked: true;
      intentId: string;
      txid: string;
      seasonId: string;
      accountId: string;
      division: "A" | "B" | "C";
      rank: number;
      asOf: string;
    });

/** Verify that this finalized operation is included in the server's leaderboard row. */
export async function verifyRankedOperation({
  journal, operationKey, origin, apiBasePath, genesisHash, seasonId, accountId, actor, category, playerPublicKey, usdcMint, readEvidence,
}: RankedOperationContext & { journal: FileJournal; usdcMint: string; readEvidence: ReadRankedEvidence }): Promise<RankedOperationStatus> {
  uuid(seasonId);
  uuid(accountId);
  mint(playerPublicKey);
  mint(usdcMint);
  if (category !== "crypto-bro" || (actor !== "trading_bot" && actor !== "ai_agent")) {
    throw new Error("INVALID_RANKING_CONTEXT");
  }

  const { reservation, events } = await journal.read(operationKey);
  if (reservation.origin !== origin || reservation.apiBasePath !== apiBasePath ||
      (reservation.version === 2 && (reservation.accountId !== accountId || reservation.actor !== actor))) {
    throw new Error("RANKING_JOURNAL_MISMATCH");
  }
  const final = events.at(-1);
  if (final?.stage !== "FINAL_CONFIRMED") return { status: "not-finalized", ranked: false };

  const signed = events.find((event) => event.stage === "SIGNED");
  if (!final.intentId || !final.txid || signed?.intentId !== final.intentId ||
      signed.playerSignature !== final.txid || signed.playerPublicKey !== playerPublicKey ||
      signed.genesisHash !== genesisHash) {
    throw new Error("RANKING_JOURNAL_MISMATCH");
  }
  const { intentId, txid } = final;
  decode58(txid, 64);

  const request = Object.freeze({
    operationKey, origin, ...(apiBasePath ? { apiBasePath } : {}), genesisHash, seasonId, accountId, actor, category, playerPublicKey, intentId, txid,
  });
  let evidence: unknown;
  try {
    evidence = await readEvidence(request);
  } catch {
    throw new Error("RANKING_PROOF_UNAVAILABLE");
  }
  if (evidence === null) return { status: "ranking-pending", ranked: false, intentId, txid };

  try {
    const proof = closed(evidence, ["trade", "leaderboard"]);
    const trade = { ...closed(proof.trade, [...Object.keys(request), "amountInRaw", "amountOutRaw", "feeRaw"]) };
    if (Object.entries(request).some(([key, value]) => !Object.hasOwn(trade, key) || trade[key] !== value)) {
      throw new Error("INDEXED_TRADE_MISMATCH");
    }
    const amountInRaw = rawAmount(trade.amountInRaw);
    const amountOutRaw = rawAmount(trade.amountOutRaw);
    const feeRaw = trade.feeRaw === "0" ? "0" : rawAmount(trade.feeRaw);
    if (amountInRaw !== reservation.amountInRaw) throw new Error("INDEXED_TRADE_AMOUNT_MISMATCH");
    const fee = BigInt(feeRaw);
    const usdcGross = reservation.tokenInMint === usdcMint ? BigInt(amountInRaw) : BigInt(amountOutRaw) + fee;
    if (usdcGross > (1n << 64n) - 1n || fee !== usdcGross * 20n / 10_000n) {
      throw new Error("INDEXED_TRADE_FEE_MISMATCH");
    }

    const row = { ...closed(proof.leaderboard, [
      "seasonId", "accountId", "category", "division", "rank", "asOf", "includedIntentId", "includedTxid",
    ]) };
    const { division, rank, asOf } = row;
    if (row.seasonId !== seasonId || row.accountId !== accountId || row.category !== category ||
        row.includedIntentId !== intentId || row.includedTxid !== txid ||
        (division !== "A" && division !== "B" && division !== "C")) {
      throw new Error("LEADERBOARD_ROW_MISMATCH");
    }

    return {
      status: "ranked", ranked: true, intentId, txid, seasonId, accountId, division,
      rank: integer(rank, 1), asOf: new Date(timestamp(asOf)).toISOString(),
      amountInRaw, amountOutRaw, feeRaw,
    };
  } catch {
    throw new Error("RANKING_PROOF_MISMATCH");
  }
}

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { finalizeOperation, runOperation } from "../src/operation.ts";
import { verifyRankedOperation, type RankedEvidence, type RankedEvidenceRequest } from "../src/ranked-proof.ts";
import { asset, clock, harness, journalFor, syntheticId } from "./connected-harness.ts";

async function proofFixture(t: TestContext) {
  const { journal } = await journalFor(t);
  const { client, operation, ports, target } = harness();
  const context = {
    journal,
    operationKey: operation.operationKey,
    origin: client.origin,
    genesisHash: target.expectedGenesis,
    seasonId: operation.seasonId,
    accountId: syntheticId(4),
    actor: operation.actor,
    category: "crypto-bro" as const,
    playerPublicKey: operation.playerPublicKey,
    usdcMint: operation.tokenInMint,
  };
  const submitted = await runOperation(client, journal, operation, ports, () => clock);
  assert.equal(submitted.state, "SUBMITTED");
  const finalize = (status: "confirmed" | "failed") => finalizeOperation(
    client, journal, operation.operationKey, async (saved, expected) => ({
      status, commitment: "finalized", txid: saved.txid, genesisHash: expected.genesisHash,
    }),
  );
  return { context, finalize };
}

function proof(request: Readonly<RankedEvidenceRequest>): RankedEvidence {
  return {
    trade: { ...request, amountInRaw: "1000000", amountOutRaw: "998000", feeRaw: "2000" },
    leaderboard: {
      seasonId: request.seasonId,
      accountId: request.accountId,
      category: request.category,
      division: "B",
      rank: 7,
      asOf: new Date(clock).toISOString(),
      includedIntentId: request.intentId,
      includedTxid: request.txid,
    },
  };
}

test("submission and failed finalization cannot yield ranking evidence", async (t) => {
  const { context, finalize } = await proofFixture(t);
  let reads = 0;
  const verify = () => verifyRankedOperation({
    ...context,
    readEvidence: async () => { reads++; return null; },
  });
  const unranked = { status: "not-finalized", ranked: false };
  assert.deepEqual(await verify(), unranked);
  assert.equal(await finalize("failed"), "failed");
  assert.deepEqual(await verify(), unranked);
  assert.equal(reads, 0);
});

test("ranking remains pending until the indexed trade is included in the actual row", async (t) => {
  const { context, finalize } = await proofFixture(t);
  assert.equal(await finalize("confirmed"), "confirmed");
  const events = (await context.journal.read(context.operationKey)).events;
  const final = events.at(-1)!;
  const { intentId, txid } = final;
  assert.deepEqual(await verifyRankedOperation({
    ...context, readEvidence: async () => null,
  }), { status: "ranking-pending", ranked: false, intentId, txid });
  assert.deepEqual(await verifyRankedOperation({
    ...context,
    readEvidence: async (request) => {
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, {
        operationKey: context.operationKey, origin: context.origin, genesisHash: context.genesisHash,
        seasonId: context.seasonId, accountId: context.accountId, actor: context.actor, category: context.category,
        playerPublicKey: context.playerPublicKey, intentId, txid,
      });
      return proof(request);
    },
  }), {
    status: "ranked", ranked: true, intentId, txid,
    seasonId: context.seasonId, accountId: context.accountId, division: "B", rank: 7, asOf: new Date(clock).toISOString(),
    amountInRaw: "1000000", amountOutRaw: "998000", feeRaw: "2000",
  });
});

test("the reader cannot be invoked for a different journal target", async (t) => {
  const { context, finalize } = await proofFixture(t);
  assert.equal(await finalize("confirmed"), "confirmed");
  let reads = 0;
  for (const override of [
    { origin: "https://different.synthetic.invalid" },
    { genesisHash: asset(9) },
    { playerPublicKey: asset(10) },
  ]) {
    await assert.rejects(verifyRankedOperation({
      ...context, ...override, readEvidence: async () => { reads++; return null; },
    }), { message: "RANKING_JOURNAL_MISMATCH" });
  }
  assert.equal(reads, 0);
});

test("rejects mismatched trade and leaderboard fields and aggregate-only evidence", async (t) => {
  const { context, finalize } = await proofFixture(t);
  assert.equal(await finalize("confirmed"), "confirmed");
  const invalidTradeFields = {
    operationKey: "synthetic-operation-two", origin: "https://different.synthetic.invalid", genesisHash: asset(9),
    seasonId: syntheticId(91), accountId: syntheticId(92), actor: "ai_agent", category: "whale",
    playerPublicKey: asset(10), intentId: syntheticId(93), txid: "other-txid",
    amountInRaw: "999999", amountOutRaw: "0", feeRaw: "-1",
  };
  const invalidRowFields = {
    seasonId: syntheticId(91), accountId: syntheticId(92), category: "whale", division: "D", rank: 0,
    asOf: "yesterday", includedIntentId: syntheticId(93), includedTxid: "other-txid",
  };
  for (const [component, changes] of [["trade", invalidTradeFields], ["leaderboard", invalidRowFields]] as const) {
    for (const [field, value] of Object.entries(changes)) {
      await assert.rejects(verifyRankedOperation({
        ...context,
        readEvidence: async (request) => {
          const evidence = proof(request);
          return { ...evidence, [component]: { ...evidence[component], [field]: value } };
        },
      }), { message: "RANKING_PROOF_MISMATCH" }, `${component}.${field}`);
    }
  }
  await assert.rejects(verifyRankedOperation({
    ...context,
    readEvidence: async (request) => {
      const { trade, leaderboard } = proof(request);
      const { includedIntentId: _intent, includedTxid: _txid, ...aggregateRow } = leaderboard;
      return { trade, leaderboard: aggregateRow } as RankedEvidence;
    },
  }), { message: "RANKING_PROOF_MISMATCH" });
});

test("unavailable evidence fails without exposing underlying reader errors", async (t) => {
  const { context, finalize } = await proofFixture(t);
  assert.equal(await finalize("confirmed"), "confirmed");
  await assert.rejects(verifyRankedOperation({
    ...context,
    readEvidence: async () => { throw new Error("synthetic sensitive transport detail"); },
  }), { message: "RANKING_PROOF_UNAVAILABLE" });
});

test("both USDC legs enforce the exact raw 20 bps fee", async (t) => {
  const { context, finalize } = await proofFixture(t);
  assert.equal(await finalize("confirmed"), "confirmed");
  for (const [usdcMint, amountOutRaw, expectedFee] of [
    [context.usdcMint, "998000", "2000"],
    [asset(9), "996004", "1996"],
    [asset(9), "498", "0"],
  ] as const) {
    const verify = (feeRaw: string) => verifyRankedOperation({
      ...context, usdcMint, readEvidence: async (request) => {
        const evidence = proof(request);
        Object.assign(evidence.trade, { amountOutRaw, feeRaw });
        return evidence;
      },
    });
    assert.equal((await verify(expectedFee)).ranked, true);
    const invalidFee = expectedFee === "0" ? "1" : (BigInt(expectedFee) / 2n).toString();
    await assert.rejects(verify(invalidFee), { message: "RANKING_PROOF_MISMATCH" });
    if (expectedFee !== "0") await assert.rejects(verify("0"), { message: "RANKING_PROOF_MISMATCH" });
  }
});

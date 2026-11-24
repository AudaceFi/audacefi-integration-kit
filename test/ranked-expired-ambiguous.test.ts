import assert from "node:assert/strict";
import { test } from "node:test";
import { AudaceFiClient, type FetchPort, type TerminalUnsent } from "../src/client.ts";
import { FileJournal } from "../src/journal.ts";
import { openRankedSignalOperator, SOLANA_DEVNET_GENESIS, type RankedSignalSetup } from "../src/ranked-signal.ts";
import { decodeLegacy } from "../src/solana.ts";
import { asset, journalFor, syntheticId } from "./connected-harness.ts";
import { referenceHarness } from "./reference-harness.ts";

test("Degen recovery closes an expired ambiguous send in place and permits the next ranked signal", async (t) => {
  const h = referenceHarness("buy", "ai_agent", "root", "degen");
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  h.setNow(now);
  Object.assign(h.state.season.active, { startsAt: iso(-60_000), endsAt: iso(600_000) });
  h.state.asOf = iso();
  h.quoteWire.expiresAt = iso(60_000);
  h.allowlist.tokens[0].symbol = "USDC";
  h.allowlist.tokens[1].symbol = "TEST";
  const playerPublicKey = h.operation.playerPublicKey;
  h.putToken(playerPublicKey, asset(3), 5_000_000n);
  h.putToken(playerPublicKey, asset(4), 0n);

  const profile = { ...h.profile, apiOrigin: "https://audacefi-ranked-validation.invalid",
    expectedGenesis: SOLANA_DEVNET_GENESIS, singleSwapFeeBps: 20 as const,
    apiApproval: { ...h.profile.apiApproval, validFromMs: now - 60_000, expiresAtMs: now + 600_000 } };
  h.controls.rpcGenesis = profile.expectedGenesis;
  const firstIntent = h.quote.intentId;
  const writes: string[] = [];
  let terminal: TerminalUnsent | undefined;
  let originalTransaction: string | undefined;
  const transport: FetchPort = async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "POST") writes.push(path.split("/").at(-1)!);
    if (path === "/v1/me/allowlist") return Response.json(h.allowlist);
    if (path.endsWith("/quote")) return Response.json(h.quoteWire);
    if (path === `/v1/swap-intents/${firstIntent}/submit-durable`) {
      originalTransaction = JSON.parse(String(init.body)).transaction;
      throw new Error("SYNTHETIC_DURABLE_REQUEST_LOST");
    }
    const response = await h.transport(url, init);
    if (path === `/v1/swap-intents/${firstIntent}/submission` && terminal) {
      const wire = await response.json();
      assert.equal(wire.submission, null);
      return Response.json({ ...wire, terminalUnsent: terminal });
    }
    if (path.endsWith("/result")) {
      assert.equal(path, `/v1/swap-intents/${h.quote.intentId}/result`);
      assert.equal((await response.clone().json()).status, "confirmed");
      h.putToken(playerPublicKey, asset(3), 4_000_000n);
      h.putToken(playerPublicKey, asset(4), 499_000n);
    }
    return response;
  };

  const journalPolicy = { maxOperations: 4, inputBudgets: { [asset(1)]: "2000000", [asset(2)]: "999000" } };
  const { directory, journal } = await journalFor(t, journalPolicy);
  let finalizedHeight = 500;
  let latestBlockhash = asset(80);
  let lastValidBlockHeight = 1000;
  const setup: RankedSignalSetup = {
    client: new AudaceFiClient({ origin: profile.apiOrigin, credential: () => "synthetic-api-credential", writes: "explicitly-authorized", transport }),
    rpc: { call: (method, params) => {
      if (method === "getBlockHeight") {
        assert.equal((params[0] as { commitment?: string }).commitment, "finalized");
        return Promise.resolve(finalizedHeight);
      }
      if (method === "getLatestBlockhash") return Promise.resolve({ context: { slot: h.controls.rpcSlot },
        value: { blockhash: latestBlockhash, lastValidBlockHeight } });
      return h.rpc.call(method, params);
    } },
    wallet: h.wallet, profile, journalDirectory: directory, journalPolicy, actor: "ai_agent", category: "degen",
    accountId: syntheticId(20), seasonId: h.operation.seasonId, playerPublicKey, source: "synthetic-expiry-test",
    pair: { symbol: "TEST", assetMint: asset(2), maxEntryBps: 2000, maxPositionRaw: "499500", exitAttempts: 2, minimumFlatOutRaw: "990000" },
    assertValidationTarget: async () => {},
    readEvidence: async request => {
      assert.equal(request.intentId, h.quote.intentId);
      assert.notEqual(request.intentId, firstIntent);
      return {
        trade: { ...request, amountInRaw: "1000000", amountOutRaw: "499000", feeRaw: "2000" },
        leaderboard: { seasonId: request.seasonId, accountId: request.accountId, category: request.category, division: "B", rank: 3,
          asOf: iso(), includedIntentId: request.intentId, includedTxid: request.txid },
      };
    },
  };
  const signal = (sequence: number) => JSON.stringify({ id: `synthetic-expiry-${sequence}`, sequence, symbol: "TEST",
    side: "long", targetBps: 2000, expiresAtMs: now + 30_000 });
  const first = signal(1);
  const pending = await (await openRankedSignalOperator(setup, "validation")).accept(first);
  assert.equal(pending.status, "finality-pending");
  assert.deepEqual(writes, ["swap-intents", "quote", "signature", "submit-durable"]);
  assert.ok(originalTransaction);
  const oldBlockhash = decodeLegacy(originalTransaction).blockhash;
  const record = await journal.read(pending.operationKey);
  assert.equal(record.events.at(-1)?.stage, "AMBIGUOUS");
  assert.ok(record.events.some(event => event.stage === "SENDING"));
  const signed = record.events.find(event => event.stage === "SIGNED");
  assert.ok(signed?.playerSignature && signed.intentId === firstIntent);

  const { accept } = await openRankedSignalOperator(setup, "validation");
  const { walletCalls, keyCalls } = h.counts();
  finalizedHeight = 1001;
  h.controls.blockhashValid = false;
  h.controls.finalMissing = true;
  assert.equal((await accept(first)).status, "finality-pending");
  await assert.rejects(accept(signal(2)), /RANKED_SIGNAL_PENDING/);

  terminal = { protocol: "audacefi.bench.terminal-unsent.v1", intentId: firstIntent, playerSignature: signed.playerSignature, status: "failed" };
  finalizedHeight = 1000;
  assert.equal((await accept(first)).status, "finality-pending");
  finalizedHeight = 1001;
  h.controls.blockhashValid = true;
  assert.equal((await accept(first)).status, "finality-pending");
  h.controls.blockhashValid = false;
  h.controls.finalMissing = false;
  h.controls.finalStatus = "confirmed";
  assert.equal((await accept(first)).status, "finality-pending");

  h.controls.finalMissing = true;
  const closed = await accept(first);
  assert.deepEqual(closed, { status: "closed-unranked", ranked: false, operationKey: pending.operationKey, positionAfterRaw: "0", reason: "unsent" });
  assert.deepEqual((await journal.read(pending.operationKey)).events.at(-1), {
    stage: "EXPIRED_UNSENT", intentId: firstIntent, txid: signed.playerSignature, serverAttested: true,
  });
  const blockhashCall = h.rpcCalls.findLast(call => call.method === "isBlockhashValid");
  assert.equal(blockhashCall?.params[0], oldBlockhash);
  assert.equal(blockhashCall?.params[1].commitment, "finalized");
  assert.deepEqual(h.rpcCalls.findLast(call => call.method === "getSignatureStatuses")?.params,
    [[signed.playerSignature], { searchTransactionHistory: true }]);

  terminal = undefined;
  assert.deepEqual(await (await openRankedSignalOperator(setup, "validation")).accept(first), closed);
  assert.deepEqual(writes, ["swap-intents", "quote", "signature", "submit-durable"]);
  assert.equal(h.counts().walletCalls, walletCalls);
  assert.equal(h.counts().keyCalls, keyCalls);
  const capacity = await journal.capacity();
  assert.equal(capacity.unresolvedOperations, 0);
  assert.equal(capacity.reservedOperations, 1);
  assert.equal(capacity.budgets[asset(1)]?.remainingRaw, "1000000");

  h.quote.intentId = syntheticId(7);
  Object.assign(h.quoteWire, { intentId: h.quote.intentId, quoteId: syntheticId(8) });
  latestBlockhash = asset(81);
  lastValidBlockHeight = 2000;
  h.controls.blockhashValid = true;
  h.controls.finalMissing = false;
  h.controls.finalStatus = "finalized";
  const next = await accept(signal(2));
  assert.equal(next.ranked, true);
  assert.equal(next.positionAfterRaw, "499000");
  assert.deepEqual(writes, ["swap-intents", "quote", "signature", "submit-durable", "swap-intents", "quote", "signature", "submit-durable", "result"]);
  assert.equal(h.counts().walletCalls, walletCalls + 1);
  assert.equal((await journal.capacity()).reservedOperations, 2);
});

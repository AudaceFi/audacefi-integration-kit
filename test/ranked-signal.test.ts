import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AudaceFiClient, type FetchPort } from "../src/client.ts";
import { FileJournal } from "../src/journal.ts";
import { officialApprovalDeploymentDigest, officialApprovalSigningBytes, type OfficialApprovalPayload } from "../src/official-approval.ts";
import { abandonOperation, finalizeOperation, reconcileOperation } from "../src/operation.ts";
import { createOfficialRankedSignalGateway, createRankedSignalGateway, officialRankedApprovalBindings, openRankedSignalOperator, SOLANA_DEVNET_GENESIS, type OfficialRankedSignalSetup, type RankedSignalSetup } from "../src/ranked-signal.ts";
import { associatedAddress, encode58 } from "../src/solana.ts";
import { asset, journalFor, syntheticId } from "./connected-harness.ts";
import { referenceHarness } from "./reference-harness.ts";

const buy = { amountInRaw: "1000000", amountOutRaw: "499000", feeRaw: "2000" };
const sell = { amountInRaw: "499000", amountOutRaw: "996004", feeRaw: "1996" };
const postLifecycle = ["swap-intents", "quote", "signature", "submit-durable", "result"];

async function rankedFixture(t: TestContext, recoveryExit?: RankedSignalSetup["pair"]["recoveryExit"]) {
  const h = referenceHarness();
  const now = Date.now();
  h.setNow(now);
  Object.assign(h.state.season.active, {
    startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 600_000).toISOString(),
  });
  h.state.asOf = new Date(now).toISOString();
  h.quoteWire.expiresAt = new Date(now + 60_000).toISOString();
  const profile = {
    ...h.profile,
    apiOrigin: "https://audacefi-ranked-validation.invalid",
    expectedGenesis: SOLANA_DEVNET_GENESIS,
    singleSwapFeeBps: 20 as const,
    apiApproval: { ...h.profile.apiApproval, validFromMs: now - 60_000, expiresAtMs: now + 600_000 },
  };
  h.controls.rpcGenesis = profile.expectedGenesis;
  h.allowlist.tokens[0].symbol = "USDC";
  h.allowlist.tokens[1].symbol = "TEST";
  const playerPublicKey = h.operation.playerPublicKey;
  h.putToken(playerPublicKey, asset(3), 5_000_000n);
  h.putToken(playerPublicKey, asset(4), 0n);

  const fills = new Map<string, typeof buy>();
  const results = new Map<string, "confirmed" | "failed">();
  const created = new Map<string, string>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const controls = {
    wrongFee: false, proofPending: false, loseResultResponse: false, preflights: 0,
    stateFailure: false, resultStatusOverride: undefined as "confirmed" | "failed" | null | undefined,
    omitResultStatus: false, loseBeforeResult: false, loseCreate: undefined as "before" | "after" | undefined,
    loseSignature: undefined as "before" | "after" | undefined, omitIntentBinding: false, loseDurable: false,
  };
  const transport: FetchPort = async (url, init) => {
    const target = new URL(url);
    const method = init.method!;
    assert.equal(target.origin, profile.apiOrigin);
    const body = method === "POST" ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (body) writes.push({ path: target.pathname, body });
    if (target.pathname === "/v1/me/state" && controls.stateFailure) return new Response(null, { status: 503 });
    if (target.pathname === "/v1/me/allowlist") {
      h.calls.push({ path: target.pathname, method, body: null });
      return Response.json(h.allowlist);
    }
    if (target.pathname.endsWith("/quote")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.amountInRaw, h.quoteWire.amountInRaw);
      h.calls.push({ path: target.pathname, method, body });
      return Response.json(h.quoteWire);
    }
    if (target.pathname === "/v1/swap-intents") {
      if (controls.loseCreate === "before") throw new Error("SYNTHETIC_CREATE_LOST");
      const { inputBinding, ...original } = body!;
      const key = String(original.idempotencyKey);
      const serialized = JSON.stringify(original);
      const replayed = created.has(key);
      if (replayed && created.get(key) !== serialized) return new Response(null, { status: 409 });
      created.set(key, serialized);
      const response = await h.transport(url, init);
      if (controls.loseCreate === "after") throw new Error("SYNTHETIC_CREATE_RESPONSE_LOST");
      return Response.json({ ...await response.json(), replayed, ...(!controls.omitIntentBinding && inputBinding ? { inputBinding } : {}) });
    }
    if (target.pathname.endsWith("/signature") && controls.loseSignature === "before") throw new Error("SYNTHETIC_SIGNATURE_LOST");
    if (target.pathname.endsWith("/submit-durable") && controls.loseDurable) throw new Error("SYNTHETIC_DURABLE_LOST");
    if (target.pathname.endsWith("/result") && controls.loseBeforeResult) throw new Error("SYNTHETIC_RESULT_LOST");
    const response = await h.transport(url, init);
    if (target.pathname.endsWith("/signature") && controls.loseSignature === "after") throw new Error("SYNTHETIC_SIGNATURE_RESPONSE_LOST");
    if (target.pathname.endsWith("/submission") && response.ok) {
      if (controls.omitResultStatus) return response;
      const intentId = target.pathname.split("/").at(-2)!;
      const resultStatus = controls.resultStatusOverride === undefined ? results.get(intentId) ?? null : controls.resultStatusOverride;
      return Response.json({ ...await response.json(), resultStatus });
    }
    if (target.pathname.endsWith("/result")) {
      const intentId = target.pathname.split("/").at(-2)!;
      const status = body?.status;
      assert.ok(status === "confirmed" || status === "failed");
      assert.ok(!results.has(intentId));
      results.set(intentId, status);
      if (status === "confirmed") {
        const isBuy = h.quoteWire.direction === "buy";
        fills.set(intentId, isBuy ? buy : sell);
        h.putToken(playerPublicKey, asset(3), isBuy ? 4_000_000n : 4_996_004n);
        h.putToken(playerPublicKey, asset(4), isBuy ? 499_000n : 0n);
      }
      if (controls.loseResultResponse) throw new Error("SYNTHETIC_RESULT_RESPONSE_LOST");
    }
    return response;
  };
  const exitAttempts = 2 + (recoveryExit?.attempts ?? 0);
  const journalPolicy = { maxOperations: 1 + exitAttempts, inputBudgets: { [asset(1)]: "1000000", [asset(2)]: String(499500 * exitAttempts) } };
  const { directory } = await journalFor(t, journalPolicy);
  const setup: RankedSignalSetup = {
    client: new AudaceFiClient({
      origin: profile.apiOrigin, credential: () => "synthetic-api-credential", writes: "explicitly-authorized", transport,
    }),
    rpc: h.rpc,
    wallet: h.wallet,
    profile,
    journalDirectory: directory,
    journalPolicy,
    actor: "trading_bot",
    accountId: syntheticId(20),
    seasonId: h.operation.seasonId,
    playerPublicKey,
    source: "synthetic-python",
    pair: { symbol: "TEST", assetMint: asset(2), maxEntryBps: 2000, maxPositionRaw: "499500", exitAttempts: 2, minimumFlatOutRaw: "990000",
      ...(recoveryExit ? { recoveryExit } : {}) },
    assertValidationTarget: async () => { controls.preflights++; },
    readEvidence: async (request) => {
      if (controls.proofPending) return null;
      const fill = fills.get(request.intentId);
      assert.ok(fill);
      const signature = h.calls.find(c => c.path === `/v1/swap-intents/${request.intentId}/signature`);
      assert.equal(signature?.body.signature, request.txid);
      return {
        trade: { ...request, ...fill, feeRaw: controls.wrongFee ? "1000" : fill.feeRaw },
        leaderboard: {
          seasonId: request.seasonId, accountId: request.accountId, category: request.category,
          division: "B", rank: 3, asOf: new Date(now).toISOString(),
          includedIntentId: request.intentId, includedTxid: request.txid,
        },
      };
    },
  };
  const open = () => createRankedSignalGateway(setup);
  const signal = (side: "long" | "flat", sequence: number, id = `ranked-${side}-${sequence}`, symbol = "TEST") => JSON.stringify({
    id, sequence, symbol, side, targetBps: side === "long" ? 2000 : 0, expiresAtMs: now + 30_000,
  });
  const prepareSell = (intentNumber = 7) => {
    h.quote.intentId = syntheticId(intentNumber);
    Object.assign(h.quoteWire, { intentId: h.quote.intentId, quoteId: syntheticId(intentNumber + 1), direction: "sell", amountInRaw: sell.amountInRaw });
  };
  const posts = () => h.calls.filter(c => c.method === "POST").map(c => c.path.split("/").at(-1));
  const holdings = () => [asset(3), asset(4)].map(mint => {
    const token = h.accounts.get(associatedAddress(playerPublicKey, mint));
    return Buffer.from(token.data[0], "base64").readBigUInt64LE(64);
  });
  return { h, setup, open, controls, signal, prepareSell, posts, holdings, transport, writes };
}

test("ranked readiness scope stays stable and binds the actual gateway and journal", async (t) => {
  const { h, setup, controls, signal } = await rankedFixture(t);
  const { directory } = await journalFor(t, setup.journalPolicy);
  const { runScope, accept } = await openRankedSignalOperator(setup, "validation");
  assert.match(runScope, /^[0-9a-f]{64}$/);
  assert.equal((await openRankedSignalOperator(setup, "validation")).runScope, runScope);
  const { apiApproval } = setup.profile;
  const refreshed = { ...setup.profile, apiApproval: { ...apiApproval, expiresAtMs: apiApproval.expiresAtMs + 60_000 } };
  assert.equal((await openRankedSignalOperator({ ...setup, profile: refreshed }, "validation")).runScope, runScope);
  for (const changes of [
    { accountId: syntheticId(21) },
    { seasonId: syntheticId(22) },
    { playerPublicKey: asset(9) },
    { profile: { ...setup.profile, programDataSha256: "0".repeat(64) } },
    { pair: { ...setup.pair, maxEntryBps: 1000 } },
    { journalDirectory: directory },
  ]) {
    assert.notEqual((await openRankedSignalOperator({ ...setup, ...changes }, "validation")).runScope, runScope);
  }
  await assert.rejects(openRankedSignalOperator({
    ...setup, journalPolicy: { ...setup.journalPolicy, maxOperations: 4 },
  }, "validation"), /JOURNAL_POLICY_CHANGED/);
  await unlink(join(setup.journalDirectory, "ranked-run-id"));
  assert.notEqual((await openRankedSignalOperator(setup, "validation")).runScope, runScope);
  await assert.rejects(accept(signal("long", 1)), /RANKED_RUN_SCOPE_CHANGED/);
  assert.deepEqual(h.calls, []);
  assert.equal(controls.preflights, 0);
});

test("ranked CLI emits optional ready scope and refuses unscoped or wrong-scope signals before admission", async (t) => {
  const { setup, signal } = await rankedFixture(t);
  const { client: _client, rpc: _rpc, wallet: _wallet, assertValidationTarget: _approve, readEvidence: _read, ...data } = setup;
  const operator = join(setup.journalDirectory, "synthetic-ready.mjs");
  await writeFile(operator, `
import { AudaceFiClient } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
const data = ${JSON.stringify(data)};
const forbidden = () => { throw new Error("Unexpected startup I/O."); };
export default {
  ...data,
  client: new AudaceFiClient({ origin: data.profile.apiOrigin, writes: "explicitly-authorized", credential: forbidden, transport: forbidden }),
  rpc: { call: forbidden }, wallet: { publicKey: forbidden, sign: forbidden },
  assertValidationTarget: forbidden, readEvidence: forbidden,
};
`);
  const run = (mode: string, input = "") => spawnSync(process.execPath, [
    "--import", new URL("../scripts/offline-guard.mjs", import.meta.url).href,
    fileURLToPath(new URL("../src/ranked-signal-cli.ts", import.meta.url)),
    "--execute", "--operator", operator, mode,
  ], { encoding: "utf8", input });
  const { runScope } = await openRankedSignalOperator(setup, "validation");
  const ordinary = run("--emit-ready");
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.stdout, '{"status":"ready"}\n');
  const scoped = run("--emit-ready-scope");
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(scoped.stdout), { status: "ready", runScope });
  const payload = signal("long", 1);
  const wrongScope = run("--emit-ready", `${payload}\n${JSON.stringify({ runScope: "0".repeat(64), signal: payload })}\n`);
  assert.equal(wrongScope.status, 0, wrongScope.stderr);
  assert.deepEqual(wrongScope.stdout.trim().split("\n").map(line => JSON.parse(line).status), ["ready", "rejected", "scope-mismatch"]);
});

test("ranked gateway completes long then flat with exact 20 bps and never resubmits", async (t) => {
  const { h, open, signal, prepareSell, posts, holdings } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  const flat = signal("flat", 2);
  h.controls.finalStatus = "confirmed";
  assert.equal((await accept(long)).status, "finality-pending");
  assert.deepEqual(posts(), postLifecycle.slice(0, -1));
  await assert.rejects(accept(flat), /RANKED_SIGNAL_PENDING/);

  h.controls.finalStatus = "finalized";
  const entered = await (await open())(long);
  assert.ok(entered.ranked);
  assert.deepEqual([entered.amountInRaw, entered.amountOutRaw, entered.feeRaw, entered.simulatedFeeBps, entered.positionAfterRaw],
    [buy.amountInRaw, buy.amountOutRaw, buy.feeRaw, 20, buy.amountOutRaw]);
  assert.deepEqual(holdings(), [4_000_000n, 499_000n]);
  await assert.rejects(accept(signal("flat", 1)), /RANKED_SIGNAL_SEQUENCE_CONFLICT/);
  await assert.rejects(accept(signal("flat", 2, "ranked-long-1")), /RANKED_SIGNAL_ID_CONFLICT/);
  assert.deepEqual(posts(), postLifecycle);

  prepareSell();
  const exited = await accept(flat);
  assert.ok(exited.ranked);
  assert.notEqual(exited.txid, entered.txid);
  assert.notEqual(exited.intentId, entered.intentId);
  assert.deepEqual([exited.amountInRaw, exited.amountOutRaw, exited.feeRaw, exited.simulatedFeeBps, exited.positionAfterRaw],
    [sell.amountInRaw, sell.amountOutRaw, sell.feeRaw, 20, "0"]);
  assert.deepEqual(holdings(), [4_996_004n, 0n]);
  const reopened = await open();
  assert.deepEqual(await reopened(long), entered);
  assert.deepEqual(await reopened(flat), exited);
  assert.deepEqual(posts(), [...postLifecycle, ...postLifecycle]);
  assert.equal(h.counts().walletCalls, 2);
});

test("ranked gateway refuses unapproved signals and profiles before writes", async (t) => {
  const { h, setup, open, controls, signal, posts } = await rankedFixture(t);
  await assert.rejects(createRankedSignalGateway({ ...setup, profile: { ...setup.profile, singleSwapFeeBps: 10 } }),
    /RANKED_VALIDATION_PROFILE_REQUIRED/);
  const accept = await open();
  await assert.rejects(accept(signal("long", 1, "ranked-unknown", "OTHER")), /SIGNAL_PAIR_NOT_ALLOWED/);
  await assert.rejects(accept(signal("flat", 1)), /RANKED_SIGNAL_ORDER/);
  assert.equal(controls.preflights, 0);
  h.allowlist.tokens[1].symbol = "OTHER";
  await assert.rejects(accept(signal("long", 1)), /RANKED_SYMBOL_NOT_ALLOWLISTED/);
  assert.deepEqual(posts(), []);
  assert.equal(h.counts().walletCalls, 0);
});

test("ranked gateway refuses to transmit a signature when the position changes at the wallet", async (t) => {
  const { h, setup, open, signal, posts } = await rankedFixture(t);
  const sign = setup.wallet.signTransaction;
  setup.wallet.signTransaction = async transaction => {
    const signed = await sign(transaction);
    h.putToken(setup.playerPublicKey, asset(4), 1n);
    return signed;
  };
  const receipt = await (await open())(signal("long", 1));
  const operationKey = h.calls.find(call => call.path === "/v1/swap-intents")!.body.idempotencyKey;
  assert.deepEqual(receipt, { status: "review-required", ranked: false, operationKey });
  assert.deepEqual(posts(), postLifecycle.slice(0, 2));
});

test("ranked gateway waits for indexing and rejects a 10 bps fill without another POST", async (t) => {
  const { open, controls, signal, posts } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  controls.proofPending = true;
  const pending = await accept(long);
  assert.equal(pending.status, "ranking-pending");
  assert.equal(pending.ranked, false);
  assert.deepEqual(posts(), postLifecycle);

  controls.proofPending = false;
  controls.wrongFee = true;
  await assert.rejects(accept(long), /RANKING_PROOF_MISMATCH/);
  await assert.rejects(accept(signal("flat", 2)), /RANKED_SIGNAL_PENDING/);
  assert.deepEqual(posts(), postLifecycle);

  controls.wrongFee = false;
  const receipt = await (await open())(long);
  assert.ok(receipt.ranked);
  assert.equal(receipt.intentId, pending.intentId);
  assert.equal(receipt.txid, pending.txid);
  assert.equal(receipt.feeRaw, buy.feeRaw);
  assert.deepEqual(posts(), postLifecycle);
});

test("a lost result response reconciles only exact server status and never retries the POST", async (t) => {
  const { open, controls, signal, posts } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  controls.loseResultResponse = true;
  await assert.rejects(accept(long), /TRANSPORT_FAILURE/);
  assert.deepEqual(posts(), postLifecycle);

  controls.loseResultResponse = false;
  controls.omitResultStatus = true;
  const receipt = await (await open())(long);
  assert.equal(receipt.status, "review-required");
  assert.equal(receipt.ranked, false);
  assert.ok(receipt.intentId && receipt.txid);
  await assert.rejects(accept(signal("flat", 2)), /RANKED_SIGNAL_PENDING/);
  controls.omitResultStatus = false;
  controls.resultStatusOverride = "failed";
  await assert.rejects(accept(long), /FINAL_RESULT_STATUS_MISMATCH/);
  controls.resultStatusOverride = undefined;
  const recovered = await (await open())(long);
  assert.ok(recovered.ranked);
  assert.equal(recovered.txid, receipt.txid);
  assert.deepEqual(posts(), postLifecycle);
});

for (const timing of ["before", "after"] as const) {
  test(`an exact ranked signal recovers a create lost ${timing} processing under the same server key`, async (t) => {
    const { h, open, controls, signal, writes } = await rankedFixture(t);
    const long = signal("long", 1);
    controls.loseCreate = timing;
    assert.equal((await (await open())(long)).status, "review-required");
    assert.equal(h.counts().walletCalls, 0);
    const restart = await open();
    await assert.rejects(restart(" " + long), /RANKED_SIGNAL_ID_CONFLICT/);
    await assert.rejects(restart(signal("long", 2)), /RANKED_SIGNAL_PENDING/);
    controls.loseCreate = undefined;
    assert.ok((await restart(long)).ranked);
    const [first, second] = writes.filter(write => write.path === "/v1/swap-intents").map(write => write.body);
    assert.deepEqual(second, { ...first, inputBinding: "audacefi.swap-intent-input.v1" });
    assert.equal(writes.filter(write => write.path.endsWith("/submit-durable")).length, 1);
    assert.equal(h.counts().walletCalls, 1);
  });

  test(`a signature write lost ${timing} processing resumes the old signature without another wallet call`, async (t) => {
    const { h, open, controls, signal, writes } = await rankedFixture(t);
    const long = signal("long", 1);
    controls.loseSignature = timing;
    assert.equal((await (await open())(long)).status, "review-required");
    assert.equal(h.counts().walletCalls, 1);
    controls.loseSignature = undefined;
    assert.ok((await (await open())(long)).ranked);
    const [first, second] = writes.filter(write => write.path.endsWith("/signature"));
    assert.deepEqual(second, first);
    assert.equal(writes.filter(write => write.path.endsWith("/submit-durable")).length, 1);
    assert.equal(h.counts().walletCalls, 1);
  });
}

test("a legacy server cannot authorize continuation of an uncertain create", async (t) => {
  const { h, open, controls, signal, writes } = await rankedFixture(t);
  const long = signal("long", 1);
  controls.loseCreate = "after";
  assert.equal((await (await open())(long)).status, "review-required");
  controls.loseCreate = undefined;
  controls.omitIntentBinding = true;
  assert.equal((await (await open())(long)).status, "review-required");
  assert.equal(h.counts().walletCalls, 0);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.path === "/v1/swap-intents"));
});

test("a pre-transmission approval refusal after signing preserves the original bytes", async (t) => {
  const { h, open, setup, signal, writes } = await rankedFixture(t);
  const long = signal("long", 1);
  let blocked = true;
  setup.assertValidationTarget = async () => {
    if (blocked && h.counts().walletCalls === 1) throw new Error("SYNTHETIC_APPROVAL_REFUSAL");
  };
  assert.equal((await (await open())(long)).status, "review-required");
  assert.deepEqual(writes.map(write => write.path.split("/").at(-1)), ["swap-intents", "quote"]);
  blocked = false;
  assert.ok((await (await open())(long)).ranked);
  assert.equal(h.counts().walletCalls, 1);
  assert.equal(writes.filter(write => write.path.endsWith("/submit-durable")).length, 1);
});

for (const sent of [false, true]) {
  test(`a signed flat ${sent ? "with" : "without"} a possible durable send handles definitive expiry conservatively`, async (t) => {
    const { h, open, setup, controls, signal, prepareSell, writes } = await rankedFixture(t);
    const originalRpc = setup.rpc;
    let finalizedHeight = 500;
    setup.rpc = { call: (method, args) => method === "getBlockHeight" ? Promise.resolve(finalizedHeight) : originalRpc.call(method, args) };
    assert.ok((await (await open())(signal("long", 1))).ranked);
    prepareSell();
    const flat = signal("flat", 2);
    if (sent) controls.loseDurable = true;
    else controls.loseSignature = "after";
    assert.equal((await (await open())(flat)).status, sent ? "finality-pending" : "review-required");
    const { recoverExit } = await openRankedSignalOperator(setup, "validation");
    await assert.rejects(recoverExit(signal("flat", 3)), /RANKED_SIGNAL_PENDING/);
    await assert.rejects(recoverExit(flat), /RANKED_SIGNAL_MODE_CONFLICT/);
    controls.loseDurable = false;
    controls.loseSignature = undefined;
    h.controls.blockhashValid = false;
    const before = writes.length;
    const receipt = await (await open())(flat);
    assert.equal(receipt.status, sent ? "finality-pending" : "review-required");
    finalizedHeight = 1001;
    const expired = await (await open())(flat);
    if (sent) {
      assert.equal(expired.status, "finality-pending");
    } else {
      assert.ok(expired.status === "closed-unranked" && expired.reason === "unsent");
      assert.equal(expired.positionAfterRaw, buy.amountOutRaw);
    }
    assert.equal(writes.length, before);
    assert.equal(h.counts().walletCalls, 2);
  });
}

test("a lost-before-server result is recorded once after matching exact durable and finalized evidence", async (t) => {
  const { h, open, controls, signal, writes } = await rankedFixture(t);
  const long = signal("long", 1);
  controls.loseBeforeResult = true;
  await assert.rejects((await open())(long), /TRANSPORT_FAILURE/);
  controls.loseBeforeResult = false;
  assert.ok((await (await open())(long)).ranked);
  const [first, second] = writes.filter(write => write.path.endsWith("/result"));
  assert.deepEqual(second, first);
  assert.equal(writes.filter(write => write.path.endsWith("/submit-durable")).length, 1);
  assert.equal(h.counts().walletCalls, 1);
});

test("only the exact saved signal may resume a pre-reservation read failure", async (t) => {
  const { setup, open, controls, signal, posts } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  controls.stateFailure = true;
  await assert.rejects(accept(long), /HTTP_503/);
  const journal = await FileJournal.create(setup.journalDirectory, setup.journalPolicy);
  assert.equal((await journal.capacity()).reservedOperations, 0);
  assert.deepEqual(posts(), []);
  controls.stateFailure = false;
  await assert.rejects(accept(" " + long), /RANKED_SIGNAL_ID_CONFLICT/);
  await assert.rejects(accept(signal("long", 2)), /RANKED_SIGNAL_PENDING/);
  assert.ok((await (await open())(long)).ranked);
  assert.deepEqual(posts(), postLifecycle);
});

test("an expired pre-reservation signal closes locally without a POST", async (t) => {
  const { open, controls, signal, posts } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  controls.stateFailure = true;
  await assert.rejects(accept(long), /HTTP_503/);
  const expired = Date.now() + 60_000;
  t.mock.method(Date, "now", () => expired);
  const closed = await accept(long);
  assert.equal(closed.status, "closed-unranked");
  assert.ok(closed.status === "closed-unranked" && closed.reason === "unsent" && closed.positionAfterRaw === "0");
  assert.deepEqual(await accept(long), closed);
  assert.deepEqual(posts(), []);
});

test("a guarded first write closes an UNSENT inbox row and retains its reservation", async (t) => {
  const { setup, signal, posts } = await rankedFixture(t);
  const journal = await FileJournal.create(setup.journalDirectory, setup.journalPolicy);
  let refuse = true;
  const accept = await createRankedSignalGateway({ ...setup, assertValidationTarget: async () => {
    if (refuse && (await journal.capacity()).reservedOperations > 0) throw new Error("SYNTHETIC_WRITE_REFUSAL");
  } });
  const long = signal("long", 1);
  const closed = await accept(long);
  assert.ok(closed.status === "closed-unranked" && closed.reason === "unsent" && closed.positionAfterRaw === "0");
  assert.equal((await journal.capacity()).reservedOperations, 1);
  assert.equal((await journal.read(closed.operationKey)).events.at(-1)?.stage, "UNSENT");
  refuse = false;
  assert.deepEqual(await accept(long), closed);
  assert.deepEqual(posts(), []);
});

test("an explicitly abandoned unsigned intention closes its ranked inbox row", async (t) => {
  const { h, setup, open, signal, posts } = await rankedFixture(t);
  const accept = await open();
  const long = signal("long", 1);
  h.controls.mutateMessage = true;
  assert.equal((await accept(long)).status, "review-required");
  const key = h.calls.find(call => call.path === "/v1/swap-intents")!.body.idempotencyKey;
  const journal = await FileJournal.create(setup.journalDirectory, setup.journalPolicy);
  await abandonOperation(journal, key);
  const closed = await accept(long);
  assert.ok(closed.status === "closed-unranked" && closed.reason === "abandoned" && closed.positionAfterRaw === "0");
  assert.deepEqual(await accept(long), closed);
  assert.deepEqual(posts(), postLifecycle.slice(0, 2));
});

test("a finalized failed flat leaves its position available for the reserved second exit", async (t) => {
  const { h, setup, open, signal, prepareSell, posts, holdings } = await rankedFixture(t);
  let retry = false;
  const rpc = setup.rpc;
  setup.rpc = { call: async (method, params) => retry && method === "getLatestBlockhash"
    ? { context: { slot: h.controls.rpcSlot }, value: { blockhash: asset(81), lastValidBlockHeight: 1000 } }
    : rpc.call(method, params) };
  const accept = await open();
  assert.ok((await accept(signal("long", 1))).ranked);
  prepareSell();
  h.controls.finalError = { InstructionError: [2, { Custom: 6001 }] };
  const flat = signal("flat", 2);
  const failed = await accept(flat);
  assert.ok(failed.status === "closed-unranked" && failed.reason === "failed" && failed.positionAfterRaw === "499000",
    JSON.stringify({ failed, posts: posts() }));
  assert.deepEqual(await accept(flat), failed);
  assert.deepEqual(holdings(), [4_000_000n, 499_000n]);
  h.controls.finalError = null;
  prepareSell(9);
  retry = true;
  const exit = await accept(signal("flat", 3));
  assert.ok(exit.ranked && exit.positionAfterRaw === "0", JSON.stringify({ exit, posts: posts() }));
  assert.notEqual(exit.txid, failed.txid);
  assert.deepEqual(posts(), [...postLifecycle, ...postLifecycle, ...postLifecycle]);
});

test("independent exit requires exact holdings and approval when ranking is pending", async (t) => {
  const { h, setup, controls, signal, prepareSell, posts, holdings } = await rankedFixture(t);
  const { accept, recoverExit } = await openRankedSignalOperator(setup, "validation");
  controls.proofPending = true;
  const long = signal("long", 1);
  assert.equal((await accept(long)).status, "ranking-pending");
  const flat = signal("flat", 2);
  await assert.rejects(accept(flat), /RANKED_SIGNAL_PENDING/);
  await assert.rejects(recoverExit(long), /RANKED_RECOVERY_FLAT_REQUIRED/);
  const closed = await openRankedSignalOperator({ ...setup, assertValidationTarget: async () => {
    throw new Error("SYNTHETIC_APPROVAL_CLOSED");
  } }, "validation");
  await assert.rejects(closed.recoverExit(flat), /SYNTHETIC_APPROVAL_CLOSED/);
  h.putToken(setup.playerPublicKey, asset(4), 499_001n);
  await assert.rejects(recoverExit(flat), /RANKED_POSITION_MISMATCH/);
  assert.deepEqual(posts(), postLifecycle);
  h.putToken(setup.playerPublicKey, asset(4), 499_000n);
  prepareSell();
  const exit = await recoverExit(flat);
  assert.ok(exit.status === "closed-unranked" && exit.reason === "independent-exit" && exit.positionAfterRaw === "0");
  assert.deepEqual(await accept(flat), exit);
  assert.deepEqual(holdings(), [4_996_004n, 0n]);
  assert.deepEqual(posts(), [...postLifecycle, ...postLifecycle]);
});

test("normal quote refusals leave a supervised recovery exit at the preapproved floor", async (t) => {
  const { h, setup, signal, prepareSell, posts, holdings } = await rankedFixture(t, { attempts: 1, minimumOutRaw: "990000" });
  setup.pair.minimumFlatOutRaw = "997000";
  const rpc = setup.rpc;
  let nextBlockhash: string | undefined;
  setup.rpc = { call: async (method, params) => nextBlockhash && method === "getLatestBlockhash"
    ? { context: { slot: h.controls.rpcSlot }, value: { blockhash: nextBlockhash, lastValidBlockHeight: 1000 } }
    : rpc.call(method, params) };
  const { accept, recoverExit } = await openRankedSignalOperator(setup, "validation");
  assert.ok((await accept(signal("long", 1))).ranked);
  const journal = await FileJournal.create(setup.journalDirectory, setup.journalPolicy);
  for (const sequence of [2, 3]) {
    nextBlockhash = asset(80 + sequence);
    prepareSell(sequence * 3 + 1);
    const flat = signal("flat", sequence);
    const refused = await accept(flat);
    if (refused.status === "review-required") {
      const key = h.calls.filter(call => call.path === "/v1/swap-intents").at(-1)!.body.idempotencyKey;
      await abandonOperation(journal, key);
      assert.equal((await accept(flat)).status, "closed-unranked");
    } else {
      assert.equal(refused.status, "closed-unranked");
    }
  }
  assert.equal((await journal.capacity()).remainingOperations, 1);
  const flat = signal("flat", 4);
  await assert.rejects(accept(flat), /SIGNAL_EXIT_SLOT_MISSING/);
  assert.deepEqual(holdings(), [4_000_000n, 499_000n]);
  prepareSell(13);
  nextBlockhash = asset(84);
  const exit = await recoverExit(flat);
  assert.ok(exit.status === "closed-unranked" && exit.reason === "independent-exit" && exit.positionAfterRaw === "0", JSON.stringify({ exit, posts: posts() }));
  assert.deepEqual(holdings(), [4_996_004n, 0n]);
  assert.equal(posts().filter(path => path === "submit-durable").length, 2);
  assert.deepEqual(await recoverExit(flat), exit);
  assert.equal(posts().filter(path => path === "submit-durable").length, 2);
});

test("repeated flat blockhashes never consume the supervised recovery reservation", async (t) => {
  const { h, setup, signal, prepareSell, posts, holdings } = await rankedFixture(t, { attempts: 1, minimumOutRaw: "990000" });
  const rpc = setup.rpc;
  let blockhash: string | undefined;
  setup.rpc = { call: async (method, params) => blockhash && method === "getLatestBlockhash"
    ? { context: { slot: h.controls.rpcSlot }, value: { blockhash, lastValidBlockHeight: 1000 } }
    : rpc.call(method, params) };
  let { accept, recoverExit } = await openRankedSignalOperator(setup, "validation");
  assert.ok((await accept(signal("long", 1))).ranked);
  h.controls.finalError = { InstructionError: [2, { Custom: 6001 }] };
  prepareSell(7);
  const first = await accept(signal("flat", 2));
  assert.ok(first.status === "closed-unranked" && first.reason === "failed");
  prepareSell(9);
  const next = signal("flat", 3);
  await assert.rejects(accept(next), /RANKED_EXIT_WAIT_FOR_FRESH_BLOCKHASH/);
  assert.equal(posts().filter(path => path === "submit-durable").length, 2);
  blockhash = asset(81);
  const second = await accept(next);
  assert.ok(second.status === "closed-unranked" && second.reason === "failed");
  ({ accept, recoverExit } = await openRankedSignalOperator(setup, "validation"));
  const finalFlat = signal("flat", 4);
  prepareSell(11);
  h.controls.finalError = null;
  await assert.rejects(accept(finalFlat), /SIGNAL_EXIT_SLOT_MISSING/);
  await assert.rejects(recoverExit(finalFlat), /RANKED_EXIT_WAIT_FOR_FRESH_BLOCKHASH/);
  assert.equal(posts().filter(path => path === "submit-durable").length, 3);
  blockhash = asset(82);
  const exit = await recoverExit(finalFlat);
  assert.ok(exit.status === "closed-unranked" && exit.reason === "independent-exit" && exit.positionAfterRaw === "0");
  assert.deepEqual(holdings(), [4_996_004n, 0n]);
  assert.equal(posts().filter(path => path === "submit-durable").length, 4);
});

test("official proxy binds the current release and resumes the same signed flat across a service redeploy", async (t) => {
  const recoveryExit = { attempts: 1, minimumOutRaw: "985000" };
  const { h, setup, controls, signal, prepareSell, posts, holdings, transport, writes } = await rankedFixture(t, recoveryExit);
  const origin = "https://audacefi-official-synthetic.invalid";
  const traces: { path: string; bearer: string }[] = [];
  const intentOperations = new Map<string, string>();
  let credentialSequence = 0, blocked = true, credentialScopes = ["read", "execute"];
  const proxyTransport: FetchPort = async (url, init) => {
    const target = new URL(url), bearer = new Headers(init.headers).get("authorization")!;
    assert.equal(target.origin, origin);
    assert.ok(target.pathname.startsWith("/api/v1/"));
    const path = target.pathname.slice(4);
    if (path === "/v1/me") {
      traces.push({ path, bearer });
      return Response.json({ account: {
        id: setup.accountId, status: "active", participantType: setup.actor,
        participantTypeDeclaredAt: new Date().toISOString(),
      }, onboardingComplete: true, credentialScopes });
    }
    assert.ok(traces.some(entry => entry.path === "/v1/me" && entry.bearer === bearer));
    traces.push({ path, bearer });
    if (path === "/v1/swap-intents") {
      intentOperations.set(h.quoteWire.intentId, JSON.parse(String(init.body)).idempotencyKey);
    }
    if (path.endsWith("/ranked-evidence")) {
      const intentId = path.split("/").at(-2)!;
      const txid = h.calls.find(call => call.path === `/v1/swap-intents/${intentId}/signature`)!.body.signature;
      const operationKey = intentOperations.get(intentId)!;
      const evidence = (await setup.readEvidence({
        operationKey, origin, genesisHash: SOLANA_DEVNET_GENESIS, accountId: setup.accountId,
        seasonId: setup.seasonId, actor: setup.actor, category: "crypto-bro", playerPublicKey: setup.playerPublicKey,
        intentId, txid,
      }))!;
      const { origin: _origin, genesisHash: _genesis, ...trade } = evidence.trade;
      return Response.json({ protocol: "audacefi.bench.ranked-evidence.v1", evidence: { trade, leaderboard: evidence.leaderboard } });
    }
    return transport(setup.client.origin + path + target.search, init);
  };
  const { client: _validationClient, assertValidationTarget: _validationApproval, readEvidence: _validationEvidence, ...shared } = setup;
  const issuer = generateKeyPairSync("ed25519");
  const issuerPublicKey = encode58(issuer.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const evidence = {
    proxyReleaseDigest: "2".repeat(64), apiReleaseDigest: "3".repeat(64), indexerReleaseDigest: "4".repeat(64),
    workerReleaseDigest: "5".repeat(64), frozenAllowlistDigest: "6".repeat(64), openingSnapshotDigest: "7".repeat(64),
    independentExitDigest: "8".repeat(64),
  };
  let hasApproval = false, approvalReads = 0;
  let liveDeployment = officialApprovalDeploymentDigest(evidence);
  function signApproval(target: OfficialRankedSignalSetup) {
    approvalReads++;
    if (!hasApproval) return null;
    const now = Date.now();
    const payload: OfficialApprovalPayload = {
      version: 1, ...officialRankedApprovalBindings(target),
      issuedAtMs: now - 1000, validFromMs: now - 1000, expiresAtMs: now + 600_000,
      evidence: target.officialApproval.expectedEvidence,
    };
    return { payload, signature: encode58(sign(null, officialApprovalSigningBytes(payload), issuer.privateKey)) };
  }
  const official: OfficialRankedSignalSetup = {
    ...shared, profile: { ...setup.profile, apiOrigin: origin, apiBasePath: "/api" },
    pair: { ...setup.pair, recoveryExit },
    api: { origin, transport: proxyTransport, credential: () => ["afk", "synthetic", String(++credentialSequence)].join("_") },
    officialApproval: { issuerPublicKey, deploymentDigest: liveDeployment, expectedEvidence: evidence,
      isCurrent: payload => payload.deploymentDigest === liveDeployment, read: () => signApproval(official) },
    assertOfficialTarget: () => { if (blocked) throw new Error("SYNTHETIC_GATE_CLOSED"); },
  };
  await assert.rejects(openRankedSignalOperator(official, "validation"), /RANKED_OPERATOR_TARGET_MISMATCH/);
  await assert.rejects(openRankedSignalOperator(setup, "official"), /RANKED_OPERATOR_TARGET_MISMATCH/);
  await assert.rejects(openRankedSignalOperator({ ...setup, ...official }, "official"), /RANKED_OPERATOR_TARGET_MISMATCH/);
  const { recoveryExit: _missing, ...noRecoveryExit } = official.pair;
  await assert.rejects(openRankedSignalOperator({ ...official, pair: noRecoveryExit } as OfficialRankedSignalSetup, "official"),
    /OFFICIAL_RECOVERY_EXIT_REQUIRED/);
  assert.equal(approvalReads, 0);
  assert.equal(h.counts().walletCalls, 0);
  const { accept, runScope } = await openRankedSignalOperator(official, "official");
  assert.notEqual(runScope, (await openRankedSignalOperator(setup, "validation")).runScope);
  assert.deepEqual(traces, []);
  await assert.rejects(accept(signal("long", 1)), /INVALID_OFFICIAL_APPROVAL/);
  hasApproval = true;
  await assert.rejects(accept(signal("long", 1)), /SYNTHETIC_GATE_CLOSED/);
  assert.deepEqual(traces, []);

  blocked = false;
  const long = signal("long", 1);
  credentialScopes = ["read"];
  await assert.rejects(accept(long), /EXECUTE_SCOPE_REQUIRED/);
  const journal = await FileJournal.create(setup.journalDirectory, setup.journalPolicy);
  assert.equal((await journal.capacity()).reservedOperations, 0);
  assert.deepEqual(posts(), []);
  credentialScopes = ["read", "execute"];
  const readsBefore = approvalReads;
  const entered = await accept(long);
  assert.equal(approvalReads - readsBefore, 1);
  assert.ok(entered.ranked, JSON.stringify({ entered, posts: posts() }));
  assert.deepEqual([entered.feeRaw, entered.positionAfterRaw], [buy.feeRaw, buy.amountOutRaw]);
  const { reservation } = await journal.read(entered.operationKey);
  assert.equal(reservation.version, 2);
  assert.equal(reservation.apiBasePath, "/api");
  assert.equal(reservation.origin, origin);
  if (reservation.version !== 2) assert.fail();
  assert.equal(reservation.accountId, setup.accountId);
  assert.equal(reservation.actor, setup.actor);

  const noCalls = async (): Promise<Response> => { assert.fail("wrong recovery target was contacted"); };
  const root = new AudaceFiClient({ ...official.api, transport: noCalls, writes: "explicitly-authorized" });
  const readOnlyProxy = new AudaceFiClient({ ...official.api, transport: noCalls, apiBasePath: "/api" });
  const wrongAccount = AudaceFiClient.forOfficialRankedProxy({
    ...official.api, transport: noCalls, accountId: syntheticId(41), actor: setup.actor, authorizeWrite: () => {},
  });
  const wrongOrigin = AudaceFiClient.forOfficialRankedProxy({
    ...official.api, origin: "https://other-synthetic.invalid", transport: noCalls,
    accountId: setup.accountId, actor: setup.actor, authorizeWrite: () => {},
  });
  await assert.rejects(reconcileOperation(root, journal, entered.operationKey), /RECONCILIATION_API_BASE_PATH_MISMATCH/);
  await assert.rejects(reconcileOperation(readOnlyProxy, journal, entered.operationKey), /RECONCILIATION_PROXY_IDENTITY_MISMATCH/);
  await assert.rejects(reconcileOperation(wrongAccount, journal, entered.operationKey), /RECONCILIATION_PROXY_IDENTITY_MISMATCH/);
  await assert.rejects(reconcileOperation(wrongOrigin, journal, entered.operationKey), /RECONCILIATION_ORIGIN_MISMATCH/);
  await assert.rejects(finalizeOperation(root, journal, entered.operationKey, async () => assert.fail()),
    /RECONCILIATION_API_BASE_PATH_MISMATCH/);

  const redeployedEvidence = { ...evidence, workerReleaseDigest: "9".repeat(64), independentExitDigest: "b".repeat(64) };
  let renewed = false;
  const redeployed: OfficialRankedSignalSetup = {
    ...official, profile: {
      ...official.profile, apiApproval: { ...official.profile.apiApproval, expiresAtMs: official.profile.apiApproval.expiresAtMs + 60_000 },
    },
    officialApproval: {
      ...official.officialApproval, deploymentDigest: officialApprovalDeploymentDigest(redeployedEvidence),
      expectedEvidence: redeployedEvidence, read: () => signApproval(renewed ? redeployed : official),
    },
  };
  assert.notEqual(redeployed.officialApproval.deploymentDigest, official.officialApproval.deploymentDigest);
  const restarted = await openRankedSignalOperator(redeployed, "official");
  assert.equal(restarted.runScope, runScope);
  const flat = signal("flat", 2);
  await assert.rejects(restarted.accept(flat), /OFFICIAL_APPROVAL_BINDING_MISMATCH/);
  const readsAtWrongScope = traces.length;
  const changedSeason = [
    { ...redeployedEvidence, openingSnapshotDigest: "a".repeat(64) },
    { ...redeployedEvidence, frozenAllowlistDigest: "a".repeat(64) },
  ];
  for (const changes of [
    { profile: { ...redeployed.profile, programDataSha256: "a".repeat(64) } },
    { accountId: syntheticId(41) },
    ...changedSeason.map(expectedEvidence => ({ officialApproval: { ...redeployed.officialApproval,
      deploymentDigest: officialApprovalDeploymentDigest(expectedEvidence), expectedEvidence } })),
  ]) {
    const wrong = await openRankedSignalOperator({ ...redeployed, ...changes }, "official");
    assert.notEqual(wrong.runScope, runScope);
    await assert.rejects(wrong.accept(flat), /RANKED_INBOX_SCOPE_CHANGED/);
  }
  assert.equal(traces.length, readsAtWrongScope);
  assert.deepEqual(posts(), postLifecycle);
  assert.equal(h.counts().walletCalls, 1);

  prepareSell();
  controls.loseSignature = "before";
  assert.equal((await accept(flat)).status, "review-required");
  controls.loseSignature = undefined;
  const signatureCount = h.counts().walletCalls;
  assert.equal(signatureCount, 2);
  assert.equal(posts().filter(path => path === "submit-durable").length, 1);

  liveDeployment = redeployed.officialApproval.deploymentDigest;
  renewed = true;
  const writesBefore = writes.length;
  assert.deepEqual(await restarted.accept(long), entered);
  assert.equal(writes.length, writesBefore);
  const exited = await restarted.accept(flat);
  assert.ok(exited.ranked);
  assert.deepEqual([exited.feeRaw, exited.positionAfterRaw], [sell.feeRaw, "0"]);
  assert.notEqual(exited.txid, entered.txid);
  assert.deepEqual(holdings(), [4_996_004n, 0n]);
  assert.equal(h.counts().walletCalls, signatureCount);
  assert.deepEqual(posts(), [...postLifecycle, ...postLifecycle]);
  const exitSignatures = writes.filter(call => call.path === `/v1/swap-intents/${exited.intentId}/signature`);
  assert.equal(exitSignatures.length, 2);
  assert.deepEqual(exitSignatures[0]!.body, exitSignatures[1]!.body);
  const settledWrites = writes.length;
  assert.deepEqual(await (await createOfficialRankedSignalGateway(redeployed))(flat), exited);
  assert.equal(writes.length, settledWrites);
});

test("official proxy refuses an incorrect account before reads and writes with that bearer", async () => {
  const calls: string[] = [];
  const client = AudaceFiClient.forOfficialRankedProxy({
    origin: "https://audacefi-official-synthetic.invalid",
    accountId: syntheticId(11), actor: "trading_bot", authorizeWrite: () => {},
    credential: () => ["afk", "synthetic", "other"].join("_"),
    transport: async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ account: {
        id: syntheticId(12), participantType: "trading_bot", status: "active",
        participantTypeDeclaredAt: new Date().toISOString(),
      }, onboardingComplete: true });
    },
  });
  await assert.rejects(client.readSubmission(syntheticId(13)), /GUARD_REFUSED_BEFORE_SEND/);
  await assert.rejects(client.recordConfirmedResult(syntheticId(13), "confirmed"), /GUARD_REFUSED_BEFORE_SEND/);
  assert.deepEqual(calls, ["/api/v1/me", "/api/v1/me"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceAdapters } from "../src/reference.ts";
import { RpcError, SolanaRpcReader, type ReadMethod } from "../src/rpc.ts";
import { benchAmounts, benchPlan, verifyBenchMessage } from "../src/bench.ts";
import { ASSOCIATED_TOKEN_PROGRAM, associatedAddress, compileLegacy, decode58, decodeLegacy, derivePda, encode58, SYSTEM_PROGRAM } from "../src/solana.ts";
import { parseQuote } from "../src/client.ts";
import { finalizeOperation, runOperation } from "../src/operation.ts";
import { runAiAgent, runTradingBot } from "../src/operators.ts";
import { asset, clock, journalFor } from "./connected-harness.ts";
import { referenceHarness, type ReferenceKind } from "./reference-harness.ts";

for (const actor of ["ai_agent", "trading_bot"] as const) for (const kind of ["buy", "sell", "route"] as const) {
  test(`reference ${actor} ${kind}: concrete plan, guarded submission, exact finalized proof`, async t => {
    const h = referenceHarness(kind, actor), { journal } = await journalFor(t, { maxOperations: 2, inputBudgets: { [h.operation.tokenInMint]: "2000000" } });
    const { actor: _, ...operation } = h.operation;
    const result = await (actor === "ai_agent" ? runAiAgent : runTradingBot)({ client: h.client, journal, operation, ports: h.suite.ports, clock: h.getNow });
    assert.equal(result.state, "SUBMITTED"); assert.equal(h.counts().walletCalls, 1);
    assert.equal(h.calls.filter(c => c.path.endsWith("/submit-durable")).length, 1);
    assert.equal(await finalizeOperation(h.client, journal, h.operation.operationKey, h.suite.verifyFinal), "confirmed");
    assert.equal((await journal.read(h.operation.operationKey)).events.at(-1)?.stage, "FINAL_CONFIRMED");
    const submitted = h.calls.find(c => c.path.endsWith("/submit-durable"))!.body;
    const decoded = decodeLegacy(submitted.transaction);
    assert.equal(decoded.instructions[0]!.program, ASSOCIATED_TOKEN_PROGRAM);
    assert.equal(decoded.instructions.length, kind === "route" ? 4 : 3);
    assert.equal(h.rpcCalls.filter(c => c.method === "getMultipleAccounts").length, 6);
    assert.ok(h.counts().rpc <= 53); assert.ok(h.counts().api <= 17);
    assert.ok(h.rpcCalls.every(c => !/send|airdrop|simulate/i.test(c.method)));
  });
}

test("reference creation is inert and freezes caller-owned deployment configuration", async t => {
  const h = referenceHarness(); assert.equal(h.counts().rpc, 0); assert.equal(h.counts().api, 0); assert.equal(h.counts().keyCalls, 0);
  h.profile.mappings[0]!.decimals = 3;
  assert.equal(h.counts().walletCalls, 0);
  // A later caller edit must not reach the suite: its frozen clone still matches the chain mints.
  const { journal } = await journalFor(t);
  assert.equal((await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow)).state, "SUBMITTED");
});
test("RPC reader keeps a provider path token out of its public surface", () => {
  const rpc = new SolanaRpcReader({ endpoint: "https://rpc.synthetic.invalid/synthetic-path-token/" });
  assert.equal(JSON.stringify(rpc).includes("synthetic-path-token"), false); assert.equal(rpc.origin, "https://rpc.synthetic.invalid");
});
test("target approval is checked after the asynchronous account snapshot", async () => {
  const h = referenceHarness();
  const profile = { ...h.profile, apiApproval: { ...h.profile.apiApproval, expiresAtMs: clock + 100 } };
  const rpc = { call: async (method: ReadMethod, params: unknown[]) => {
    if (method === "getMultipleAccounts") h.setNow(clock + 101);
    return h.rawRpc(method, params);
  } };
  const suite = createReferenceAdapters({ profile, client: h.client, rpc, wallet: h.wallet, clock: h.getNow });
  await assert.rejects(suite.ports.verifyTarget(), /APPROVAL_EXPIRED/);
  assert.equal(h.calls.length, 0); assert.equal(h.counts().walletCalls, 0);
});
for (const at of [2, 3]) test(`approval expiring during credential resolution blocks early API write ${at}`, async t => {
  const h = referenceHarness(); h.controls.expireApprovalAtCredential = at;
  const { journal } = await journalFor(t);
  const result = await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow);
  // Refused before the first write is transmitted: UNSENT. After an intention exists: AMBIGUOUS.
  assert.deepEqual([result.state, result.reason], [at === 2 ? "UNSENT" : "AMBIGUOUS", "GUARD_REFUSED_BEFORE_SEND"]);
  assert.equal(h.calls.filter(c => c.method === "POST").length, at === 2 ? 0 : 1);
  assert.equal(h.calls.some(c => c.path.endsWith("/quote")), false);
  assert.equal(h.counts().walletCalls, 0);
});
test("PDA and legacy codec match published protocol vectors", () => {
  assert.deepEqual(derivePda(SYSTEM_PROGRAM, [Buffer.from("helloWorld")]), { address: "46GZzzetjCURsdFPb7rcnspbEMnCBXe9kpjrsZAkKb6X", bump: 254 });
  for (let n = 0; n < 32; n++) { const bytes = Buffer.alloc(32, n); assert.deepEqual(decode58(encode58(bytes), 32), bytes); }
  assert.throws(() => decode58("1".repeat(33), 32)); assert.throws(() => derivePda(SYSTEM_PROGRAM, [Buffer.alloc(33)]));
});
test("bench arithmetic covers independent BUY SELL route and u128 overflow", () => {
  assert.equal(benchAmounts("1000000", 6, 6, "2", 0, "buy").output, 499500n);
  assert.equal(benchAmounts("1000000", 6, 6, "2", 0, "sell").output, 1998000n);
  assert.equal(benchAmounts("1000000", 6, 9, "3", 0, "route", "2", 0).output, 1497000000n);
  assert.throws(() => benchAmounts("18446744073709551615", 9, 0, "18446744073709551615", 18, "sell"));
  assert.throws(() => benchAmounts("1", 9, 0, "18446744073709551615", 0, "buy"));
});
test("semantic decoder rejects added instructions, writable promotion, altered prices and payer", async () => {
  const h = referenceHarness(), target = await h.suite.ports.verifyTarget(), q = parseQuote(h.quoteWire);
  const encoded = await h.suite.ports.build(h.operation, q, target);
  const original = benchPlan(h.profile, h.operation, q);
  for (const mutate of [
    (x: typeof original.instructions) => x.push({ program: SYSTEM_PROGRAM, accounts: [], data: Buffer.alloc(0) }),
    (x: typeof original.instructions) => { x[1]!.accounts[0]!.writable = true; },
    (x: typeof original.instructions) => { x[1]!.data[8] = x[1]!.data[8]! ^ 1; },
  ]) {
    const ix = structuredClone(original.instructions); mutate(ix);
    const bad = compileLegacy(h.operation.playerPublicKey, h.profile.poster, asset(80), ix);
    assert.throws(() => verifyBenchMessage(bad, h.profile, h.operation, q));
  }
  assert.throws(() => verifyBenchMessage(encoded, h.profile, { ...h.operation, playerPublicKey: asset(9) }, q));
});

for (const fault of ["expireAfterKey", "expireCredentialAfterSign", "revokeAfterSign", "expireBlockhashAfterSign", "loseFundsAfterSign", "mutateMessage"] as const) {
  test(`reference stops ${fault} without durable submission or replacement permission`, async t => {
    const h = referenceHarness(); h.controls[fault] = true;
    const { journal } = await journalFor(t);
    const result = await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow);
    assert.equal(result.state, "AMBIGUOUS"); assert.equal(h.calls.some(c => c.path.endsWith("/submit-durable")), false);
    assert.equal(h.calls.some(c => c.path.endsWith("/signature")), false);
    if (fault === "expireAfterKey") assert.equal(h.counts().walletCalls, 0);
    await assert.rejects(journal.reserve("synthetic-replacement", "f".repeat(64), h.operation.tokenInMint, h.operation.amountInRaw, h.client.origin), /UNRESOLVED/);
  });
}
test("unverified target genesis and deployment hash block before intentions", async t => {
  const h = referenceHarness(), { journal } = await journalFor(t); h.controls.rpcGenesis = asset(42);
  await assert.rejects(runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow), /GENESIS/);
  assert.equal(h.calls.some(c => c.method === "POST"), false);
  const bad = { ...h.profile, programDataSha256: "0".repeat(64) };
  const suite = createReferenceAdapters({ profile: bad, client: h.client, rpc: h.rpc, wallet: h.wallet, clock: h.getNow }); h.controls.rpcGenesis = h.profile.expectedGenesis;
  await assert.rejects(suite.ports.verifyTarget(), /DEPLOYMENT/);
});
test("missing output ATA and price accounts reserve rent from separate payers", async t => {
  const h = referenceHarness(), a = benchPlan(h.profile, h.operation, parseQuote(h.quoteWire));
  h.accounts.delete(a.playerOut); h.accounts.delete(a.addresses.price(a.output.devnet).address);
  const { journal } = await journalFor(t);
  assert.equal((await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow)).state, "SUBMITTED");
  assert.ok(h.rpcCalls.some(c => c.method === "getMinimumBalanceForRentExemption" && c.params[0] === 165));
  assert.ok(h.rpcCalls.some(c => c.method === "getMinimumBalanceForRentExemption" && c.params[0] === 69));
  assert.ok(h.counts().rpc <= 49);
});
for (const [label, outputExists, extra, expected] of [["absent output ATA, one lamport over fee and rent", false, 1, "AMBIGUOUS"], ["present output ATA, one lamport over the fee", true, 1, "AMBIGUOUS"], ["absent output ATA, payer stays rent-exempt", false, 1000000, "SUBMITTED"]] as const) {
  test(`fee payer must remain rent-exempt: ${label}`, async t => {
    const h = referenceHarness(), a = benchPlan(h.profile, h.operation, parseQuote(h.quoteWire));
    if (!outputExists) h.accounts.delete(a.playerOut);
    h.accounts.get(h.operation.playerPublicKey).lamports = 10000 + (outputExists ? 0 : 2000000) + extra;
    const { journal } = await journalFor(t);
    const result = await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow);
    assert.equal(result.state, expected);
    if (expected === "AMBIGUOUS") { assert.equal(result.reason, "REFERENCE_INSUFFICIENT_FUNDS"); assert.equal(h.counts().walletCalls, 0); assert.equal(h.calls.some(c => c.path.endsWith("/submit-durable")), false); }
  });
}
test("price-account poster must remain rent-exempt", async t => {
  const h = referenceHarness(), a = benchPlan(h.profile, h.operation, parseQuote(h.quoteWire));
  h.accounts.delete(a.addresses.price(a.output.devnet).address); h.accounts.get(h.profile.poster).lamports = 1000000;
  const { journal } = await journalFor(t);
  const result = await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow);
  assert.deepEqual([result.state, result.reason], ["AMBIGUOUS", "REFERENCE_INSUFFICIENT_FUNDS"]);
  assert.equal(h.counts().walletCalls, 0);
});
test("route fee vault must exist at the output mint", async t => {
  const h = referenceHarness("route"), p = benchPlan(h.profile, h.operation, parseQuote(h.quoteWire)); h.accounts.delete(p.feeVault);
  const { journal } = await journalFor(t, { maxOperations: 2, inputBudgets: { [h.operation.tokenInMint]: "2000000" } });
  assert.equal((await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow)).state, "AMBIGUOUS");
  assert.equal(h.counts().walletCalls, 0);
});
test("unknown mint decimals and unfrozen allowlist never reach a wallet", async t => {
  const h = referenceHarness(), { journal } = await journalFor(t); h.allowlist.tokens[1].decimals = null;
  assert.equal((await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow)).state, "AMBIGUOUS"); assert.equal(h.counts().walletCalls, 0);
});
test("a stale or regressing RPC slot is refused", async () => {
  const h = referenceHarness(); await h.suite.ports.verifyTarget(); h.controls.rpcSlot--;
  await assert.rejects(h.suite.ports.verifyTarget());
});
for (const error of [false, 0, {}, [], "InventedReviewError", { InstructionError: [0, "InventedInstructionError"] }, { InstructionError: [900, { Custom: 6000 }] }]) {
  test(`malformed final error stays unknown: ${JSON.stringify(error)}`, async t => {
    const h = referenceHarness(), { journal } = await journalFor(t);
    assert.equal((await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow)).state, "SUBMITTED");
    h.controls.finalError = error;
    assert.equal(await finalizeOperation(h.client, journal, h.operation.operationKey, h.suite.verifyFinal), "unknown");
    assert.equal(h.calls.some(c => c.path.endsWith("/result")), false);
  });
}
for (const error of ["AccountNotFound", { InstructionError: [2, { Custom: 6000 }] }]) {
  test(`supported finalized error is recorded only after exact evidence: ${JSON.stringify(error)}`, async t => {
    const h = referenceHarness(), { journal } = await journalFor(t);
    await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow); h.controls.finalError = error;
    assert.equal(await finalizeOperation(h.client, journal, h.operation.operationKey, h.suite.verifyFinal), "failed");
  });
}
test("unfinalized or absent transactions stay unknown", async t => {
  const h = referenceHarness(), { journal } = await journalFor(t);
  await runOperation(h.client, journal, h.operation, h.suite.ports, h.getNow); h.controls.finalStatus = "confirmed";
  assert.equal(await finalizeOperation(h.client, journal, h.operation.operationKey, h.suite.verifyFinal), "unknown");
  h.controls.finalStatus = "finalized"; h.controls.finalMissing = true;
  assert.equal(await finalizeOperation(h.client, journal, h.operation.operationKey, h.suite.verifyFinal), "unknown");
});
test("RPC transport allows only read methods and sanitized bounded responses", async () => {
  let calls = 0;
  const rpc = new SolanaRpcReader({ endpoint: "https://rpc.synthetic.invalid", transport: async (_, init) => { calls++; const body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id + 1, result: "bad-id" }), { headers: { "content-type": "application/json" } }); } });
  await assert.rejects(rpc.call("sendTransaction" as ReadMethod, []), /RPC_METHOD_REFUSED/); assert.equal(calls, 0);
  await assert.rejects(rpc.call("getGenesisHash", []), /RPC_INVALID_ENVELOPE/);
  const failed = new SolanaRpcReader({ endpoint: "https://rpc.synthetic.invalid/", transport: async () => { throw new Error("synthetic-private-provider-detail"); } });
  await assert.rejects(failed.call("getGenesisHash", []), e => e instanceof RpcError && !e.message.includes("private-provider") && e.cause === undefined);
  assert.throws(() => new SolanaRpcReader({ endpoint: "https://user:synthetic-secret@rpc.synthetic.invalid/" }), /INVALID_RPC_ENDPOINT/);
});

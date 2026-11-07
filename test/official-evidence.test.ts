import assert from "node:assert/strict";
import { test } from "node:test";
import { AudaceFiClient, ClientError, type ClientOptions } from "../src/client.ts";
import { SOLANA_DEVNET_GENESIS } from "../src/contract.ts";
import type { RankedEvidenceRequest } from "../src/ranked-proof.ts";
import { encode58 } from "../src/solana.ts";
import { asset, clock, syntheticId } from "./connected-harness.ts";

const origin = "https://official-fixture.invalid";
const request: RankedEvidenceRequest = {
  operationKey: "official-evidence-fixture",
  origin,
  genesisHash: SOLANA_DEVNET_GENESIS,
  seasonId: syntheticId(1),
  accountId: syntheticId(2),
  actor: "trading_bot",
  category: "crypto-bro",
  playerPublicKey: asset(7),
  intentId: syntheticId(3),
  txid: encode58(Buffer.alloc(64, 1)),
};

function evidence() {
  const { origin: ignoredOrigin, genesisHash: ignoredGenesis, ...context } = request;
  return {
    trade: { ...context, amountInRaw: "1000000", amountOutRaw: "998000", feeRaw: "2000" },
    leaderboard: {
      seasonId: request.seasonId, accountId: request.accountId, category: request.category,
      division: "C", rank: 1, asOf: new Date(clock).toISOString(),
      includedIntentId: request.intentId, includedTxid: request.txid,
    },
  };
}

function fixture() {
  let calls = 0;
  const response: { protocol: string; evidence: ReturnType<typeof evidence> | null } = {
    protocol: "audacefi.bench.ranked-evidence.v1",
    evidence: evidence(),
  };
  const options: ClientOptions = {
    origin, apiBasePath: "/api", credential: () => "synthetic-fixture-credential",
    async transport(url, init) {
      calls++;
      assert.equal(url, `${origin}/api/v1/swap-intents/${request.intentId}/ranked-evidence`);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-fixture-credential");
      assert.equal(init.body, undefined);
      return Response.json(response);
    },
  };
  return { client: new AudaceFiClient(options), response, calls: () => calls };
}

test("official evidence reader binds an authenticated same-origin GET to the exact ranked fill", async () => {
  const { client, calls } = fixture();
  assert.equal(client.writesAuthorized, false);
  assert.equal(calls(), 0);
  const result = await client.readRankedEvidence(request);
  const expected = evidence();
  assert.deepEqual(result, {
    trade: { ...expected.trade, origin, genesisHash: SOLANA_DEVNET_GENESIS },
    leaderboard: expected.leaderboard,
  });
  assert.equal(calls(), 1);
});

test("only an explicit pending envelope means evidence is pending", async () => {
  const { client, response } = fixture();
  response.evidence = null;
  assert.equal(await client.readRankedEvidence(request), null);
  response.protocol = "unknown";
  await assert.rejects(client.readRankedEvidence(request), /INVALID_RANKED_EVIDENCE_RESPONSE/);
});

test("API origin and prefix stay pinned while awaiting credentials", async () => {
  let client: AudaceFiClient;
  let seen: string | undefined;
  client = new AudaceFiClient({
    origin, apiBasePath: "/api",
    async credential() {
      assert.equal(Reflect.set(client, "origin", "https://elsewhere.invalid"), false);
      assert.equal(Reflect.set(client, "apiBasePath", ".elsewhere.invalid"), false);
      assert.equal(Reflect.defineProperty(client, "apiBasePath", { value: "" }), false);
      return "synthetic-fixture-credential";
    },
    async transport(url) {
      seen = url;
      return Response.json({ protocol: "audacefi.bench.ranked-evidence.v1", evidence: null });
    },
  });
  assert.equal(await client.readRankedEvidence(request), null);
  assert.equal(seen, `${origin}/api/v1/swap-intents/${request.intentId}/ranked-evidence`);
  assert.throws(() => new AudaceFiClient({
    origin, apiBasePath: "/api", writes: "explicitly-authorized", credential: () => "unused-fixture",
  }), /API_BASE_PATH_READ_ONLY/);
});

test("official evidence refuses a mismatched account, signature, rank or raw fee", async () => {
  const { client, response } = fixture();
  for (const mutate of [
    (proof: ReturnType<typeof evidence>) => { proof.trade.accountId = syntheticId(8); },
    (proof: ReturnType<typeof evidence>) => { proof.leaderboard.includedTxid = encode58(Buffer.alloc(64, 2)); },
    (proof: ReturnType<typeof evidence>) => { proof.leaderboard.rank = 0; },
    (proof: ReturnType<typeof evidence>) => { proof.trade.feeRaw = "-2000"; },
    (proof: ReturnType<typeof evidence>) => { proof.leaderboard.asOf = new Date(clock).toISOString().replace(".000Z", "Z"); },
  ]) {
    const proof = evidence();
    mutate(proof);
    response.evidence = proof;
    await assert.rejects(client.readRankedEvidence(request), error =>
      error instanceof ClientError && !error.ambiguous && error.code === "INVALID_RANKED_EVIDENCE_RESPONSE");
  }
});

test("cross-origin and non-devnet evidence requests fail before reaching the transport", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.readRankedEvidence({ ...request, origin: "https://elsewhere.invalid" }), /RANKED_EVIDENCE_CONTEXT_MISMATCH/);
  await assert.rejects(client.readRankedEvidence({ ...request, genesisHash: asset(8) }), /RANKED_EVIDENCE_CONTEXT_MISMATCH/);
  await assert.rejects(client.readRankedEvidence({ ...request, operationKey: 12345678 as unknown as string }), /RANKED_EVIDENCE_CONTEXT_MISMATCH/);
  assert.equal(calls(), 0);
  assert.throws(() => new AudaceFiClient({
    origin, credential: () => "unused-fixture", apiBasePath: "/api/.." as "/api",
  }), /UNSUPPORTED_API_BASE_PATH/);
});

test("a short Retry-After retries only the read, with a delay and a one-attempt limit", async () => {
  let calls = 0;
  const sentAt: number[] = [];
  const client = new AudaceFiClient({
    origin, credential: () => "synthetic-fixture-credential",
    async transport(_url, init) {
      assert.equal(init.method, "GET");
      calls++;
      sentAt.push(performance.now());
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(client.readRankedEvidence(request), error =>
    error instanceof ClientError && !error.ambiguous && error.status === 429 && error.retryAfterMs === 0);
  assert.equal(calls, 2);
  assert.ok(sentAt[1]! - sentAt[0]! >= 900);
});

test("a longer Retry-After and a rate-limited write stay with the caller", async () => {
  const methods: (string | undefined)[] = [];
  const client = new AudaceFiClient({
    origin, credential: () => "synthetic-fixture-credential", writes: "explicitly-authorized",
    async transport(_url, init) {
      methods.push(init.method);
      return new Response(null, { status: 429, headers: { "retry-after": init.method === "GET" ? "60" : "0" } });
    },
  });
  await assert.rejects(client.readRankedEvidence(request), error =>
    error instanceof ClientError && !error.ambiguous && error.retryAfterMs === 60_000);
  await assert.rejects(client.recordConfirmedResult(request.intentId, "confirmed"), error =>
    error instanceof ClientError && error.ambiguous && error.status === 429);
  assert.deepEqual(methods, ["GET", "POST"]);
});

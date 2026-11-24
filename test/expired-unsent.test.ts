import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { digest } from "../src/canonical.ts";
import { AudaceFiClient } from "../src/client.ts";
import { FileJournal } from "../src/journal.ts";
import { reconcileExpiredUnsentOperation, runOperation } from "../src/index.ts";
import { asset, clock, encode58, harness, journalFor, syntheticId } from "./connected-harness.ts";

const submissionProtocol = "audacefi.bench.submission.v1";
const terminalProtocol = "audacefi.bench.terminal-unsent.v1";
const policy = { maxOperations: 2, inputBudgets: { [asset(1)]: "2000000" } };
const nextKey = "synthetic-next-operation";
type VerifyExpiry = Parameters<typeof reconcileExpiredUnsentOperation>[3];

const expired: VerifyExpiry = async (binding, expected) => ({
  status: "expired", commitment: "finalized", genesisHash: expected.genesisHash,
  txid: binding.txid, messageHash: binding.messageHash,
});

async function fixture(t: TestContext, stop: "sending" | "lost" | "recorded" | "acknowledged" = "lost") {
  const h = harness("ai_agent", "degen");
  const { directory, journal } = await journalFor(t, policy);
  const key = h.operation.operationKey;
  const requests: Array<{ method: string; path: string }> = [];
  let response: unknown;
  const client = new AudaceFiClient({ origin: h.client.origin, credential: () => "synthetic-test-token",
    writes: "explicitly-authorized", transport: async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({ method: String(init.method), path });
      if (path.endsWith("/submission") && response !== undefined) return Response.json(response);
      if (path.endsWith("/submit-durable")) {
        if (stop === "lost" || stop === "sending") throw new Error("SYNTHETIC_SEND_RESPONSE_LOST");
        if (stop === "acknowledged") return Response.json({ ...await (await h.transport(url, init)).json(), state: "UNKNOWN" });
      }
      return h.transport(url, init);
    },
  });
  if (stop === "sending") {
    const append = journal.append.bind(journal);
    journal.append = async (...args: Parameters<FileJournal["append"]>) => {
      if (args[1].stage === "AMBIGUOUS") throw new Error("SYNTHETIC_PROCESS_STOP");
      await append(...args);
    };
    await assert.rejects(runOperation(client, journal, h.operation, h.ports, () => clock), /SYNTHETIC_PROCESS_STOP/);
  } else {
    h.faults.lostSubmit = stop === "recorded";
    const result = await runOperation(client, journal, h.operation, h.ports, () => clock);
    assert.equal(result.state, stop === "acknowledged" ? "UNKNOWN" : "AMBIGUOUS");
  }
  const reopened = await FileJournal.create(directory, policy);
  const events = (await reopened.read(key)).events;
  const signed = events.find(event => event.stage === "SIGNED");
  assert.ok(signed?.intentId && signed.playerSignature);
  assert.equal(events.at(-1)?.stage, stop === "sending" ? "SENDING" : "AMBIGUOUS");
  const terminalUnsent = { protocol: terminalProtocol, intentId: signed.intentId, playerSignature: signed.playerSignature, status: "failed" };
  const attest = (overrides: Record<string, unknown> = {}) => { response = {
    protocol: submissionProtocol, submission: null, resultStatus: null, terminalUnsent, ...overrides,
  }; };
  const postCount = () => requests.filter(request => request.method === "POST").length;
  const lookupCount = () => requests.filter(request => request.path.endsWith("/submission")).length;
  const recover = (verify: VerifyExpiry = expired) => reconcileExpiredUnsentOperation(client, reopened, key, verify);
  const reserveNext = (amountInRaw: string) => reopened.reserve(nextKey, digest({ next: true }), asset(1), amountInRaw, client.origin);
  return { h, key, client, journal: reopened, signed, terminalUnsent, attest, postCount, lookupCount, recover, reserveNext };
}

for (const stop of ["sending", "lost"] as const) {
  test(`finalized expiry and a bound terminal no-submission response recover ${stop}`, async t => {
    const f = await fixture(t, stop);
    const before = f.postCount();
    assert.equal((await f.journal.readRecovery(f.key)).signed, undefined);
    await assert.rejects(f.reserveNext("1"), /UNRESOLVED_OPERATION/);
    f.attest();
    let proofCalls = 0;
    assert.equal(await f.recover(async (binding, expected) => {
      proofCalls++;
      assert.ok(Object.isFrozen(binding) && Object.isFrozen(expected));
      assert.deepEqual(binding, {
        messageHash: f.signed.messageHash, transactionHash: f.signed.transactionHash,
        playerPublicKey: f.signed.playerPublicKey, txid: f.signed.playerSignature,
      });
      assert.deepEqual(expected, { genesisHash: f.signed.genesisHash, origin: f.client.origin });
      return expired(binding, expected);
    }), true);
    const completed = (await f.journal.read(f.key)).events.at(-1);
    assert.deepEqual(completed, {
      stage: "EXPIRED_UNSENT", intentId: f.signed.intentId, txid: f.signed.playerSignature, serverAttested: true,
    });
    assert.equal(proofCalls, 1);
    const lookups = f.lookupCount();
    assert.equal(await f.recover(async () => { throw new Error("expiry proof requested again"); }), true);
    assert.equal(f.lookupCount(), lookups);
    const capacity = await f.journal.capacity();
    assert.equal(capacity.unresolvedOperations, 0);
    assert.equal(capacity.reservedOperations, 1);
    assert.equal(capacity.budgets[asset(1)]?.remainingRaw, "1000000");
    await assert.rejects(f.reserveNext("1000001"), /BUDGET_EXHAUSTED/);
    await f.reserveNext("1000000");
    assert.equal(f.postCount(), before);
    assert.equal(f.h.counts().signs, 1);
  });
}

test("legacy no-record lookups and unknown expiry keep an ambiguous send pending", async t => {
  const f = await fixture(t);
  const before = f.postCount();
  assert.equal(await f.recover(async () => { throw new Error("expiry called without attestation"); }), false);
  f.attest();
  assert.equal(await f.recover(async () => ({ status: "unknown" })), false);
  assert.equal((await f.journal.read(f.key)).events.at(-1)?.stage, "AMBIGUOUS");
  await assert.rejects(f.reserveNext("1"), /UNRESOLVED_OPERATION/);
  assert.equal(f.postCount(), before);
});

test("an attestation for another signature or unbound expiry cannot release the original reservation", async t => {
  const f = await fixture(t);
  const before = f.postCount();
  const otherSignature = encode58(Buffer.alloc(64, 12));
  f.attest({ terminalUnsent: { ...f.terminalUnsent, playerSignature: otherSignature } });
  assert.equal(await f.recover(async () => { throw new Error("expiry called for the wrong signature"); }), false);
  f.attest();
  for (const mismatch of [
    { txid: otherSignature }, { messageHash: "0".repeat(64) }, { genesisHash: asset(14) }, { commitment: "confirmed" },
  ]) {
    await assert.rejects(f.recover(async (binding, expected) => ({
      ...await expired(binding, expected), ...mismatch,
    } as Awaited<ReturnType<VerifyExpiry>>)), /INVALID_UNSENT_EXPIRY_EVIDENCE/);
  }
  assert.equal((await f.journal.read(f.key)).events.at(-1)?.stage, "AMBIGUOUS");
  await assert.rejects(f.reserveNext("1"), /UNRESOLVED_OPERATION/);
  assert.equal(f.postCount(), before);
});

test("an unacknowledged send cannot use the pre-send expiry transition", async t => {
  const f = await fixture(t);
  await assert.rejects(f.journal.append(f.key, {
    stage: "EXPIRED_UNSENT", intentId: f.terminalUnsent.intentId, txid: f.terminalUnsent.playerSignature,
  }), /INVALID_JOURNAL_ORDER/);
  assert.equal((await f.journal.read(f.key)).events.at(-1)?.stage, "AMBIGUOUS");
});

test("a second reconciliation cannot race the attested expiry transition", async t => {
  const f = await fixture(t);
  const before = f.postCount();
  f.attest();
  let enterExpiry!: () => void;
  let finishExpiry!: () => void;
  const started = new Promise<void>(resolve => { enterExpiry = resolve; });
  const release = new Promise<void>(resolve => { finishExpiry = resolve; });
  const closing = f.recover(async (binding, expected) => {
    enterExpiry();
    await release;
    return expired(binding, expected);
  });
  // Observe any early failure instead of waiting forever for a rejected proof callback.
  await Promise.race([started, closing]);
  try {
    await assert.rejects(f.recover(), /FINALIZATION_LOCK_HELD/);
  } finally {
    finishExpiry();
  }
  assert.equal(await closing, true);
  assert.equal((await f.journal.read(f.key)).events.filter(event => event.stage === "EXPIRED_UNSENT").length, 1);
  assert.equal(f.postCount(), before);
});

test("parsed no-submission evidence is optional and rejects another intent or contradictory results", async t => {
  const f = await fixture(t);
  const intentId = f.terminalUnsent.intentId;
  assert.deepEqual(await f.client.readSubmissionStatus(intentId), {
    submission: null, resultStatus: null, resultStatusKnown: false,
  });
  f.attest({ terminalUnsent: { ...f.terminalUnsent, intentId: syntheticId(950) } });
  await assert.rejects(f.client.readSubmissionStatus(intentId), /SUBMISSION_CONTEXT_MISMATCH/);
  f.attest({ resultStatus: "failed" });
  await assert.rejects(f.client.readSubmissionStatus(intentId), /SUBMISSION_CONTEXT_MISMATCH/);
  f.attest({ terminalUnsent: { ...f.terminalUnsent, protocol: "audacefi.bench.terminal-unsent.v999" } });
  await assert.rejects(f.client.readSubmissionStatus(intentId), /SUBMISSION_CONTEXT_MISMATCH/);
  f.attest({ terminalUnsent: { ...f.terminalUnsent, playerSignature: "malformed" } });
  await assert.rejects(f.client.readSubmissionStatus(intentId), /INVALID_SIGNATURE/);
  f.attest();
  const status = await f.client.readSubmissionStatus(intentId);
  assert.equal(status.submission, null);
  assert.deepEqual(status.terminalUnsent, f.terminalUnsent);
  assert.equal((await f.journal.read(f.key)).events.at(-1)?.stage, "AMBIGUOUS");
});

for (const stop of ["recorded", "acknowledged"] as const) {
  test(`${stop} submission evidence prevents no-submission closure`, async t => {
    const f = await fixture(t, stop);
    const before = f.postCount();
    if (stop === "acknowledged") {
      assert.equal((await f.journal.read(f.key)).events.at(-1)?.txid, f.signed.playerSignature);
      f.attest();
    } else {
      const recorded = (await f.client.readSubmissionStatus(f.terminalUnsent.intentId)).submission;
      assert.ok(recorded);
      assert.equal(await f.recover(async () => { throw new Error("expiry called for durable work"); }), false);
      f.attest({ submission: recorded });
      await assert.rejects(f.client.readSubmissionStatus(f.terminalUnsent.intentId), /SUBMISSION_CONTEXT_MISMATCH/);
      f.attest({ submission: recorded, terminalUnsent: undefined });
    }
    assert.equal(await f.recover(async () => { throw new Error("expiry called for durable work"); }), false);
    assert.equal((await f.journal.read(f.key)).events.at(-1)?.stage, "AMBIGUOUS");
    await assert.rejects(f.reserveNext("1"), /UNRESOLVED_OPERATION/);
    assert.equal(f.postCount(), before);
  });
}

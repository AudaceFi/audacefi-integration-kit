import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AudaceFiClient } from "../src/client.ts";
import { FileJournal } from "../src/journal.ts";
import { abandonOperation, reconcileOperation, resumeRankedOperation, runOperation, type OperatorPorts } from "../src/operation.ts";
import { asset, harness, journalFor } from "./connected-harness.ts";

const binding = "audacefi.swap-intent-input.v1";

async function recoveryFixture(t: TestContext) {
  const h = harness();
  const now = Date.now();
  const key = h.operation.operationKey;
  const expires = now + 60_000;
  const policy = { maxOperations: 2, inputBudgets: { [asset(1)]: "2000000" } };
  const { directory, journal } = await journalFor(t, policy);
  const reopen = () => FileJournal.create(directory, policy);
  h.state.asOf = new Date(now).toISOString();
  Object.assign(h.state.season.active, {
    startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 120_000).toISOString(),
  });
  h.quote.expiresAt = new Date(expires).toISOString();
  const controls = { loseFirstCreate: false, failQuotePolicy: false, refuseDurable: false, expired: false };
  const attempts: string[] = [];
  let admitted: Record<string, unknown> | undefined, signatureAcknowledged = false;
  const client = new AudaceFiClient({ origin: h.client.origin, credential: () => "synthetic-test-token", writes: "explicitly-authorized",
    transport: async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "POST") attempts.push(path.split("/").at(-1)!);
      if (path === "/v1/swap-intents") {
        const { inputBinding, ...input } = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (admitted) {
          assert.equal(inputBinding, binding);
          assert.deepEqual(input, admitted);
          return Response.json({ intentId: h.quote.intentId, status: "built", replayed: true, inputBinding });
        }
        admitted = input;
        if (controls.loseFirstCreate) throw new Error("SYNTHETIC_CREATE_RESPONSE_LOST");
      }
      const response = await h.transport(url, init);
      if (path.endsWith("/signature") && response.ok) signatureAcknowledged = true;
      return response;
    },
  });
  const verifyPlan: OperatorPorts["verifyPlan"] = async (...args) => {
    if (controls.failQuotePolicy) throw new Error("SYNTHETIC_QUOTE_POLICY_REFUSAL");
    const proof = await h.ports.verifyPlan(...args);
    const at = Date.now();
    return { ...proof, balanceObservedAtMs: at, eligibilityObservedAtMs: at, blockhashObservedAtMs: at };
  };
  const ports: OperatorPorts = {
    ...h.ports, verifyPlan,
    revalidate: async (...args) => {
      if (controls.refuseDurable && signatureAcknowledged) throw new Error("SYNTHETIC_DURABLE_GUARD_REFUSED");
      return verifyPlan(...args);
    },
    recovery: {
      capture: () => ({ createdAt: now, lastValidBlockHeight: 1000 }),
      restore: () => {},
      target: () => h.target,
      expired: async () => controls.expired,
    },
  };
  return { h, key, journal, reopen, controls, client, attempts,
    run: () => runOperation(client, journal, h.operation, ports),
    resume: async () => resumeRankedOperation(client, await reopen(), key, ports, expires),
  };
}

for (const failure of ["lost quote", "quote policy refusal"]) {
  test(`an exact bound unsigned replay can be abandoned after a ${failure}`, async t => {
    const { h, key, journal, controls, attempts, run, resume } = await recoveryFixture(t);
    controls.loseFirstCreate = true;
    assert.equal((await run()).state, "AMBIGUOUS");
    await assert.rejects(abandonOperation(journal, key), /INTENT_UNKNOWN_MANUAL_RECONCILIATION/);
    if (failure === "lost quote") h.faults.rejectPath = "/quote";
    else controls.failQuotePolicy = true;
    await resume();
    const { events } = await journal.read(key);
    assert.deepEqual(events.find(event => event.stage === "INTENT"), {
      stage: "INTENT", intentId: h.quote.intentId, replayed: true, exactInputBound: true,
    });
    assert.equal(h.counts().signs, 0);
    assert.deepEqual(attempts, ["swap-intents", "swap-intents", "quote"]);
    await abandonOperation(journal, key);
    assert.equal((await journal.read(key)).events.at(-1)?.stage, "ABANDONED");
    const capacity = await journal.capacity();
    assert.equal(capacity.unresolvedOperations, 0);
    assert.equal(capacity.reservedOperations, 1);
    assert.equal(capacity.budgets[asset(1)]?.remainingRaw, "1000000");
  });
}

test("a replay marker cannot be added to a journal without retained input", async t => {
  const h = harness();
  const { journal } = await journalFor(t);
  const { operationKey, tokenInMint, amountInRaw } = h.operation;
  await journal.reserve(operationKey, "0".repeat(64), tokenInMint, amountInRaw, h.client.origin);
  await assert.rejects(journal.append(operationKey, {
    stage: "INTENT", intentId: h.quote.intentId, replayed: true, exactInputBound: true,
  }), /INVALID_JOURNAL_RECOVERY/);
  await journal.append(operationKey, { stage: "INTENT", intentId: h.quote.intentId, replayed: true });
  await assert.rejects(abandonOperation(journal, operationKey), /REPLAYED_OPERATION_RECONCILE/);
});

for (const outcome of ["expiry", "ambiguous send"]) {
  test(`the append-only journal preserves ${outcome} at the pre-send retry limit`, async t => {
    const { h, key, journal, reopen, controls, client, attempts, run, resume } = await recoveryFixture(t);
    controls.refuseDurable = true;
    assert.equal((await run()).state, "AMBIGUOUS");
    const recovery = await journal.readRecovery(key);
    assert.ok(recovery.signed);
    const retries = outcome === "expiry" ? 28 : 27;
    for (let retry = 0; retry < retries; retry++) {
      await resume();
      const reopened = await reopen();
      const entry = await reopened.read(key);
      assert.equal(entry.events.at(-1)?.stage, "SEND_REFUSED");
      assert.equal(entry.events.length, 6 + 2 * (retry + 1));
      assert.deepEqual(await reopened.readRecovery(key), recovery);
    }
    assert.deepEqual(attempts, ["swap-intents", "quote", "signature"]);
    controls.refuseDurable = false;
    if (outcome === "ambiguous send") {
      h.faults.lostSubmit = true;
      await resume();
      assert.equal((await journal.read(key)).events.at(-1)?.stage, "AMBIGUOUS");
    } else {
      await resume();
      assert.equal((await journal.read(key)).events.length, 62);
      assert.deepEqual(attempts, ["swap-intents", "quote", "signature"]);
    }
    controls.expired = true;
    await resume();
    assert.equal(h.counts().signs, 1);
    const events = (await journal.read(key)).events;
    if (outcome === "expiry") {
      assert.equal(events.at(-1)?.stage, "EXPIRED_UNSENT");
      assert.equal((await journal.capacity()).unresolvedOperations, 0);
      assert.deepEqual(attempts, ["swap-intents", "quote", "signature"]);
    } else {
      assert.equal(events.at(-1)?.stage, "AMBIGUOUS");
      assert.equal((await journal.capacity()).unresolvedOperations, 1);
      assert.ok((await reconcileOperation(client, journal, key))?.txid);
      assert.deepEqual(attempts, ["swap-intents", "quote", "signature", "submit-durable"]);
    }
  });
}

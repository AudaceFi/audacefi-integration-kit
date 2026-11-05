import assert from "node:assert/strict";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FileJournal, type JournalCapacity, type JournalPolicy } from "../src/journal.ts";
import { abandonOperation, finalizeOperation, runOperation } from "../src/operation.ts";
import { runAiAgent, runTradingBot } from "../src/operators.ts";
import { parseSpotSignal, prepareSpotSignal, prepareSpotSignalFromJournal, type SpotSignal, type SpotSignalPlan } from "../src/signals.ts";
import { associatedAddress } from "../src/solana.ts";
import { asset, journalFor, syntheticId } from "./connected-harness.ts";
import { referenceHarness } from "./reference-harness.ts";

const usdcDevnet = asset(3), assetDevnet = asset(4);
type Overrides = { assetDecimals?: number; usdcDecimals?: number; allowPartialExit?: boolean };
async function pilot(t: Parameters<typeof journalFor>[0], journalPolicy: JournalPolicy, run = runTradingBot, overrides: Overrides = {}) {
  const h = referenceHarness();
  const policy = {
    symbol: "TEST",
    seasonId: h.operation.seasonId,
    category: h.operation.category,
    playerPublicKey: h.operation.playerPublicKey,
    usdcMint: asset(1), usdcDecimals: 6,
    assetMint: asset(2), assetDecimals: 6,
    maxEntryBps: 2000, maxPositionRaw: "499500", exitAttempts: 2,
    ...overrides,
  };
  const { directory, journal } = await journalFor(t, journalPolicy);
  const balance = (mint: string) => {
    const account = h.accounts.get(associatedAddress(policy.playerPublicKey, mint));
    return Buffer.from(account.data[0], "base64").readBigUInt64LE(64).toString();
  };
  const readHoldings = () => ({
    observedAtMs: h.getNow(), usdcRaw: balance(usdcDevnet), assetRaw: balance(assetDevnet),
  });
  const signal = (id: string, side: "long" | "flat", sequence: number, ttlMs = 30_000) => parseSpotSignal(JSON.stringify({
    id, sequence, symbol: "TEST", side, targetBps: side === "long" ? 2000 : 0, expiresAtMs: h.getNow() + ttlMs,
  }));
  // Snapshot, holdings, snapshot, through the kit's helper.
  const prepare = (s: SpotSignal, read: () => Promise<ReturnType<typeof readHoldings>> = async () => readHoldings()) =>
    prepareSpotSignalFromJournal({ signal: s, policy, journal, readHoldings: read, clock: h.getNow });
  // The plan's operation carries its limits: passing it is enough to apply them.
  const execute = (plan: SpotSignalPlan, ports = h.suite.ports) => {
    assert.equal(plan.kind, "operation");
    return run({ client: h.client, journal, operation: plan.operation, ports, clock: h.getNow });
  };
  const posted = () => h.calls.filter(c => c.method === "POST").map(c => c.path.split("/").at(-1));
  // Point the synthetic server at a fresh intention and sell quote for the next exit attempt.
  const quoteSell = (n: number, amountInRaw: string, price = 2) => {
    h.quote.intentId = syntheticId(n);
    Object.assign(h.quoteWire, {
      intentId: h.quote.intentId, quoteId: syntheticId(n + 1),
      direction: "sell", amountInRaw, price: String(price), priceUsd: price, expiresAt: new Date(h.getNow() + 60_000).toISOString(),
    });
  };
  h.putToken(policy.playerPublicKey, usdcDevnet, 5_000_000n);
  h.putToken(policy.playerPublicKey, assetDevnet, 0n);
  return { h, policy, directory, journal, signal, prepare, execute, posted, readHoldings, quoteSell };
}
// Room for the entry and two exit attempts of up to 499,500.
const bothBudgets = { maxOperations: 3, inputBudgets: { [asset(1)]: "1000000", [asset(2)]: "999000" } };
const withoutVersion = ({ version, ...rest }: JournalCapacity) => {
  assert.match(version, /^[0-9a-f]{64}$/);
  return rest;
};
function gate() {
  let open!: () => void;
  const closed = new Promise<void>(resolve => { open = resolve; });
  return { closed, open };
}
const deadlineOf = (plan: SpotSignalPlan) => {
  assert.equal(plan.kind, "operation");
  assert.equal(typeof plan.operation.limits.notAfterMs, "number");
  return plan.operation.limits.notAfterMs as number;
};

for (const run of [runTradingBot, runAiAgent]) {
  test(`spot signal pilot through finalized long and flat: ${run.name}`, async t => {
    const { h, policy, journal, signal, prepare, execute, posted, readHoldings, quoteSell } = await pilot(t, bothBudgets, run);
    const long = signal("pilot-long", "long", 1), flat = signal("pilot-flat", "flat", 2);

    const buy = await prepare(long);
    assert.equal(buy.kind, "operation");
    assert.deepEqual([buy.operation.tokenInMint, buy.operation.tokenOutMint, buy.operation.amountInRaw],
      [policy.usdcMint, policy.assetMint, "1000000"]);
    const bought = await execute(buy);
    assert.equal(bought.state, "SUBMITTED");
    h.controls.finalStatus = "confirmed";
    assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "unknown");
    // The holding still shows no asset, but the long is unresolved: the flat is not a no-op.
    await assert.rejects(prepare(flat), /SIGNAL_OPERATION_PENDING/);
    // A caller that misreports the journal is still refused before any request.
    const misreported = prepareSpotSignal({
      signal: flat, policy, holdings: { ...readHoldings(), assetRaw: "499500" },
      journal: { ...(await journal.capacity(h.getNow)), unresolvedOperations: 0 }, nowMs: h.getNow(),
    });
    await assert.rejects(execute(misreported), /UNRESOLVED_OPERATION_RECONCILE/);
    assert.equal(h.counts().walletCalls, 1);
    assert.deepEqual(posted(), ["swap-intents", "quote", "signature", "submit-durable"]);

    h.controls.finalStatus = "finalized";
    assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "confirmed");
    // Apply the finalized fixture fill, then read the updated balances for the next signal.
    h.putToken(policy.playerPublicKey, usdcDevnet, 4_000_000n);
    h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
    h.setNow(h.getNow() + 1_000);
    const sell = await prepare(flat);
    assert.equal(sell.kind, "operation");
    assert.deepEqual([sell.operation.tokenInMint, sell.operation.tokenOutMint, sell.operation.amountInRaw],
      [policy.assetMint, policy.usdcMint, "499500"]);
    assert.notEqual(sell.operation.operationKey, buy.operation.operationKey);
    quoteSell(5, "499500");
    const sold = await execute(sell);
    assert.equal(sold.state, "SUBMITTED");
    assert.notEqual(sold.intentId, bought.intentId);
    assert.notEqual(sold.txid, bought.txid);
    assert.equal(await finalizeOperation(h.client, journal, sell.operation.operationKey, h.suite.verifyFinal), "confirmed");
    h.putToken(policy.playerPublicKey, usdcDevnet, 4_998_001n);
    h.putToken(policy.playerPublicKey, assetDevnet, 0n);
    const closingHoldings = readHoldings();
    assert.deepEqual([closingHoldings.usdcRaw, closingHoldings.assetRaw], ["4998001", "0"]);
    assert.deepEqual(await prepare(flat), { kind: "noop" });
    assert.equal(h.counts().walletCalls, 2);
    for (const operation of [buy.operation, sell.operation]) {
      assert.equal((await journal.read(operation.operationKey)).events.at(-1)?.stage, "FINAL_CONFIRMED");
    }
    const expected = ["swap-intents", "quote", "signature", "submit-durable", "result"];
    assert.deepEqual(posted(), [...expected, ...expected]);
    assert.deepEqual(withoutVersion(await journal.capacity(h.getNow)), {
      observedAtMs: h.getNow(), unresolvedOperations: 0, runningOperations: 0, reservedOperations: 2, remainingOperations: 1,
      budgets: { [policy.usdcMint]: { limitRaw: "1000000", remainingRaw: "0" }, [policy.assetMint]: { limitRaw: "999000", remainingRaw: "499500" } },
    });
  });
}

test("journal capacity writes nothing and fails closed on a held reservation lock", async t => {
  const { h, directory, journal, signal, prepare, execute } = await pilot(t, bothBudgets);
  const before = await readdir(directory);
  assert.deepEqual(withoutVersion(await journal.capacity(h.getNow)), {
    observedAtMs: h.getNow(), unresolvedOperations: 0, runningOperations: 0, reservedOperations: 0, remainingOperations: 3,
    budgets: { [asset(1)]: { limitRaw: "1000000", remainingRaw: "1000000" }, [asset(2)]: { limitRaw: "999000", remainingRaw: "999000" } },
  });
  assert.deepEqual(await readdir(directory), before);
  const buy = await prepare(signal("pilot-long-cap", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal((await execute(buy)).state, "SUBMITTED");
  const pending = await journal.capacity(h.getNow);
  assert.deepEqual([pending.unresolvedOperations, pending.runningOperations, pending.reservedOperations, pending.remainingOperations, pending.budgets[asset(1)]!.remainingRaw], [1, 0, 1, 2, "0"]);
  // A finalized failure resolves the operation; its reservation still counts against the budget.
  h.controls.finalError = { InstructionError: [2, { Custom: 6000 }] };
  assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "failed");
  const failed = await journal.capacity(h.getNow);
  assert.deepEqual([failed.unresolvedOperations, failed.remainingOperations, failed.budgets[asset(1)]!.remainingRaw], [0, 2, "0"]);
  await (await open(join(directory, "reservation.lock"), "wx")).close();
  await assert.rejects(journal.capacity(h.getNow), /RESERVATION_LOCK_HELD/);
});

test("a reservation without any recorded event counts as unresolved", async t => {
  const { h, journal } = await pilot(t, bothBudgets);
  // A process stopped right after reserving leaves no event.
  await journal.reserve("synthetic-stopped-key", "a".repeat(64), asset(1), "1", h.client.origin);
  const snapshot = await journal.capacity(h.getNow);
  assert.deepEqual([snapshot.unresolvedOperations, snapshot.reservedOperations], [1, 1]);
});

test("a run in progress makes a flat pending, and the newer flat supersedes the unreserved long", async t => {
  const { h, journal, signal, prepare, execute, posted, readHoldings } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-race", "long", 1));
  assert.equal(buy.kind, "operation");
  // The long is paused before its reservation, while it verifies the target.
  const paused = gate();
  const ports = { ...h.suite.ports, verifyTarget: async () => { await paused.closed; return h.suite.ports.verifyTarget(); } };
  const running = execute(buy, ports);
  assert.equal((await journal.capacity(h.getNow)).runningOperations, 1);
  await assert.rejects(prepare(signal("pilot-flat-race", "flat", 2)), /SIGNAL_OPERATION_PENDING/);
  // The flat is newer than the long, which has not reserved yet: the long is refused before any write.
  paused.open();
  await assert.rejects(running, /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.deepEqual([posted(), (await journal.capacity(h.getNow)).runningOperations], [[], 0]);
  // Prepared again, the flat finds nothing to exit.
  assert.deepEqual(await prepare(signal("pilot-flat-race", "flat", 2)), { kind: "noop" });
  // Holdings that claim to be read after the second snapshot are refused.
  await assert.rejects(prepare(signal("pilot-flat-late", "flat", 3), async () => ({ ...readHoldings(), observedAtMs: h.getNow() + 1 })), /SIGNAL_HOLDINGS_AFTER_JOURNAL/);
});

test("a newer signal supersedes older plans even when it is refused", async t => {
  const { h, policy, journal, signal, prepare, execute, posted, quoteSell } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-sup", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal((await execute(buy)).state, "SUBMITTED");
  assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "confirmed");
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  // An exit waits for approval; a newer long is refused because the position is open.
  const exit = await prepare(signal("pilot-flat-sup", "flat", 2));
  assert.equal(exit.kind, "operation");
  await assert.rejects(prepare(signal("pilot-long-sup2", "long", 3)), /SIGNAL_POSITION_ALREADY_OPEN/);
  // The latest signal wants the position: the older exit no longer runs.
  quoteSell(5, "499500");
  await assert.rejects(execute(exit), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.equal(posted().filter(p => p === "submit-durable").length, 1);
  // A stale claim no longer matches its own snapshot.
  const claim = journal.claimPlanVersion();
  const stale = await journal.capacity(h.getNow);
  assert.equal(journal.matchesPlanVersion(stale, claim), true);
  await prepare(signal("pilot-flat-sup3", "flat", 4));
  assert.equal(journal.matchesPlanVersion(stale, claim), false);
});

test("a plan never survives a restart of the kit", async t => {
  const { h, policy, directory, signal, prepare, posted } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-restart", "long", 1));
  assert.equal(buy.kind, "operation");
  // A fresh copy of the journal module stands for a restarted process: its plan markers start anew.
  const fresh = await import(new URL("../src/journal.ts?restart=" + Date.now(), import.meta.url).href) as typeof import("../src/journal.ts");
  const restarted = await fresh.FileJournal.create(directory, bothBudgets);
  const { operationKey, tokenInMint, amountInRaw, limits } = buy.operation;
  await assert.rejects(restarted.reserve(operationKey, "a".repeat(64), tokenInMint, amountInRaw, h.client.origin, limits.journalVersion), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  // A new signal can still be prepared with the restarted journal.
  assert.deepEqual(await prepareSpotSignalFromJournal({
    signal: signal("pilot-flat-restart", "flat", 2), policy, journal: restarted, clock: h.getNow,
    readHoldings: async () => ({ observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" }),
  }), { kind: "noop" });
  await assert.rejects(runTradingBot({ client: h.client, journal: restarted, operation: buy.operation, ports: h.suite.ports, clock: h.getNow }), /JOURNAL_LIMITS_UNSUPPORTED/);
  assert.deepEqual(posted(), []);
});

test("the same plan can be retried after a refusal before its reservation", async t => {
  const { directory, signal, prepare, execute } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-again", "long", 1));
  assert.equal(buy.kind, "operation");
  const lock = join(directory, "reservation.lock");
  await (await open(lock, "wx")).close();
  await assert.rejects(execute(buy), /RESERVATION_LOCK_HELD/);
  await unlink(lock);
  assert.equal((await execute(buy)).state, "SUBMITTED");
});

test("a run that starts while holdings are read is refused, or voids the holdings if it is not bound", async t => {
  const { h, journal, signal, prepare, execute } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-mid", "long", 1));
  assert.equal(buy.kind, "operation");
  const reserved = gate(), paused = gate();
  const ports = { ...h.suite.ports, assertTargetCurrent: async () => { reserved.open(); await paused.closed; await h.suite.ports.assertTargetCurrent!(); } };
  let running: ReturnType<typeof runTradingBot> | undefined;
  const flat = prepare(signal("pilot-flat-mid", "flat", 2), async () => {
    // The flat superseded the long at admission: run as prepared, the long is refused before any write.
    await assert.rejects(execute(buy, ports), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
    // Without its journal version, the same operation reserves, then pauses at its first write.
    const { notAfterMs, outputDecimals } = buy.operation.limits;
    running = runTradingBot({ client: h.client, journal, operation: { ...buy.operation, limits: { notAfterMs, outputDecimals } }, ports, clock: h.getNow });
    await reserved.closed;
    return { observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" };
  });
  await assert.rejects(flat, /SIGNAL_JOURNAL_CHANGED/);
  paused.open();
  assert.equal((await running!).state, "SUBMITTED");
  assert.equal((await journal.capacity(h.getNow)).unresolvedOperations, 1);
});

test("a signal that states no intent for the pair supersedes nothing and reads no holdings", async t => {
  const { h, policy, journal, signal, prepare, execute, posted, readHoldings, quoteSell } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-keep", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal((await execute(buy)).state, "SUBMITTED");
  assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "confirmed");
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  const exit = await prepare(signal("pilot-flat-keep", "flat", 2));
  assert.equal(exit.kind, "operation");
  let reads = 0;
  const read = async () => { reads++; return readHoldings(); };
  const other = (fields: Record<string, unknown>) => parseSpotSignal(JSON.stringify({
    id: "pilot-long-other", sequence: 3, symbol: "TEST", side: "long", targetBps: 2000, expiresAtMs: h.getNow() + 30_000, ...fields,
  }));
  const refused: [SpotSignal, RegExp][] = [
    [other({ symbol: "ETH" }), /SIGNAL_PAIR_NOT_ALLOWED/],
    [other({ expiresAtMs: h.getNow() }), /SIGNAL_EXPIRY_INVALID/],
    [{ id: "x" } as never, /INVALID_SIGNAL_ID/],
  ];
  for (const [refusedSignal, error] of refused) {
    await assert.rejects(prepareSpotSignalFromJournal({ signal: refusedSignal, policy, journal, readHoldings: read, clock: h.getNow }), error);
  }
  assert.equal(reads, 0);
  // The exit prepared before them still runs.
  quoteSell(5, "499500");
  assert.equal((await execute(exit)).state, "SUBMITTED");
  assert.equal(posted().filter(p => p === "submit-durable").length, 2);
});

test("a signal for the pair supersedes older plans even when its entry limit or policy refuses it", async t => {
  const { h, policy, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
  const refused: [string, "long" | "flat", object, RegExp][] = [
    ["pilot-flat-typo", "flat", { ...policy, allowPartialExits: true }, /UNKNOWN_FIELD/],
    ["pilot-flat-null", "flat", { ...policy, allowPartialExit: null }, /SIGNAL_POLICY_INVALID/],
    ["pilot-flat-text", "flat", { ...policy, allowPartialExit: "true" }, /SIGNAL_POLICY_INVALID/],
    ["pilot-long-over", "long", { ...policy, maxEntryBps: 1999 }, /SIGNAL_ENTRY_LIMIT/],
  ];
  let sequence = 1;
  for (const [id, side, newerPolicy, error] of refused) {
    const waiting = await prepare(signal(`pilot-long-wait${sequence}`, "long", sequence++));
    assert.equal(waiting.kind, "operation");
    await assert.rejects(prepareSpotSignalFromJournal({
      signal: signal(id, side, sequence++), policy: newerPolicy as never, journal, clock: h.getNow,
      readHoldings: async () => ({ observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" }),
    }), error);
    // The newer signal states the latest intent for the pair: the older long no longer runs.
    await assert.rejects(execute(waiting), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  }
  assert.deepEqual(posted(), []);
});

test("a new run or plan claim between the snapshots voids the holdings", async t => {
  const { h, policy, journal, signal, prepare, execute, posted, readHoldings } = await pilot(t, bothBudgets);
  // A run that starts during the read but has not reserved by the second snapshot: only the running count differs.
  const buy = await prepare(signal("pilot-long-run", "long", 1));
  assert.equal(buy.kind, "operation");
  const paused = gate();
  let running: ReturnType<typeof execute> | undefined;
  await assert.rejects(prepare(signal("pilot-flat-run", "flat", 2), async () => {
    running = execute(buy, { ...h.suite.ports, verifyTarget: async () => { await paused.closed; return h.suite.ports.verifyTarget(); } });
    return readHoldings();
  }), /SIGNAL_JOURNAL_CHANGED/);
  paused.open();
  await assert.rejects(running!, /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  // A newer signal prepared during the read: only the version differs, and the newer plan is the one that runs.
  let newer: SpotSignalPlan | undefined;
  await assert.rejects(prepare(signal("pilot-flat-older", "flat", 3), async () => {
    newer = await prepare(signal("pilot-long-newer", "long", 4));
    return readHoldings();
  }), /SIGNAL_JOURNAL_CHANGED/);
  assert.equal((await execute(newer!)).state, "SUBMITTED");
  // A pending operation is refused before the callback can read holdings.
  assert.equal(newer!.kind, "operation");
  const key = newer!.kind === "operation" ? newer!.operation.operationKey : "";
  let reads = 0;
  await assert.rejects(prepare(signal("pilot-flat-final", "flat", 5), async () => {
    reads++;
    throw new Error("SYNTHETIC_READ_FAILED");
  }), /SIGNAL_OPERATION_PENDING/);
  assert.equal(reads, 0);
  assert.equal(await finalizeOperation(h.client, journal, key, h.suite.verifyFinal), "confirmed");
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  assert.equal((await prepare(signal("pilot-flat-final", "flat", 5))).kind, "operation");
  assert.deepEqual(posted(), ["swap-intents", "quote", "signature", "submit-durable", "result"]);
});

test("a relevant signal supersedes older plans even when its first snapshot fails", async t => {
  const { h, directory, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-lock", "long", 1));
  assert.equal(buy.kind, "operation");
  const lock = join(directory, "reservation.lock");
  await (await open(lock, "wx")).close();
  await assert.rejects(prepare(signal("pilot-flat-lock", "flat", 2)), /RESERVATION_LOCK_HELD/);
  await unlink(lock);
  assert.notEqual((await journal.capacity(h.getNow)).version, buy.operation.limits.journalVersion);
  // The old plan is refused before the flat has been retried.
  await assert.rejects(execute(buy), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.deepEqual(await prepare(signal("pilot-flat-lock", "flat", 2)), { kind: "noop" });
  assert.deepEqual(posted(), []);
});

test("a signal supersedes older plans even when its holdings are not usable", async t => {
  const { h, signal, prepare, execute, posted, readHoldings } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-read", "long", 1));
  assert.equal(buy.kind, "operation");
  // A newer flat whose holdings read fails still stops the older long.
  await assert.rejects(prepare(signal("pilot-flat-read", "flat", 2), async () => { throw new Error("SYNTHETIC_READ_FAILED"); }), /SYNTHETIC_READ_FAILED/);
  await assert.rejects(execute(buy), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  // So does one whose holdings are dated after its second snapshot.
  const again = await prepare(signal("pilot-long-read2", "long", 3));
  await assert.rejects(prepare(signal("pilot-flat-read2", "flat", 4), async () => ({ ...readHoldings(), observedAtMs: h.getNow() + 1 })), /SIGNAL_HOLDINGS_AFTER_JOURNAL/);
  await assert.rejects(execute(again), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.deepEqual(posted(), []);
});

test("signal and policy values are fixed before the holdings callback", async t => {
  const { policy, signal, prepare, posted, readHoldings } = await pilot(t, bothBudgets);
  const flat = signal("pilot-flat-mutable", "flat", 1);
  assert.deepEqual(await prepare(flat, async () => {
    Object.assign(flat, { side: "long", targetBps: 2000 });
    return readHoldings();
  }), { kind: "noop" });

  const mint = policy.assetMint;
  const plan = await prepare(signal("pilot-long-mutable", "long", 2), async () => {
    policy.assetMint = asset(6);
    policy.maxEntryBps = 1;
    return readHoldings();
  });
  assert.equal(plan.kind, "operation");
  assert.equal(plan.operation.tokenOutMint, mint);
  assert.deepEqual(posted(), []);
});

test("holdings values are fixed before the second snapshot", async t => {
  const { h, policy, journal, signal, readHoldings } = await pilot(t, bothBudgets);
  const holdings = readHoldings();
  let snapshots = 0;
  assert.deepEqual(await prepareSpotSignalFromJournal({
    signal: signal("pilot-flat-holdings", "flat", 1), policy, clock: h.getNow,
    journal: {
      claimPlanVersion: journal.claimPlanVersion.bind(journal),
      matchesPlanVersion: journal.matchesPlanVersion.bind(journal),
      capacity: clock => {
        if (++snapshots === 2) holdings.assetRaw = "499500";
        return journal.capacity(clock);
      },
    },
    readHoldings: async () => holdings,
  }), { kind: "noop" });
});

test("an older helper cannot return a plan or no-op after either snapshot loses its claim", async t => {
  const { h, policy, journal, signal, readHoldings } = await pilot(t, bothBudgets);
  for (const staleSnapshot of [1, 2]) {
    let snapshots = 0, reads = 0;
    await assert.rejects(prepareSpotSignalFromJournal({
      signal: signal("pilot-flat-stale" + staleSnapshot, "flat", staleSnapshot), policy, clock: h.getNow,
      journal: {
        claimPlanVersion: journal.claimPlanVersion.bind(journal),
        matchesPlanVersion: journal.matchesPlanVersion.bind(journal),
        capacity: async clock => {
          const snapshot = await journal.capacity(clock);
          if (++snapshots === staleSnapshot) journal.claimPlanVersion();
          return snapshot;
        },
      },
      readHoldings: async () => { reads++; return readHoldings(); },
    }), /SIGNAL_JOURNAL_CHANGED/);
    assert.equal(reads, staleSnapshot - 1);
  }
});

test("the package exports the helper but not the pure step, whose plans supersede nothing", async () => {
  const entry = await import("../src/index.ts");
  assert.equal(typeof entry.prepareSpotSignalFromJournal, "function");
  assert.equal("prepareSpotSignal" in entry, false);
});

test("an entry the journal could not exit is refused before any request or wallet prompt", async t => {
  for (const [journalPolicy, code] of [
    [{ maxOperations: 3, inputBudgets: { [asset(1)]: "1000000" } }, /SIGNAL_EXIT_BUDGET_MISSING/],
    [{ maxOperations: 2, inputBudgets: { [asset(1)]: "1000000", [asset(2)]: "999000" } }, /SIGNAL_EXIT_SLOT_MISSING/],
    [{ maxOperations: 3, inputBudgets: { [asset(1)]: "1000000", [asset(2)]: "1000000000000000" } }, /SIGNAL_EXIT_BUDGET_TOO_LARGE/],
    [{ maxOperations: 3, inputBudgets: { [asset(1)]: "1000000", [asset(2)]: "998999" } }, /SIGNAL_EXIT_BUDGET_LOW/],
  ] as const) {
    const { h, signal, prepare, posted } = await pilot(t, journalPolicy);
    await assert.rejects(prepare(signal("pilot-long-nox", "long", 1)), code);
    assert.deepEqual([posted(), h.counts().walletCalls], [[], 0]);
  }
  // Declared asset decimals that differ from the verified mapping stop the entry before any reservation.
  const { h, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets, runTradingBot, { assetDecimals: 5 });
  const buy = await prepare(signal("pilot-long-dec", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal(buy.operation.limits.outputDecimals, 5);
  await assert.rejects(execute(buy), /OUTPUT_DECIMALS_MISMATCH/);
  assert.deepEqual([posted(), h.counts().walletCalls, (await journal.capacity(h.getNow)).remainingOperations], [[], 0, 3]);
});

test("an exit checks the received USDC decimals too, before any reservation", async t => {
  const { h, policy, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets, runTradingBot, { usdcDecimals: 5 });
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  const sell = await prepare(signal("pilot-flat-dec", "flat", 2));
  assert.equal(sell.kind, "operation");
  assert.equal(sell.operation.limits.outputDecimals, 5);
  await assert.rejects(execute(sell), /OUTPUT_DECIMALS_MISMATCH/);
  assert.deepEqual([posted(), (await journal.capacity(h.getNow)).reservedOperations], [[], 0]);
});

test("limits are validated strictly and cannot be smuggled into the operation itself", async t => {
  const { h, journal, signal, prepare, posted } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-lim", "long", 1));
  assert.equal(buy.kind, "operation");
  const call = (limits: unknown) => runTradingBot({ client: h.client, journal, operation: { ...buy.operation, limits: limits as never }, ports: h.suite.ports, clock: h.getNow });
  await assert.rejects(call({ ...buy.operation.limits, extra: 1 }), /UNKNOWN_FIELD/);
  await assert.rejects(call({ ...buy.operation.limits, notAfterMs: 1.5 }), /INVALID_INTEGER/);
  await assert.rejects(call({ ...buy.operation.limits, journalVersion: "x" }), /INVALID_JOURNAL_VERSION/);
  // The low-level runner takes limits only as its own argument.
  await assert.rejects(runOperation(h.client, journal, { ...buy.operation, actor: "trading_bot" }, h.suite.ports, h.getNow), /UNKNOWN_FIELD/);
  const after = await journal.capacity(h.getNow);
  assert.deepEqual([posted(), after.reservedOperations, after.runningOperations], [[], 0, 0]);
});

test("a newer signal supersedes a plan still waiting to run", async t => {
  const { h, journal, signal, prepare, execute, posted } = await pilot(t, { maxOperations: 4, inputBudgets: { [asset(1)]: "2000000", [asset(2)]: "999000" } });
  // An entry waits for operator approval while a flat arrives: with no asset held, the flat is a no-op.
  const waiting = await prepare(signal("pilot-long-wait", "long", 1));
  assert.deepEqual(await prepare(signal("pilot-flat-wait", "flat", 2)), { kind: "noop" });
  // The flat was consumed, so the older entry must not open a position after it.
  await assert.rejects(execute(waiting), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  // Of two entries prepared in turn, only the later one can run.
  const first = await prepare(signal("pilot-long-one", "long", 3));
  const second = await prepare(signal("pilot-long-two", "long", 4));
  await assert.rejects(execute(first), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.equal(second.kind, "operation");
  assert.equal((await execute(second)).state, "SUBMITTED");
  // Earlier refusals take precedence: the key is already reserved.
  await assert.rejects(execute(second), /OPERATION_ALREADY_RESERVED_RECONCILE/);
  assert.equal(await finalizeOperation(h.client, journal, second.operation.operationKey, h.suite.verifyFinal), "confirmed");
  assert.deepEqual([posted(), h.counts().walletCalls], [["swap-intents", "quote", "signature", "submit-durable", "result"], 1]);
});

test("a low-level plan is bound to its snapshot's reservation count", async t => {
  const { h, policy, journal, signal, execute, posted } = await pilot(t, { maxOperations: 4, inputBudgets: { [asset(1)]: "2000000", [asset(2)]: "999000" } });
  // Two plans from one snapshot, without the helper and its claim.
  const snapshot = await journal.capacity(h.getNow);
  const holdings = { observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" };
  const plan = (id: string) => prepareSpotSignal({ signal: signal(id, "long", 1), policy, holdings, journal: snapshot, nowMs: h.getNow() });
  const first = plan("pilot-long-low1"), second = plan("pilot-long-low2");
  assert.equal(first.kind, "operation");
  assert.equal((await execute(first)).state, "SUBMITTED");
  // An unresolved operation is reported before the changed snapshot.
  await assert.rejects(execute(second), /UNRESOLVED_OPERATION_RECONCILE/);
  assert.equal(await finalizeOperation(h.client, journal, first.operation.operationKey, h.suite.verifyFinal), "confirmed");
  // The first entry is final and the second would open a second position: its snapshot no longer holds.
  await assert.rejects(execute(second), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.deepEqual(posted(), ["swap-intents", "quote", "signature", "submit-durable", "result"]);
});

test("journal instances on one directory share run counts and versions; failures leave nothing behind", async t => {
  const { h, directory, journal, signal, prepare, execute } = await pilot(t, bothBudgets);
  const twin = await FileJournal.create(directory, bothBudgets);
  assert.equal((await twin.capacity(h.getNow)).version, (await journal.capacity(h.getNow)).version);
  const buy = await prepare(signal("pilot-long-twin", "long", 1));
  assert.equal(buy.kind, "operation");
  const paused = gate();
  const running = execute(buy, { ...h.suite.ports, verifyTarget: async () => { await paused.closed; return h.suite.ports.verifyTarget(); } });
  assert.equal((await twin.capacity(h.getNow)).runningOperations, 1);
  paused.open();
  assert.equal((await running).state, "SUBMITTED");
  // A pending operation rejects without reading holdings, and leaves no lock or running count behind.
  await assert.rejects(prepare(signal("pilot-flat-fail", "flat", 2), async () => { throw new Error("SYNTHETIC_READ_FAILED"); }), /SIGNAL_OPERATION_PENDING/);
  const after = await twin.capacity(h.getNow);
  assert.deepEqual([after.runningOperations, after.unresolvedOperations], [0, 1]);
  // A malformed call rejects instead of throwing synchronously.
  let result: Promise<unknown> | undefined;
  assert.doesNotThrow(() => { result = runTradingBot({ client: h.client, journal, operation: null as never, ports: h.suite.ports, clock: h.getNow }); });
  await assert.rejects(result!);
});

test("a plan made against one journal is refused by another with the same policy and count", async t => {
  const { h, policy, signal, posted } = await pilot(t, bothBudgets);
  const { journal: planned } = await journalFor(t, bothBudgets);
  const { journal: other } = await journalFor(t, bothBudgets);
  const plan = await prepareSpotSignalFromJournal({
    signal: signal("pilot-long-other", "long", 1), policy, journal: planned, clock: h.getNow,
    readHoldings: async () => ({ observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" }),
  });
  assert.equal(plan.kind, "operation");
  // One signal on the other journal too, so the two differ only by their directory.
  assert.deepEqual(await prepareSpotSignalFromJournal({
    signal: signal("pilot-flat-other", "flat", 2), policy, journal: other, clock: h.getNow,
    readHoldings: async () => ({ observedAtMs: h.getNow(), usdcRaw: "5000000", assetRaw: "0" }),
  }), { kind: "noop" });
  assert.equal((await other.capacity(h.getNow)).reservedOperations, 0);
  await assert.rejects(runTradingBot({ client: h.client, journal: other, operation: plan.operation, ports: h.suite.ports, clock: h.getNow }), /JOURNAL_CHANGED_SINCE_SNAPSHOT/);
  assert.deepEqual(posted(), []);
});

test("each exit attempt has its own room, so a failed flat can be issued again", async t => {
  const { h, policy, journal, signal, prepare, execute, posted, quoteSell } = await pilot(t, bothBudgets, runTradingBot, { allowPartialExit: true });
  const buy = await prepare(signal("pilot-long-retry", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal((await execute(buy)).state, "SUBMITTED");
  assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "confirmed");
  h.putToken(policy.playerPublicKey, usdcDevnet, 4_000_000n);
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  h.setNow(h.getNow() + 1_000);
  // First exit: submitted, then finalized as failed on chain. The holding is unchanged.
  const firstExit = await prepare(signal("pilot-flat-try1", "flat", 2));
  assert.equal(firstExit.kind, "operation");
  quoteSell(5, "499500");
  assert.equal((await execute(firstExit)).state, "SUBMITTED");
  h.controls.finalError = { InstructionError: [2, { Custom: 6000 }] };
  assert.equal(await finalizeOperation(h.client, journal, firstExit.operation.operationKey, h.suite.verifyFinal), "failed");
  h.controls.finalError = null;
  // Someone sends the wallet 1 raw unit. The second attempt still has its own slot and budget. With partial exits
  // allowed, it sells what the budget allows and reports the rest instead of selling nothing.
  h.putToken(policy.playerPublicKey, assetDevnet, 499_501n);
  const secondExit = await prepare(signal("pilot-flat-try2", "flat", 3));
  assert.equal(secondExit.kind, "operation");
  assert.deepEqual([secondExit.operation.amountInRaw, secondExit.residueRaw], ["499500", "1"]);
  // A real retry is quoted afresh; a new price also gives it a message the reference adapter has not built before.
  quoteSell(7, "499500", 3);
  assert.equal((await execute(secondExit)).state, "SUBMITTED");
  assert.equal(await finalizeOperation(h.client, journal, secondExit.operation.operationKey, h.suite.verifyFinal), "confirmed");
  assert.equal(posted().filter(p => p === "submit-durable").length, 3);
  const spent = await journal.capacity(h.getNow);
  assert.deepEqual([spent.remainingOperations, spent.budgets[asset(2)]!.remainingRaw], [0, "0"]);
});

test("an exit carries no deadline: a slow approval still completes it", async t => {
  const { h, policy, journal, signal, prepare, execute, quoteSell } = await pilot(t, bothBudgets);
  const buy = await prepare(signal("pilot-long-pre", "long", 1));
  assert.equal(buy.kind, "operation");
  assert.equal((await execute(buy)).state, "SUBMITTED");
  assert.equal(await finalizeOperation(h.client, journal, buy.operation.operationKey, h.suite.verifyFinal), "confirmed");
  h.putToken(policy.playerPublicKey, assetDevnet, 499_500n);
  const sell = await prepare(signal("pilot-flat-slow", "flat", 2, 10_000));
  assert.equal(sell.kind, "operation");
  assert.equal(sell.operation.limits.notAfterMs, undefined);
  quoteSell(5, "499500");
  const sign = h.wallet.signTransaction;
  h.wallet.signTransaction = async (encoded: string) => { h.setNow(h.getNow() + 40_000); return sign(encoded); };
  assert.equal((await execute(sell)).state, "SUBMITTED");
});

test("the signal deadline stops an entry until its signature is journaled", async t => {
  // Expired before the call: nothing is reserved or sent.
  {
    const { h, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
    const buy = await prepare(signal("pilot-long-late", "long", 1, 10_000));
    h.setNow(h.getNow() + 10_000);
    await assert.rejects(execute(buy), /OPERATION_DEADLINE_PASSED/);
    assert.deepEqual([posted(), (await journal.capacity(h.getNow)).remainingOperations], [[], 3]);
  }
  // Expired just before the first write: closed as UNSENT, its reservation still counted.
  {
    const { h, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
    const buy = await prepare(signal("pilot-long-unsent", "long", 1, 10_000));
    const deadline = deadlineOf(buy);
    const ports = { ...h.suite.ports, assertTargetCurrent: async () => { h.setNow(deadline); await h.suite.ports.assertTargetCurrent!(); } };
    const result = await execute(buy, ports);
    assert.deepEqual([result.state, result.reason], ["UNSENT", "OPERATION_DEADLINE_PASSED"]);
    const after = await journal.capacity(h.getNow);
    assert.deepEqual([posted(), after.unresolvedOperations, after.remainingOperations], [[], 0, 2]);
  }
  // Expired inside the quote's pre-send guard: AMBIGUOUS, still reported as the deadline, and closable.
  {
    const { h, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
    const buy = await prepare(signal("pilot-long-quote", "long", 1, 10_000));
    const deadline = deadlineOf(buy);
    let checks = 0;
    const ports = { ...h.suite.ports, assertTargetCurrent: async () => { if (++checks === 2) h.setNow(deadline); await h.suite.ports.assertTargetCurrent!(); } };
    const result = await execute(buy, ports);
    assert.deepEqual([result.state, result.reason, posted()], ["AMBIGUOUS", "OPERATION_DEADLINE_PASSED", ["swap-intents"]]);
    assert.equal(buy.kind, "operation");
    await abandonOperation(journal, buy.operation.operationKey);
    assert.equal((await journal.capacity(h.getNow)).unresolvedOperations, 0);
  }
  // Expired during a 40 s wallet approval: the signed transaction is discarded, never recorded or sent.
  {
    const { h, journal, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
    const buy = await prepare(signal("pilot-long-slow", "long", 1, 10_000));
    assert.equal(buy.kind, "operation");
    const sign = h.wallet.signTransaction;
    h.wallet.signTransaction = async (encoded: string) => { h.setNow(h.getNow() + 40_000); return sign(encoded); };
    const result = await execute(buy);
    assert.deepEqual([result.state, result.reason, result.txid], ["AMBIGUOUS", "OPERATION_DEADLINE_PASSED", null]);
    assert.deepEqual(posted(), ["swap-intents", "quote"]);
    assert.equal((await journal.read(buy.operation.operationKey)).events.some(e => e.stage === "SIGNED"), false);
    // The server reported a new intention that no journal signed: it can be closed locally.
    await abandonOperation(journal, buy.operation.operationKey);
    assert.equal((await journal.capacity(h.getNow)).unresolvedOperations, 0);
  }
  // Expired after the signature was journaled: the transaction is completed, not stranded.
  {
    const { h, signal, prepare, execute, posted } = await pilot(t, bothBudgets);
    const buy = await prepare(signal("pilot-long-edge", "long", 1, 10_000));
    const deadline = deadlineOf(buy);
    let revalidations = 0;
    const ports = { ...h.suite.ports, revalidate: async (...args: Parameters<NonNullable<typeof h.suite.ports.revalidate>>) => {
      // The second revalidation guards the signature write, after the SIGNED record.
      if (++revalidations === 2) h.setNow(deadline + 1);
      return h.suite.ports.revalidate!(...args);
    } };
    const result = await execute(buy, ports);
    assert.equal(result.state, "SUBMITTED");
    assert.ok(h.getNow() > deadline);
    assert.deepEqual(posted(), ["swap-intents", "quote", "signature", "submit-durable"]);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpotSignal, prepareSpotSignal, type SpotSignalPolicy } from "../src/signals.ts";

const nowMs = 1_800_000_000_000;
const signal = { id: "demo-entry", sequence: 1, symbol: "TEST", side: "long", targetBps: 2_000, expiresAtMs: nowMs + 60_000 } as const;
const policy: SpotSignalPolicy = {
  symbol: "TEST",
  seasonId: ["00000000", "0000", "0000", "0000", "000000000001"].join("-"),
  category: "degen",
  playerPublicKey: "3".repeat(32),
  usdcMint: "4".repeat(32),
  usdcDecimals: 6,
  assetMint: "5".repeat(32),
  assetDecimals: 6,
  maxEntryBps: 2_000,
  maxPositionRaw: "100000000",
  exitAttempts: 2,
};
const holdings = { observedAtMs: nowMs, usdcRaw: "100000006", assetRaw: "0" };
const budget = (limitRaw: string, remainingRaw = limitRaw) => ({ limitRaw, remainingRaw });
const journal = {
  observedAtMs: nowMs,
  unresolvedOperations: 0,
  runningOperations: 0,
  reservedOperations: 0,
  remainingOperations: 3,
  budgets: { [policy.usdcMint]: budget("100000000"), [policy.assetMint]: budget("999999999999") },
  version: "ab".repeat(32),
};
const input = { signal, policy, holdings, journal, nowMs };
const flat = { ...signal, id: "demo-exit", sequence: 2, side: "flat", targetBps: 0 } as const;
const exit = { ...input, signal: flat };

test("signals reject unknown fields, short, fractional sizes, invalid IDs and oversized input", () => {
  assert.deepEqual(parseSpotSignal(JSON.stringify(signal)), signal);
  for (const update of [
    { tokenInMint: policy.usdcMint },
    { symbol: "TEST/USDC" },
    { side: "short" },
    { side: "flat" },
    { targetBps: 2.5 },
    { sequence: 0 },
    { id: "private payload" },
  ]) assert.throws(() => parseSpotSignal(JSON.stringify({ ...signal, ...update })));
  assert.throws(() => parseSpotSignal(JSON.stringify(signal) + " ".repeat(512)), /INVALID_SIGNAL_LINE/);
  assert.throws(() => parseSpotSignal('{"private fixture'), /^Error: INVALID_SIGNAL_JSON$/);
  assert.throws(() => parseSpotSignal('{"side":"flat",' + JSON.stringify(signal).slice(1)), /DUPLICATE_SIGNAL_FIELD/);
  assert.throws(() => parseSpotSignal('{"s\\u0069de":"flat",' + JSON.stringify(signal).slice(1)), /DUPLICATE_SIGNAL_FIELD/);
});

test("entry floors raw USDC sizing and binds operation identity to signal ID and league context", () => {
  const entry = prepareSpotSignal(input);
  assert.equal(entry.kind, "operation");
  assert.deepEqual(
    [entry.operation.tokenInMint, entry.operation.tokenOutMint, entry.operation.amountInRaw, entry.operation.amountIn],
    [policy.usdcMint, policy.assetMint, "20000001", 20.000001],
  );
  assert.deepEqual(entry.operation.limits, { notAfterMs: signal.expiresAtMs, outputDecimals: 6, journalVersion: journal.version });
  const replay = prepareSpotSignal({ ...input, signal: { ...signal, targetBps: 100 } });
  const other = prepareSpotSignal({ ...input, signal: { ...signal, id: "another-entry" } });
  assert.equal(replay.kind, "operation");
  assert.equal(other.kind, "operation");
  assert.equal(replay.operation.operationKey, entry.operation.operationKey);
  assert.notEqual(other.operation.operationKey, entry.operation.operationKey);
});

test("flat exits the entire verified holding at the asset's precision or proposes no operation", () => {
  assert.deepEqual(prepareSpotSignal(exit), { kind: "noop" });
  const plan = prepareSpotSignal({ ...exit, holdings: { ...holdings, assetRaw: "123456789" } });
  assert.equal(plan.kind, "operation");
  assert.deepEqual(
    [plan.operation.tokenInMint, plan.operation.tokenOutMint, plan.operation.amountInRaw, plan.operation.amountIn],
    [policy.assetMint, policy.usdcMint, "123456789", 123.456789],
  );
  // An exit carries no deadline: running late only reduces exposure.
  assert.deepEqual(plan.operation.limits, { outputDecimals: 6, journalVersion: journal.version });
  assert.equal(plan.residueRaw, "0");
});

test("planning fails closed on unapproved, stale, unsafe or inexact input", () => {
  assert.throws(() => prepareSpotSignal({ ...input, signal: { ...signal, symbol: "NQ" } }), /SIGNAL_PAIR_NOT_ALLOWED/);
  assert.throws(() => prepareSpotSignal({ ...input, signal: { ...signal, targetBps: 2_001 } }), /SIGNAL_ENTRY_LIMIT/);
  assert.throws(() => prepareSpotSignal({ ...input, nowMs: nowMs + 60_000 }), /SIGNAL_EXPIRY_INVALID/);
  assert.throws(() => prepareSpotSignal({ ...input, nowMs: nowMs - 1 }), /SIGNAL_EXPIRY_INVALID/);
  assert.throws(() => prepareSpotSignal({ ...input, holdings: { ...holdings, observedAtMs: nowMs - 30_001 } }), /SIGNAL_HOLDINGS_STALE/);
  assert.throws(() => prepareSpotSignal({ ...input, holdings: { ...holdings, observedAtMs: nowMs + 1 } }), /SIGNAL_HOLDINGS_STALE/);
  assert.throws(() => prepareSpotSignal({ ...input, holdings: { ...holdings, assetRaw: "1" } }), /SIGNAL_POSITION_ALREADY_OPEN/);
  assert.throws(() => prepareSpotSignal({ ...input, holdings: { ...holdings, usdcRaw: "4" } }), /SIGNAL_AMOUNT_TOO_SMALL/);
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, usdcDecimals: 9 }, holdings: { ...holdings, usdcRaw: "6" } }), /SIGNAL_AMOUNT_NOT_REPRESENTABLE/);
});

test("no signal is read against a journal with a pending operation, so a flat is never a no-op then", () => {
  const pending = { ...journal, unresolvedOperations: 1 };
  // The holding still shows no asset while the long is unresolved: this used to return noop.
  assert.throws(() => prepareSpotSignal({ ...exit, journal: pending }), /SIGNAL_OPERATION_PENDING/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: pending, holdings: { ...holdings, assetRaw: "5" } }), /SIGNAL_OPERATION_PENDING/);
  assert.throws(() => prepareSpotSignal({ ...input, journal: pending }), /SIGNAL_OPERATION_PENDING/);
  // A run that has started but not yet reserved counts as well.
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, runningOperations: 1 } }), /SIGNAL_OPERATION_PENDING/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, version: "not-a-digest" } }), /SIGNAL_JOURNAL_INVALID/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, observedAtMs: nowMs - 30_001 } }), /SIGNAL_JOURNAL_STALE/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, observedAtMs: nowMs + 1 } }), /SIGNAL_JOURNAL_STALE/);
  // Holdings read before the snapshot could predate a fill the snapshot already counts as final.
  assert.throws(() => prepareSpotSignal({ ...exit, holdings: { ...holdings, observedAtMs: nowMs - 1 } }), /SIGNAL_HOLDINGS_BEFORE_JOURNAL/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, unresolvedOperations: -1 } }), /INVALID_INTEGER/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, extra: true } as typeof journal }), /UNKNOWN_FIELD/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: { ...journal, budgets: { [policy.assetMint]: budget("5", "6") } } }), /SIGNAL_JOURNAL_INVALID/);
  assert.throws(() => prepareSpotSignal({ ...exit, journal: undefined as unknown as typeof journal }), /INVALID_OBJECT/);
});

test("an entry is refused unless the same journal can still reserve its exit", () => {
  const without = (budgets: typeof journal.budgets, remainingOperations = 3) => ({ ...input, journal: { ...journal, budgets, remainingOperations } });
  assert.throws(() => prepareSpotSignal(without({ [policy.usdcMint]: budget("100000000") })), /SIGNAL_EXIT_BUDGET_MISSING/);
  assert.throws(() => prepareSpotSignal(without({ ...journal.budgets, [policy.assetMint]: budget("500000", "0") })), /SIGNAL_EXIT_BUDGET_LOW/);
  assert.throws(() => prepareSpotSignal(without(journal.budgets, 2)), /SIGNAL_EXIT_SLOT_MISSING/);
  assert.equal(prepareSpotSignal(without(journal.budgets, 3)).kind, "operation");
  // Exits consume the asset budget for good: after one 499,500 round trip on a 1,200,000 budget, a second
  // entry of up to 499,500 no longer has room for two exit attempts.
  const sized = { ...input, policy: { ...policy, maxPositionRaw: "499500" } };
  const left = (remainingRaw: string) => ({ ...sized, journal: { ...journal, budgets: { [policy.assetMint]: budget("1200000", remainingRaw) } } });
  assert.throws(() => prepareSpotSignal(left("700500")), /SIGNAL_EXIT_BUDGET_LOW/);
  assert.throws(() => prepareSpotSignal(left("998999")), /SIGNAL_EXIT_BUDGET_LOW/);
  assert.equal(prepareSpotSignal(left("999000")).kind, "operation");
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, maxPositionRaw: "0" } }), /INVALID_RAW_AMOUNT/);
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, assetDecimals: 0, maxPositionRaw: "1000000000001" } }), /SIGNAL_POSITION_LIMIT_INVALID/);
  // By default an exit larger than the remaining budget is refused, so the operator can deal with the excess first.
  const held = { ...holdings, assetRaw: "500001" };
  const short = { ...journal, budgets: { [policy.assetMint]: budget("900000", "500000") } };
  assert.throws(() => prepareSpotSignal({ ...exit, holdings: held, journal: short }), /SIGNAL_EXIT_OVER_BUDGET/);
  assert.throws(() => prepareSpotSignal({ ...exit, policy: { ...policy, allowPartialExit: "yes" as never }, holdings: held, journal: short }), /SIGNAL_POLICY_INVALID/);
  // The flag and the policy's fields are checked on every signal, so an entry cannot run with a policy its exit would refuse.
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, allowPartialExit: "yes" as never } }), /SIGNAL_POLICY_INVALID/);
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, allowPartialExits: true } as never }), /UNKNOWN_FIELD/);
  for (const plan of [input, { ...exit, holdings: held }]) {
    assert.throws(() => prepareSpotSignal({ ...plan, policy: { ...policy, allowPartialExit: null as never } }), /SIGNAL_POLICY_INVALID/);
  }
  // The entry limit is an entry setting: with entries turned off, an exit still goes through.
  assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, maxEntryBps: 0 } }), /INVALID_INTEGER/);
  assert.equal(prepareSpotSignal({ ...exit, policy: { ...policy, maxEntryBps: 0 }, holdings: { ...holdings, assetRaw: "500000" } }).kind, "operation");
  // With partial exits allowed, it sells what the budget allows and reports the rest.
  const capped = prepareSpotSignal({ ...exit, policy: { ...policy, allowPartialExit: true }, holdings: held, journal: short });
  assert.equal(capped.kind, "operation");
  assert.deepEqual([capped.operation.amountInRaw, capped.residueRaw], ["500000", "1"]);
  // A spent budget refuses any exit, partial or not.
  const spent = { ...journal, budgets: { [policy.assetMint]: budget("900000", "0") } };
  assert.throws(() => prepareSpotSignal({ ...exit, policy: { ...policy, allowPartialExit: true }, holdings: held, journal: spent }), /SIGNAL_EXIT_OVER_BUDGET/);
  // With no budget left at all, the exit is refused before any reservation.
  assert.throws(() => prepareSpotSignal({ ...exit, holdings: held, journal: { ...journal, budgets: {} } }), /SIGNAL_EXIT_OVER_BUDGET/);
  assert.throws(() => prepareSpotSignal({ ...exit, holdings: held, journal: { ...journal, remainingOperations: 0 } }), /SIGNAL_EXIT_SLOT_MISSING/);
  assert.equal(prepareSpotSignal({ ...exit, holdings: held, journal: { ...journal, remainingOperations: 1 } }).kind, "operation");
});

test("an entry keeps one slot and one position limit of asset budget per exit attempt", () => {
  // A failed, abandoned or unsent exit keeps its reservation, so a retried flat needs its own room.
  const twice = { ...input, policy: { ...policy, maxPositionRaw: "499500", exitAttempts: 2 } };
  const room = (remainingOperations: number, remainingRaw: string) => ({ ...twice, journal: { ...journal, remainingOperations, budgets: { [policy.assetMint]: budget("999000", remainingRaw) } } });
  assert.equal(prepareSpotSignal(room(3, "999000")).kind, "operation");
  assert.throws(() => prepareSpotSignal(room(2, "999000")), /SIGNAL_EXIT_SLOT_MISSING/);
  assert.throws(() => prepareSpotSignal(room(3, "998999")), /SIGNAL_EXIT_BUDGET_LOW/);
  // One attempt is refused: a single failed exit would strand the position.
  for (const exitAttempts of [0, 1, 11, 1.5]) {
    assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, exitAttempts } }), /INVALID_INTEGER/);
  }
  // Entry-only settings never block an exit: a flat ignores them.
  const loose = { ...policy, assetDecimals: 9, maxPositionRaw: "0", exitAttempts: 0 };
  const sold = prepareSpotSignal({ ...exit, policy: loose, holdings: { ...holdings, assetRaw: "1234567891" } });
  assert.equal(sold.kind, "operation");
  assert.equal(sold.operation.amountIn, 1.234567891);
  // The plan carries the snapshot's version, which the reservation must still find.
  const bound = prepareSpotSignal({ ...input, journal: { ...journal, version: "cd".repeat(32) } });
  assert.equal(bound.kind, "operation");
  assert.equal(bound.operation.limits.journalVersion, "cd".repeat(32));
});

test("every exit the journal can admit is exactly representable as the API's JSON number", () => {
  // Finer assets are refused at entry: they could hold dust below 1e-6 units, which prints in exponent form.
  for (const assetDecimals of [7, 8, 9]) {
    assert.throws(() => prepareSpotSignal({ ...input, policy: { ...policy, assetDecimals } }), /SIGNAL_DECIMALS_UNSUPPORTED/);
    // An exit is still attempted, and dust is refused explicitly rather than mis-sized.
    assert.throws(() => prepareSpotSignal({ ...exit, policy: { ...policy, assetDecimals }, holdings: { ...holdings, assetRaw: "9" } }), /SIGNAL_AMOUNT_NOT_REPRESENTABLE/);
  }
  let seed = 0x2545f491;
  const next = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0);
  for (let assetDecimals = 0; assetDecimals <= 6; assetDecimals++) {
    const units = 10n ** BigInt(12 + assetDecimals), cap = units < 999_999_999_999_999n ? units : 999_999_999_999_999n;
    const at = (limit: bigint) => ({ ...journal, budgets: { [policy.assetMint]: budget(limit.toString()) } });
    const decimals = { ...policy, assetDecimals };
    // The cap is the largest exit budget an entry accepts.
    assert.equal(prepareSpotSignal({ ...input, policy: decimals, journal: at(cap) }).kind, "operation");
    assert.throws(() => prepareSpotSignal({ ...input, policy: decimals, journal: at(cap + 1n) }), /SIGNAL_EXIT_BUDGET_TOO_LARGE/);
    const samples = new Set<bigint>([1n, 9n, 10n, 99n, 101n, cap, cap - 1n, 10n ** BigInt(assetDecimals), 10n ** BigInt(assetDecimals) + 1n]);
    for (let digits = 1; digits <= 15; digits++) samples.add(10n ** BigInt(digits) - 1n);
    while (samples.size < 2_000) {
      let raw = 0n;
      for (let digits = 1 + next() % 15; digits > 0; digits--) raw = raw * 10n + BigInt(next() % 10);
      samples.add(raw);
    }
    for (const raw of samples) {
      if (raw < 1n || raw > cap) continue;
      const plan = prepareSpotSignal({ ...exit, policy: decimals, journal: at(cap), holdings: { ...holdings, assetRaw: raw.toString() } });
      assert.equal(plan.kind, "operation");
      // The same unit check the operation runner applies before any request.
      const text = String(plan.operation.amountIn), [whole, fraction = ""] = text.split(".");
      assert.match(text, /^[0-9]+(?:[.][0-9]+)?$/, raw.toString());
      assert.ok(fraction.length <= assetDecimals && BigInt(whole! + fraction.padEnd(assetDecimals, "0")) === raw, raw.toString());
    }
  }
});

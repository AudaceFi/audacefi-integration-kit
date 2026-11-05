import { digest } from "./canonical.ts";
import { mint, rawAmount, uuid } from "./client.ts";
import { category, closed, integer, record, type Category } from "./contract.ts";
import type { FileJournal, JournalCapacity } from "./journal.ts";
import type { Operation } from "./operation.ts";

export interface SpotSignal {
  id: string;
  sequence: number;
  symbol: string;
  side: "long" | "flat";
  targetBps: number;
  expiresAtMs: number;
}

/** Operator configuration for one approved spot pair. Mints are the API's canonical mints. */
export interface SpotSignalPolicy {
  symbol: string;
  seasonId: string;
  category: Category;
  playerPublicKey: string;
  usdcMint: string;
  usdcDecimals: number;
  assetMint: string;
  assetDecimals: number;
  maxEntryBps: number;
  /** Largest raw asset amount one entry may acquire: the largest entry `maxEntryBps` allows, at the lowest accepted price. */
  maxPositionRaw: string;
  /**
   * Exit attempts an entry must leave room for, 2 to 10. A failed, abandoned or unsent exit keeps its operation slot
   * and asset reservation, so each attempt needs one slot and `maxPositionRaw` of asset budget.
   */
  exitAttempts: number;
  /**
   * When true, an exit larger than the remaining asset budget sells what the budget allows and reports the rest as
   * `residueRaw`. Off by default: such an exit is refused, so the operator can deal with the excess first.
   */
  allowPartialExit?: boolean;
}

/** Raw balances obtained by the operator for its dedicated pilot wallet. */
export interface SpotSignalHoldings {
  observedAtMs: number;
  usdcRaw: string;
  assetRaw: string;
}

/**
 * Carried inside the plan's operation, so `runTradingBot` and `runAiAgent` apply them. `notAfterMs`, on entries only,
 * is the signal's expiry: a late exit only reduces exposure. `outputDecimals` is the policy's decimals for the token
 * received, checked against the verified mapping. `journalVersion` is the version the plan was bound to, which the reservation
 * must still find.
 */
export interface SpotSignalLimits { notAfterMs?: number; outputDecimals: number; journalVersion: string }
/**
 * `residueRaw`, on exits with `allowPartialExit` only, is the asset left in the wallet because the journal's remaining
 * asset budget could not cover the whole holding, for example after a fill above `maxPositionRaw` or a transfer from
 * someone else. "0" otherwise.
 */
export type SpotSignalPlan =
  | { kind: "operation"; operation: Omit<Operation, "actor"> & { limits: SpotSignalLimits }; residueRaw: string }
  | { kind: "noop" };

const maxTimestampMs = 8_000_000_000_000;
const maxSignalBytes = 512;
const signalFields = ["id", "sequence", "symbol", "side", "targetBps", "expiresAtMs"];
const policyFields = [
  "symbol", "seasonId", "category", "playerPublicKey", "usdcMint", "usdcDecimals", "assetMint", "assetDecimals",
  "maxEntryBps", "maxPositionRaw", "exitAttempts", "allowPartialExit",
];
// The API carries amountIn as a JSON number. Below 1e-6 a number prints in exponent form, so finer
// assets could hold dust that no exit can express.
const maxAssetDecimals = 6;

/** Largest raw exit whose decimal form survives a double: at most 15 significant digits and 1e12 units. */
function exitCap(decimals: number): bigint {
  const units = 10n ** BigInt(12 + decimals);
  return units < 999_999_999_999_999n ? units : 999_999_999_999_999n;
}
function rawOrZero(value: unknown): bigint {
  return value === "0" ? 0n : BigInt(rawAmount(value));
}

function validateSignal(value: unknown): SpotSignal {
  const { id, sequence, symbol, side, targetBps, expiresAtMs } = closed(value, signalFields);
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("INVALID_SIGNAL_ID");
  if (typeof symbol !== "string" || !/^[A-Z0-9_-]{1,16}$/.test(symbol)) throw new Error("INVALID_SIGNAL_SYMBOL");
  if (side !== "long" && side !== "flat") throw new Error("INVALID_SIGNAL_SIDE");
  return {
    id,
    sequence: integer(sequence, 1),
    symbol,
    side,
    targetBps: side === "flat" ? integer(targetBps, 0, 0) : integer(targetBps, 1, 10_000),
    expiresAtMs: integer(expiresAtMs, 1, maxTimestampMs),
  };
}

/** Parse one UTF-8 JSON line from an external bot or agent. */
export function parseSpotSignal(line: string): SpotSignal {
  if (Buffer.byteLength(line, "utf8") > maxSignalBytes || /[\r\n]/.test(line)) throw new Error("INVALID_SIGNAL_LINE");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("INVALID_SIGNAL_JSON");
  }
  const signal = validateSignal(value);
  // In a flat JSON object, only key tokens are followed by a colon.
  const tokens = [...line.matchAll(/"(?:\\.|[^"\\])*"/g)];
  const keys = tokens.filter(token => line.slice(token.index + token[0].length).trimStart().startsWith(":"));
  if (keys.length !== signalFields.length) throw new Error("DUPLICATE_SIGNAL_FIELD");
  return signal;
}

/**
 * Whether the signal concerns this policy's pair at all: well formed, within its expiry window and for the pair. A signal
 * refused here states no intent for the pair, so the helper refuses it before superseding anything. Any later refusal, such
 * as the entry limit or an invalid policy, comes from a signal that still states the latest intent.
 */
function relevant(signal: unknown, policy: SpotSignalPolicy, nowMs: number) {
  const proposal = validateSignal(signal);
  const now = integer(nowMs, 1, maxTimestampMs);
  if (proposal.expiresAtMs <= now || proposal.expiresAtMs - now > 60_000) throw new Error("SIGNAL_EXPIRY_INVALID");
  if (proposal.symbol !== record(policy).symbol) throw new Error("SIGNAL_PAIR_NOT_ALLOWED");
  return { proposal, now };
}

/** Every check that needs neither the journal nor the holdings: `relevant`, then the policy. */
function admit(signal: unknown, policy: SpotSignalPolicy, nowMs: number) {
  const { proposal, now } = relevant(signal, policy, nowMs);
  closed(policy, policyFields);
  const seasonId = uuid(policy.seasonId);
  const leagueCategory = category(policy.category);
  const playerPublicKey = mint(policy.playerPublicKey);
  const usdcMint = mint(policy.usdcMint);
  const assetMint = mint(policy.assetMint);
  const usdcDecimals = integer(policy.usdcDecimals, 0, 9);
  const assetDecimals = integer(policy.assetDecimals, 0, 9);
  if (assetMint === usdcMint) throw new Error("SIGNAL_PAIR_INVALID");
  // Checked on every signal, so a wrong value is found before an entry, not when the position must be exited.
  const partial = policy.allowPartialExit === undefined ? false : policy.allowPartialExit;
  if (typeof partial !== "boolean") throw new Error("SIGNAL_POLICY_INVALID");
  const entering = proposal.side === "long";
  let maxPosition = 0n, attempts = 0;
  if (entering) {
    // Entry-only limits: an exit is never refused for a reason that only matters when opening a position.
    if (proposal.targetBps > integer(policy.maxEntryBps, 1, 10_000)) throw new Error("SIGNAL_ENTRY_LIMIT");
    if (assetDecimals > maxAssetDecimals) throw new Error("SIGNAL_DECIMALS_UNSUPPORTED");
    maxPosition = BigInt(rawAmount(policy.maxPositionRaw));
    if (maxPosition > exitCap(assetDecimals)) throw new Error("SIGNAL_POSITION_LIMIT_INVALID");
    // With one attempt, a single failed or abandoned exit would leave the position unable to exit from this journal.
    attempts = integer(policy.exitAttempts, 2, 10);
  }
  return { proposal, now, entering, partial, maxPosition, attempts, seasonId, leagueCategory, playerPublicKey, usdcMint, assetMint, usdcDecimals, assetDecimals };
}

/**
 * The pure step under `prepareSpotSignalFromJournal`, internal to the kit: a plan prepared here supersedes nothing.
 * `journal` comes from `capacity()` on the journal that will run the operation, taken before `holdings` are observed.
 */
export function prepareSpotSignal({ signal, policy, holdings, journal, nowMs }: {
  signal: SpotSignal;
  policy: SpotSignalPolicy;
  holdings: SpotSignalHoldings;
  journal: JournalCapacity;
  nowMs: number;
}): SpotSignalPlan {
  const {
    proposal, now, entering, partial, maxPosition, attempts, seasonId, leagueCategory, playerPublicKey, usdcMint, assetMint, usdcDecimals, assetDecimals,
  } = admit(signal, policy, nowMs);

  const capacity = closed(journal, ["observedAtMs", "unresolvedOperations", "runningOperations", "reservedOperations", "remainingOperations", "budgets", "version"]);
  const journalAt = integer(capacity.observedAtMs, 1, maxTimestampMs);
  if (journalAt > now || now - journalAt > 30_000) throw new Error("SIGNAL_JOURNAL_STALE");
  // A pending or running operation can still move holdings: no signal, and above all no flat, may be read as a no-op now.
  const unresolved = integer(capacity.unresolvedOperations, 0, 10_000), running = integer(capacity.runningOperations, 0, 10_000);
  if (unresolved !== 0 || running !== 0) throw new Error("SIGNAL_OPERATION_PENDING");
  integer(capacity.reservedOperations, 0, 10_000);
  const journalVersion = capacity.version;
  if (typeof journalVersion !== "string" || !/^[0-9a-f]{64}$/.test(journalVersion)) throw new Error("SIGNAL_JOURNAL_INVALID");
  const freeSlots = integer(capacity.remainingOperations, 0, 10_000);
  const exitBudget = record(capacity.budgets)[assetMint];
  const exitLimit = exitBudget === undefined ? 0n : rawOrZero(record(exitBudget).limitRaw);
  const exitLeft = exitBudget === undefined ? 0n : rawOrZero(record(exitBudget).remainingRaw);
  if (exitLeft > exitLimit) throw new Error("SIGNAL_JOURNAL_INVALID");

  const observed = integer(holdings.observedAtMs, 1, maxTimestampMs);
  if (observed > now || now - observed > 30_000) throw new Error("SIGNAL_HOLDINGS_STALE");
  // Holdings read before the snapshot could predate a fill the snapshot already counts as final.
  if (observed < journalAt) throw new Error("SIGNAL_HOLDINGS_BEFORE_JOURNAL");
  const usdcRaw = rawOrZero(holdings.usdcRaw);
  const assetRaw = rawOrZero(holdings.assetRaw);
  if (entering && assetRaw !== 0n) throw new Error("SIGNAL_POSITION_ALREADY_OPEN");
  if (!entering && assetRaw === 0n) return { kind: "noop" };
  // The flat reserves what it sells from the same journal, and a reservation is never refunded.
  if (entering) {
    if (freeSlots < 1 + attempts) throw new Error("SIGNAL_EXIT_SLOT_MISSING");
    if (exitBudget === undefined) throw new Error("SIGNAL_EXIT_BUDGET_MISSING");
    if (exitLimit > exitCap(assetDecimals)) throw new Error("SIGNAL_EXIT_BUDGET_TOO_LARGE");
    if (exitLeft < BigInt(attempts) * maxPosition) throw new Error("SIGNAL_EXIT_BUDGET_LOW");
  } else {
    // Name an exit the journal would refuse instead of failing at reservation.
    if (freeSlots < 1) throw new Error("SIGNAL_EXIT_SLOT_MISSING");
    // A partial exit uses up the remaining budget, so it is the operator's explicit choice.
    if (exitLeft === 0n || (assetRaw > exitLeft && !partial)) throw new Error("SIGNAL_EXIT_OVER_BUDGET");
  }

  // With `allowPartialExit`, an exit sells what the remaining budget allows and reports the rest as residue.
  const raw = entering ? usdcRaw * BigInt(proposal.targetBps) / 10_000n : assetRaw > exitLeft ? exitLeft : assetRaw;
  if (raw === 0n) throw new Error("SIGNAL_AMOUNT_TOO_SMALL");
  const amountInRaw = raw.toString();
  const inputDecimals = entering ? usdcDecimals : assetDecimals;
  const digits = amountInRaw.padStart(inputDecimals + 1, "0");
  const integerPart = digits.slice(0, digits.length - inputDecimals);
  const fraction = digits.slice(integerPart.length).replace(/0+$/, "");
  const decimal = fraction ? integerPart + "." + fraction : integerPart;
  const amountIn = Number(decimal);
  if (amountIn > 1e12 || String(amountIn) !== decimal) throw new Error("SIGNAL_AMOUNT_NOT_REPRESENTABLE");

  return {
    kind: "operation",
    operation: {
      operationKey: digest({
        kind: "spot-signal-v1", seasonId, category: leagueCategory, playerPublicKey, signalId: proposal.id,
      }),
      seasonId,
      category: leagueCategory,
      playerPublicKey,
      tokenInMint: entering ? usdcMint : assetMint,
      tokenOutMint: entering ? assetMint : usdcMint,
      amountIn,
      amountInRaw,
      inputDecimals,
      limits: entering
        ? { notAfterMs: proposal.expiresAtMs, outputDecimals: assetDecimals, journalVersion }
        : { outputDecimals: usdcDecimals, journalVersion },
    },
    residueRaw: entering ? "0" : (assetRaw - raw).toString(),
  };
}

/**
 * A signal that states no intent for the pair supersedes nothing. Once relevant, it supersedes earlier plans for this
 * journal before any journal or holdings read, even if a read later fails. The claim must still match both snapshots.
 * A plan or `noop` also requires unchanged reservations, resolutions and run counts across the holdings read.
 * Runs elsewhere (another thread, process or copy of the kit) stay the caller's to serialize.
 */
export async function prepareSpotSignalFromJournal({ signal, policy, journal, readHoldings, clock = Date.now }: {
  signal: SpotSignal;
  policy: SpotSignalPolicy;
  journal: Pick<FileJournal, "capacity" | "claimPlanVersion" | "matchesPlanVersion">;
  readHoldings: () => Promise<SpotSignalHoldings>;
  clock?: () => number;
}): Promise<SpotSignalPlan> {
  const policySnapshot = { ...policy };
  const { proposal } = relevant(signal, policySnapshot, clock());
  const claim = journal.claimPlanVersion();
  const before = await journal.capacity(clock);
  if (!journal.matchesPlanVersion(before, claim)) throw new Error("SIGNAL_JOURNAL_CHANGED");
  if (before.unresolvedOperations !== 0 || before.runningOperations !== 0) throw new Error("SIGNAL_OPERATION_PENDING");
  const holdings = { ...await readHoldings() };
  const after = await journal.capacity(clock);
  const now = clock();
  if (!journal.matchesPlanVersion(after, claim) || after.version !== before.version || after.unresolvedOperations !== 0 || after.runningOperations !== 0) throw new Error("SIGNAL_JOURNAL_CHANGED");
  if (integer(holdings?.observedAtMs, 1, maxTimestampMs) > after.observedAtMs) throw new Error("SIGNAL_HOLDINGS_AFTER_JOURNAL");
  return prepareSpotSignal({ signal: proposal, policy: policySnapshot, holdings, journal: before, nowMs: now });
}

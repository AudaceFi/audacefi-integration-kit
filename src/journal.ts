import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { digest } from "./canonical.ts";
import { closed, integer, record } from "./contract.ts";
import { mint, rawAmount, uuid, type OfficialProxyIdentity } from "./client.ts";
import type { Operation, SignedRecovery } from "./operation.ts";

export interface JournalPolicy { maxOperations: number; inputBudgets: Record<string, string> }
/** What new reservations could still use when the snapshot was taken. Raw amounts; reservations are never released. */
export interface JournalCapacity {
  observedAtMs: number;
  unresolvedOperations: number;
  /** `runOperation` calls on this journal directory in this loaded copy of the module that have started and not returned, reserved or not. */
  runningOperations: number;
  /** Reservations ever made. Reservations are never removed, so any new one changes this count. */
  reservedOperations: number;
  remainingOperations: number;
  budgets: Record<string, { limitRaw: string; remainingRaw: string }>;
  /** Digest of the journal directory, its policy, `reservedOperations` and a random plan marker (`claimPlanVersion`): `reserve()` can refuse once it changed. */
  version: string;
}
export type OperationRecord = {
  keyHash: string; payloadHash: string; tokenInMint: string; amountInRaw: string; origin: string;
} & ({ version: 1; apiBasePath?: never } | ({ version: 2; apiBasePath: "/api" } & OfficialProxyIdentity));
export interface JournalEvent {
  stage: "INTENT" | "QUOTED" | "SIGNED" | "SIGNATURE_POSTING" | "SENDING" | "SEND_REFUSED" | "AMBIGUOUS" | "RECORDED" | "SUBMITTED" | "FINAL_CONFIRMED" | "FINAL_FAILED" | "ABANDONED" | "UNSENT" | "EXPIRED_UNSENT";
  intentId?: string;
  quoteId?: string;
  quoteOutId?: string;
  messageHash?: string;
  playerSignature?: string;
  playerPublicKey?: string;
  transactionHash?: string;
  txid?: string;
  genesisHash?: string;
  replayed?: boolean;
  exactInputBound?: true;
}
const eventKeys=["stage","intentId","quoteId","quoteOutId","messageHash","playerSignature","playerPublicKey","transactionHash","txid","genesisHash","replayed","exactInputBound"];
const maxEvents = 16;
const maxRankedEvents = 64;
function validateEvents(values:unknown[], recoverable: boolean):JournalEvent[] {
  const result:JournalEvent[]=[];
  let intent:string|undefined,quote:string|undefined,quoteOut:string|undefined,signed:JournalEvent|undefined,sending=false,intentSeen=false,replayed:boolean|undefined,exactInputBound=false;
  const fields:Record<JournalEvent["stage"],string[]>={
    INTENT:["stage","intentId","replayed","exactInputBound"],QUOTED:["stage","intentId","quoteId","quoteOutId"],
    SIGNED:["stage","intentId","quoteId","quoteOutId","messageHash","playerSignature","playerPublicKey","transactionHash","genesisHash"],
    SIGNATURE_POSTING:["stage","intentId"],SENDING:["stage","intentId"],SEND_REFUSED:["stage","intentId"],AMBIGUOUS:["stage","intentId","txid"],RECORDED:["stage","intentId","txid"],SUBMITTED:["stage","intentId","txid"],
    FINAL_CONFIRMED:["stage","intentId","txid"],FINAL_FAILED:["stage","intentId","txid"],ABANDONED:["stage","intentId"],UNSENT:["stage"],EXPIRED_UNSENT:["stage","intentId","txid"],
  };
  for(const raw of values) {
    const stage=record(raw).stage as JournalEvent["stage"];
    if(!Object.hasOwn(fields,stage))throw new Error("CORRUPT_JOURNAL_EVENT");
    const e=closed(raw,fields[stage]);
    const previous=result.at(-1)?.stage;
    if((previous?.startsWith("FINAL_") || previous==="ABANDONED" || previous==="UNSENT" || previous==="EXPIRED_UNSENT") && stage!==previous)throw new Error("TERMINAL_JOURNAL_CONFLICT");
    if(e.intentId!==undefined) { uuid(e.intentId);if(intent && e.intentId!==intent)throw new Error("JOURNAL_INTENT_MISMATCH"); }
    if(stage!=="AMBIGUOUS" && stage!=="ABANDONED" && stage!=="UNSENT" && e.intentId===undefined)throw new Error("JOURNAL_INTENT_REQUIRED");
    // UNSENT records that the first write was refused before transmission: no server state exists.
    if(stage==="UNSENT" && previous!==undefined)throw new Error("INVALID_JOURNAL_ORDER");
    // Only a server-new intent or a built replay proven to match the retained input can be abandoned.
    if(stage==="ABANDONED") {
      if(signed)throw new Error("SIGNED_OPERATION_RECONCILE");
      if(!intentSeen)throw new Error("INTENT_UNKNOWN_MANUAL_RECONCILIATION");
      if(replayed && !exactInputBound)throw new Error("REPLAYED_OPERATION_RECONCILE");
      if(replayed===undefined)throw new Error("INTENT_REPLAY_STATUS_UNKNOWN");
    }
    if(stage==="INTENT") {
      if(previous!==undefined && (previous!=="AMBIGUOUS" || intent || intentSeen || result.length!==1))throw new Error("INVALID_JOURNAL_ORDER");intent=e.intentId as string;
      if(e.replayed!==undefined && typeof e.replayed!=="boolean")throw new Error("CORRUPT_JOURNAL_EVENT");
      if(e.exactInputBound!==undefined && (e.exactInputBound!==true || e.replayed!==true || !recoverable))throw new Error("INVALID_JOURNAL_RECOVERY");
      exactInputBound=e.exactInputBound===true;
      intentSeen=true;replayed=e.replayed as boolean|undefined;
    } else if(stage==="QUOTED") {
      if(previous!=="INTENT")throw new Error("INVALID_JOURNAL_ORDER");
      quote=uuid(e.quoteId);quoteOut=e.quoteOutId===undefined?undefined:uuid(e.quoteOutId);
      if(quote===quoteOut)throw new Error("JOURNAL_QUOTE_MISMATCH");
    } else if(stage==="SIGNED") {
      if(previous!=="QUOTED" || e.quoteId!==quote || e.quoteOutId!==quoteOut)throw new Error("JOURNAL_QUOTE_MISMATCH");
      for(const key of ["messageHash","transactionHash"]){if(typeof e[key]!=="string" || !/^[0-9a-f]{64}$/.test(e[key] as string))throw new Error("JOURNAL_HASH_REQUIRED");}
      mint(e.playerPublicKey);
      if(typeof e.playerSignature!=="string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(e.playerSignature) || typeof e.genesisHash!=="string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(e.genesisHash))throw new Error("JOURNAL_SIGNATURE_REQUIRED");
      signed=e as unknown as JournalEvent;
    } else if(stage==="SIGNATURE_POSTING") {
      if(previous!=="SIGNED" || !signed)throw new Error("INVALID_JOURNAL_ORDER");
    } else if(stage==="SENDING") {
      if((previous!=="SIGNED" && previous!=="SIGNATURE_POSTING" && previous!=="SEND_REFUSED") || !signed)throw new Error("INVALID_JOURNAL_ORDER");sending=true;
    } else if(stage==="SEND_REFUSED") {
      if(previous!=="SENDING" || !signed)throw new Error("INVALID_JOURNAL_ORDER");sending=false;
    } else if(stage==="EXPIRED_UNSENT") {
      if(sending || !signed || (previous!=="SIGNED" && previous!=="SIGNATURE_POSTING" && previous!=="SEND_REFUSED") ||
          e.txid!==signed.playerSignature)throw new Error("INVALID_JOURNAL_ORDER");
    } else if(stage==="SUBMITTED" || stage==="RECORDED" || stage.startsWith("FINAL_")) {
      if(!signed || !sending || !intent || e.intentId!==intent || e.txid!==signed.playerSignature)throw new Error("JOURNAL_FINAL_BINDING_REQUIRED");
      if((stage==="SUBMITTED" || stage==="RECORDED") && previous!=="SENDING")throw new Error("INVALID_JOURNAL_ORDER");
      if(stage.startsWith("FINAL_") && previous!=="SUBMITTED" && previous!=="RECORDED" && previous!=="AMBIGUOUS" && previous!==stage)throw new Error("INVALID_JOURNAL_ORDER");
    } else {
      if(e.txid!==undefined && (!signed || e.txid!==signed.playerSignature))throw new Error("JOURNAL_TXID_MISMATCH");
      if(!intent && e.intentId!==undefined)intent=e.intentId as string;
    }
    result.push(e as unknown as JournalEvent);
  }
  return result;
}
async function regular(path: string, max = 65536): Promise<void> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) throw new Error("UNSAFE_JOURNAL_FILE");
}
/** POSIX: group/other access or a foreign owner would let others edit budgets and blocks. Windows ignores these modes; rely on a user-only ACL. */
export function unsafeJournalOwnership(info: { mode: number; uid: number }, platform: string, uid: number | undefined): boolean {
  return platform !== "win32" && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid));
}
async function syncWrite(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
/** Append-only reservations: amounts are never released automatically, even after uncertainty. */
export class FileJournal {
  // Keyed by the resolved directory, so every instance on one directory shares them. They live in this loaded copy of
  // the module only: another thread, process or installed copy of the kit has its own.
  static #running = new Map<string, number>();
  // A random marker per directory, replaced at each claim: no version made before a restart or claim can recur.
  static #epochs = new Map<string, string>();
  #directory: string;
  #policy: JournalPolicy;
  private constructor(directory: string, policy: JournalPolicy) { this.#directory = directory; this.#policy = policy; }
  /** Used by `runOperation`: counts the run from its first step to its end, so `capacity()` sees it before it reserves. */
  async trackRun<T>(task: () => Promise<T>): Promise<T> {
    const running = FileJournal.#running, directory = this.#directory;
    running.set(directory, (running.get(directory) ?? 0) + 1);
    try { return await task(); }
    finally {
      const left = (running.get(directory) ?? 1) - 1;
      if (left > 0) running.set(directory, left); else running.delete(directory);
    }
  }
  #epoch(): string {
    let epoch = FileJournal.#epochs.get(this.#directory);
    if (epoch === undefined) { epoch = randomBytes(16).toString("hex"); FileJournal.#epochs.set(this.#directory, epoch); }
    return epoch;
  }
  #version(reservations: number, epoch = this.#epoch()): string {
    return digest({ directory: this.#directory, policy: this.#policy, reservations, epoch });
  }
  /** Invalidates earlier plans synchronously, even if the caller cannot take a snapshot. Returns an opaque claim. */
  claimPlanVersion(): string {
    const next = randomBytes(16).toString("hex");
    FileJournal.#epochs.set(this.#directory, next);
    return next;
  }
  /** Checks that a snapshot belongs to this journal and the caller's still-current claim. */
  matchesPlanVersion(snapshot: JournalCapacity, claim: string): boolean {
    const reservations = integer(record(snapshot).reservedOperations, 0, 10000);
    return claim === this.#epoch() && snapshot.version === this.#version(reservations, claim);
  }
  static async create(directory: string, input: JournalPolicy): Promise<FileJournal> {
    if (!isAbsolute(directory)) throw new Error("ABSOLUTE_JOURNAL_DIRECTORY_REQUIRED");
    directory = resolve(directory);
    // Refuse linked ancestors; this is not a sandbox against concurrent hostile filesystem edits.
    for (let p = dirname(directory); ; p = dirname(p)) {
      const s = await lstat(p);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("LINKED_JOURNAL_ANCESTOR");
      if (p === dirname(p)) break;
    }
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("UNSAFE_JOURNAL_DIRECTORY");
    if (unsafeJournalOwnership(info, process.platform, process.geteuid?.())) throw new Error("UNSAFE_JOURNAL_PERMISSIONS");
    const inputBudgets: Record<string, string> = {};
    const pairs = Object.entries(record(input.inputBudgets));
    if (pairs.length < 1 || pairs.length > 32) throw new Error("INVALID_BUDGET_POLICY");
    for (const [asset, amount] of pairs) inputBudgets[mint(asset)] = rawAmount(amount);
    const policy = { maxOperations: integer(input.maxOperations, 1, 10000), inputBudgets };
    const file = join(directory, "policy.json");
    try { await syncWrite(file, JSON.stringify(policy) + "\n"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await regular(file);
    if (digest(JSON.parse(await readFile(file, "utf8"))) !== digest(policy)) throw new Error("JOURNAL_POLICY_CHANGED");
    return new FileJournal(directory, policy);
  }
  async rankedRunScope(inboxScope: string): Promise<string> {
    return this.withRankedSignalLock(async () => {
      const path = join(this.#directory, "ranked-run-id");
      try { await syncWrite(path, randomBytes(32).toString("hex") + "\n"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return this.#readRankedRunScope(inboxScope);
    });
  }
  async assertRankedRunScope(inboxScope: string, expected: string): Promise<void> {
    if (await this.#readRankedRunScope(inboxScope) !== expected) throw new Error("RANKED_RUN_SCOPE_CHANGED");
  }
  async #readRankedRunScope(inboxScope: string): Promise<string> {
    const path = join(this.#directory, "ranked-run-id");
    await regular(path, 65);
    const runId = await readFile(path, "utf8");
    if (!/^[a-f0-9]{64}\n$/.test(runId)) throw new Error("INVALID_RANKED_RUN_ID");
    return digest({ kind: "ranked-run-v2", runId, inboxScope, directory: this.#directory, policy: this.#policy });
  }
  #hash(key: string): string {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error("INVALID_OPERATION_KEY");
    return digest({ key });
  }
  /** `expectedVersion`, a `capacity()` snapshot's `version`, refuses the reservation on another journal or once any other was made since. */
  async reserve(key: string, payloadHash: string, tokenInMint: string, amountInRaw: string, origin: string, expectedVersion?: string, officialProxy?: Readonly<OfficialProxyIdentity>, recoveryOperation?: Readonly<Operation>): Promise<void> {
    if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(expectedVersion))) throw new Error("INVALID_JOURNAL_VERSION");
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error("INVALID_PAYLOAD_HASH");
    const url = new URL(origin);
    if (url.origin!==origin || url.protocol!=="https:" || url.username || url.password) throw new Error("INVALID_ORIGIN");
    const scope = officialProxy === undefined ? { version: 1 as const } :
      { version: 2 as const, apiBasePath: "/api" as const, accountId: uuid(officialProxy.accountId), actor: officialProxy.actor };
    if (scope.version === 2 && scope.actor !== "trading_bot" && scope.actor !== "ai_agent") throw new Error("INVALID_JOURNAL_PROXY_IDENTITY");
    const keyHash = this.#hash(key), asset = mint(tokenInMint), amount = rawAmount(amountInRaw);
    // A crash may leave this lock. Never break it automatically; reconcile the previous process first.
    await this.#exclusive("reservation.lock", "RESERVATION_LOCK_HELD", async () => {
      const scan = await this.#scan();
      if (scan.files.includes(keyHash + ".json")) {
        const old = await this.read(key);
        throw new Error(old.reservation.payloadHash === payloadHash ? "OPERATION_ALREADY_RESERVED_RECONCILE" : "IDEMPOTENCY_PAYLOAD_CONFLICT");
      }
      // One unresolved operation blocks a fresh key as well as a retry.
      if (scan.unresolved > 0) throw new Error("UNRESOLVED_OPERATION_RECONCILE");
      // A plan checked against another journal or an older snapshot may no longer fit: its slots and budgets differ.
      if (expectedVersion !== undefined && this.#version(scan.files.length) !== expectedVersion) throw new Error("JOURNAL_CHANGED_SINCE_SNAPSHOT");
      const max = this.#policy.inputBudgets[asset];
      if (!max || scan.files.length >= this.#policy.maxOperations || (scan.reserved.get(asset) ?? 0n) + BigInt(amount) > BigInt(max)) throw new Error("DURABLE_BUDGET_EXHAUSTED");
      const row = { ...scope, keyHash, payloadHash, tokenInMint: asset, amountInRaw: amount, origin, ...(recoveryOperation ? { recoveryOperation } : {}) };
      await syncWrite(join(this.#directory, keyHash + ".json"), JSON.stringify(row) + "\n");
    });
  }
  /**
   * Snapshot that writes no journal record but holds the reservation lock while it scans: a concurrent reservation fails with
   * RESERVATION_LOCK_HELD, and a process killed mid-scan leaves the lock. Its time is read after the scan, so an operation it
   * reports as resolved had already resolved.
   */
  async capacity(clock: () => number = Date.now): Promise<JournalCapacity> {
    return this.#exclusive("reservation.lock", "RESERVATION_LOCK_HELD", async () => {
      const scan = await this.#scan();
      const budgets: JournalCapacity["budgets"] = {};
      for (const [asset, limitRaw] of Object.entries(this.#policy.inputBudgets)) {
        const left = BigInt(limitRaw) - (scan.reserved.get(asset) ?? 0n);
        budgets[asset] = { limitRaw, remainingRaw: (left > 0n ? left : 0n).toString() };
      }
      return {
        observedAtMs: integer(clock(), 1, 8_000_000_000_000),
        unresolvedOperations: scan.unresolved,
        runningOperations: FileJournal.#running.get(this.#directory) ?? 0,
        reservedOperations: scan.files.length,
        remainingOperations: Math.max(0, this.#policy.maxOperations - scan.files.length),
        budgets,
        version: this.#version(scan.files.length),
      };
    });
  }
  /** Validates every reservation and its history; counts unresolved operations and reserved raw amounts per input mint. */
  async #scan(): Promise<{ files: string[]; unresolved: number; reserved: Map<string, bigint> }> {
    const names = await readdir(this.#directory);
    if (names.length > 20002) throw new Error("JOURNAL_LIMIT");
    const files = names.filter(n => /^[0-9a-f]{64}[.]json$/.test(n));
    let unresolved = 0;
    const reserved = new Map<string, bigint>();
    for (const name of files) {
      const { reservation, events } = await this.#readHash(name.slice(0, -5));
      const asset = reservation.tokenInMint, amount = reservation.amountInRaw;
      const last = events.at(-1)?.stage;
      if (last !== "FINAL_CONFIRMED" && last !== "FINAL_FAILED" && last !== "ABANDONED" && last !== "UNSENT" && last !== "EXPIRED_UNSENT") unresolved++;
      reserved.set(asset, (reserved.get(asset) ?? 0n) + BigInt(amount));
    }
    return { files, unresolved, reserved };
  }
  /** Validates that an event could be appended now, without writing it. */
  async check(key: string, event: JournalEvent): Promise<void> {
    const prior = await this.#readHash(this.#hash(key));
    this.#encode(prior.events, event, Boolean(prior.recoveryOperation));
  }
  #encode(events: JournalEvent[], event: JournalEvent, recoverable: boolean): string {
    const limit = recoverable ? maxRankedEvents : maxEvents;
    // Before another durable attempt, reserve space for its outcome and terminal chain evidence.
    if (events.length >= limit || (recoverable && event.stage === "SENDING" && events.length > limit - 3)) {
      throw new Error("JOURNAL_EVENT_LIMIT");
    }
    const encoded = JSON.stringify(event);
    if (encoded.length > 2048 || Object.keys(event).some(k => !eventKeys.includes(k))) throw new Error("INVALID_JOURNAL_EVENT");
    validateEvents([...events, JSON.parse(encoded)], recoverable);
    return encoded;
  }
  /** Exclusive lock file in the journal directory. A crash may leave it; it is never broken automatically. */
  async #exclusive<T>(name: string, code: string, task: () => Promise<T>): Promise<T> {
    const lock = join(this.#directory, name);
    // Exclusion comes from the exclusive create, which needs no fsync.
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (e) { throw (e as NodeJS.ErrnoException).code === "EEXIST" ? new Error(code) : e; }
    try { await handle.close(); } catch (e) { await unlink(lock).catch(() => {}); throw e; }
    // A failed release leaves the lock in place (fail closed) but never hides the task's own outcome.
    try { return await task(); } finally { await unlink(lock).catch(() => {}); }
  }
  /** Serializes finalization of one operation across its result write. */
  async withFinalizationLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.#exclusive(this.#hash(key) + ".finalize.lock", "FINALIZATION_LOCK_HELD", task);
  }
  /** Only one ranked gateway may advance this journal and its signal inbox at a time. */
  async withRankedSignalLock<T>(task: () => Promise<T>): Promise<T> {
    return this.#exclusive("ranked-signal.lock", "RANKED_SIGNAL_LOCK_HELD", task);
  }
  async append(key: string, event: JournalEvent, beforeWrite?: () => void, signedRecovery?: SignedRecovery): Promise<void> {
    // Read, validation and write are one step per key, so concurrent writers cannot both pass validation.
    await this.#exclusive(this.#hash(key) + ".append.lock", "JOURNAL_APPEND_LOCK_HELD", async () => {
      const prior = await this.#readHash(this.#hash(key));
      let encoded = this.#encode(prior.events, event, Boolean(prior.recoveryOperation));
      if (signedRecovery) {
        if (event.stage !== "SIGNED" || !prior.recoveryOperation) throw new Error("INVALID_JOURNAL_RECOVERY");
        encoded = JSON.stringify({ ...event, signedRecovery });
        if (encoded.length > 8192) throw new Error("INVALID_JOURNAL_RECOVERY");
      }
      const path = join(this.#directory, this.#hash(key) + ".events");
      try { await regular(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const handle = await open(path, "a", 0o600);
      try { beforeWrite?.(); await handle.writeFile(encoded + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
    });
  }
  async read(key: string): Promise<{ reservation: OperationRecord; events: JournalEvent[] }> {
    const { reservation, events } = await this.#readHash(this.#hash(key));
    return { reservation, events };
  }
  /** Internal replay data. Never include these records in receipts, logs or support reports. */
  async readRecovery(key: string): Promise<{ operation?: unknown; signed?: unknown }> {
    const { recoveryOperation, signedRecovery } = await this.#readHash(this.#hash(key));
    return { operation: recoveryOperation, signed: signedRecovery };
  }
  /** A missing reservation is recoverable only when no orphaned record or writer lock exists. */
  async readIfReserved(key: string): Promise<Awaited<ReturnType<FileJournal["read"]>> | null> {
    const hash = this.#hash(key);
    try { return await this.read(key); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of [hash + ".events", hash + ".append.lock", hash + ".finalize.lock", "reservation.lock"]) {
      try { await lstat(join(this.#directory, name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error("RANKED_RESERVATION_UNCERTAIN");
    }
    return null;
  }
  async #readHash(hash:string): Promise<{ reservation: OperationRecord; events: JournalEvent[]; recoveryOperation?: unknown; signedRecovery?: unknown }> {
    const path = join(this.#directory, hash + ".json");
    await regular(path, 2048);
    const { recoveryOperation, ...value } = record(JSON.parse(await readFile(path, "utf8")));
    const routeScopeValid = value.version === 1 ? !["apiBasePath", "accountId", "actor"].some(k => Object.hasOwn(value, k)) :
      value.version === 2 && value.apiBasePath === "/api" &&
        (value.actor === "trading_bot" || value.actor === "ai_agent") && Boolean(uuid(value.accountId));
    if (!routeScopeValid || value.keyHash !== hash || typeof value.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadHash)) throw new Error("CORRUPT_RESERVATION");
    mint(value.tokenInMint); rawAmount(value.amountInRaw);
    if (typeof value.origin!=="string" || new URL(value.origin).origin!==value.origin || !value.origin.startsWith("https://")) throw new Error("CORRUPT_RESERVATION");
    let events: JournalEvent[] = [];
    let signedRecovery: unknown;
    const eventFile = join(this.#directory, hash + ".events");
    try {
      await regular(eventFile);
      const content = await readFile(eventFile, "utf8");
      if (!content.endsWith("\n")) throw new Error("PARTIAL_JOURNAL_EVENT");
      let rows:unknown[];
      try { rows=content.trimEnd().split("\n").map(line=>JSON.parse(line) as unknown); }
      catch {throw new Error("CORRUPT_JOURNAL_EVENT");}
      events=validateEvents(rows.map(row => {
        const { signedRecovery: saved, ...event } = record(row);
        if (saved !== undefined) {
          if (event.stage !== "SIGNED" || signedRecovery !== undefined || recoveryOperation === undefined) throw new Error("INVALID_JOURNAL_RECOVERY");
          signedRecovery = saved;
        }
        return event;
      }), Boolean(recoveryOperation));
      if (events.length > (recoveryOperation ? maxRankedEvents : maxEvents)) throw new Error("JOURNAL_EVENT_LIMIT");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return { reservation: value as unknown as OperationRecord, events, recoveryOperation, signedRecovery };
  }
}

import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { digest } from "./canonical.ts";
import { closed, integer, record } from "./contract.ts";
import { mint, rawAmount, uuid } from "./client.ts";

export interface JournalPolicy { maxOperations: number; inputBudgets: Record<string, string> }
export interface OperationRecord {
  version: 1; keyHash: string; payloadHash: string; tokenInMint: string; amountInRaw: string; origin: string;
}
export interface JournalEvent {
  stage: "INTENT" | "QUOTED" | "SIGNED" | "SENDING" | "AMBIGUOUS" | "RECORDED" | "SUBMITTED" | "FINAL_CONFIRMED" | "FINAL_FAILED" | "ABANDONED" | "UNSENT";
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
}
const eventKeys=["stage","intentId","quoteId","quoteOutId","messageHash","playerSignature","playerPublicKey","transactionHash","txid","genesisHash","replayed"];
function validateEvents(values:unknown[]):JournalEvent[] {
  const result:JournalEvent[]=[];
  let intent:string|undefined,quote:string|undefined,quoteOut:string|undefined,signed:JournalEvent|undefined,sending=false,intentSeen=false,replayed:boolean|undefined;
  const fields:Record<JournalEvent["stage"],string[]>={
    INTENT:["stage","intentId","replayed"],QUOTED:["stage","intentId","quoteId","quoteOutId"],
    SIGNED:["stage","intentId","quoteId","quoteOutId","messageHash","playerSignature","playerPublicKey","transactionHash","genesisHash"],
    SENDING:["stage","intentId"],AMBIGUOUS:["stage","intentId","txid"],RECORDED:["stage","intentId","txid"],SUBMITTED:["stage","intentId","txid"],
    FINAL_CONFIRMED:["stage","intentId","txid"],FINAL_FAILED:["stage","intentId","txid"],ABANDONED:["stage","intentId"],UNSENT:["stage"],
  };
  for(const raw of values) {
    const stage=record(raw).stage as JournalEvent["stage"];
    if(!Object.hasOwn(fields,stage))throw new Error("CORRUPT_JOURNAL_EVENT");
    const e=closed(raw,fields[stage]);
    const previous=result.at(-1)?.stage;
    if((previous?.startsWith("FINAL_") || previous==="ABANDONED" || previous==="UNSENT") && stage!==previous)throw new Error("TERMINAL_JOURNAL_CONFLICT");
    if(e.intentId!==undefined) { uuid(e.intentId);if(intent && e.intentId!==intent)throw new Error("JOURNAL_INTENT_MISMATCH"); }
    if(stage!=="AMBIGUOUS" && stage!=="ABANDONED" && stage!=="UNSENT" && e.intentId===undefined)throw new Error("JOURNAL_INTENT_REQUIRED");
    // UNSENT records that the first write was refused before transmission: no server state exists.
    if(stage==="UNSENT" && previous!==undefined)throw new Error("INVALID_JOURNAL_ORDER");
    // Closure needs an explicit server-new record. Legacy INTENT entries omitted this flag even for
    // replays, which may have been signed elsewhere: an absent flag must never stand for false.
    if(stage==="ABANDONED") {
      if(signed)throw new Error("SIGNED_OPERATION_RECONCILE");
      if(!intentSeen)throw new Error("INTENT_UNKNOWN_MANUAL_RECONCILIATION");
      if(replayed)throw new Error("REPLAYED_OPERATION_RECONCILE");
      if(replayed!==false)throw new Error("INTENT_REPLAY_STATUS_UNKNOWN");
    }
    if(stage==="INTENT") {
      if(previous!==undefined)throw new Error("INVALID_JOURNAL_ORDER");intent=e.intentId as string;
      if(e.replayed!==undefined && typeof e.replayed!=="boolean")throw new Error("CORRUPT_JOURNAL_EVENT");
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
    } else if(stage==="SENDING") {
      if(previous!=="SIGNED" || !signed)throw new Error("INVALID_JOURNAL_ORDER");sending=true;
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
  #directory: string;
  #policy: JournalPolicy;
  private constructor(directory: string, policy: JournalPolicy) { this.#directory = directory; this.#policy = policy; }
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
  #hash(key: string): string {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error("INVALID_OPERATION_KEY");
    return digest({ key });
  }
  async reserve(key: string, payloadHash: string, tokenInMint: string, amountInRaw: string, origin: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error("INVALID_PAYLOAD_HASH");
    const url = new URL(origin);
    if (url.origin!==origin || url.protocol!=="https:" || url.username || url.password) throw new Error("INVALID_ORIGIN");
    const keyHash = this.#hash(key), asset = mint(tokenInMint), amount = rawAmount(amountInRaw);
    // A crash may leave this lock. Never break it automatically; reconcile the previous process first.
    await this.#exclusive("reservation.lock", "RESERVATION_LOCK_HELD", async () => {
      const names = await readdir(this.#directory);
      if (names.length > 20002) throw new Error("JOURNAL_LIMIT");
      const files = names.filter(n => /^[0-9a-f]{64}[.]json$/.test(n));
      if (files.includes(keyHash + ".json")) {
        const old = await this.read(key);
        throw new Error(old.reservation.payloadHash === payloadHash ? "OPERATION_ALREADY_RESERVED_RECONCILE" : "IDEMPOTENCY_PAYLOAD_CONFLICT");
      }
      let reserved = 0n;
      for (const name of files) {
        const path = join(this.#directory, name); await regular(path, 2048);
        const value = record(JSON.parse(await readFile(path, "utf8")));
        if (value.version !== 1 || value.keyHash + ".json" !== name || typeof value.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadHash)) throw new Error("CORRUPT_RESERVATION");
        mint(value.tokenInMint); rawAmount(value.amountInRaw);
        // One unresolved operation blocks a fresh key as well as a retry.
        const history = await this.#readHash(name.slice(0, -5));
        const last = history.events.at(-1);
        if (last?.stage !== "FINAL_CONFIRMED" && last?.stage !== "FINAL_FAILED" && last?.stage !== "ABANDONED" && last?.stage !== "UNSENT") throw new Error("UNRESOLVED_OPERATION_RECONCILE");
        if (value.tokenInMint === asset) reserved += BigInt(value.amountInRaw as string);
      }
      const max = this.#policy.inputBudgets[asset];
      if (!max || files.length >= this.#policy.maxOperations || reserved + BigInt(amount) > BigInt(max)) throw new Error("DURABLE_BUDGET_EXHAUSTED");
      await syncWrite(join(this.#directory, keyHash + ".json"), JSON.stringify({ version: 1, keyHash, payloadHash, tokenInMint: asset, amountInRaw: amount, origin } satisfies OperationRecord) + "\n");
    });
  }
  /** Validates that an event could be appended now, without writing it. */
  async check(key: string, event: JournalEvent): Promise<void> {
    this.#encode((await this.read(key)).events, event);
  }
  #encode(events: JournalEvent[], event: JournalEvent): string {
    if (events.length >= 16) throw new Error("JOURNAL_EVENT_LIMIT");
    const encoded = JSON.stringify(event);
    if (encoded.length > 2048 || Object.keys(event).some(k => !eventKeys.includes(k))) throw new Error("INVALID_JOURNAL_EVENT");
    validateEvents([...events,JSON.parse(encoded)]);
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
  async append(key: string, event: JournalEvent): Promise<void> {
    // Read, validation and write are one step per key, so concurrent writers cannot both pass validation.
    await this.#exclusive(this.#hash(key) + ".append.lock", "JOURNAL_APPEND_LOCK_HELD", async () => {
      const encoded = this.#encode((await this.read(key)).events, event);
      const path = join(this.#directory, this.#hash(key) + ".events");
      try { await regular(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const handle = await open(path, "a", 0o600);
      try { await handle.writeFile(encoded + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
    });
  }
  async read(key: string): Promise<{ reservation: OperationRecord; events: JournalEvent[] }> {
    return this.#readHash(this.#hash(key));
  }
  async #readHash(hash:string): Promise<{ reservation: OperationRecord; events: JournalEvent[] }> {
    const path = join(this.#directory, hash + ".json");
    await regular(path, 2048);
    const value = record(JSON.parse(await readFile(path, "utf8")));
    if (value.version !== 1 || value.keyHash !== hash || typeof value.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadHash)) throw new Error("CORRUPT_RESERVATION");
    mint(value.tokenInMint); rawAmount(value.amountInRaw);
    if (typeof value.origin!=="string" || new URL(value.origin).origin!==value.origin || !value.origin.startsWith("https://")) throw new Error("CORRUPT_RESERVATION");
    let events: JournalEvent[] = [];
    const eventFile = join(this.#directory, hash + ".events");
    try {
      await regular(eventFile);
      const content = await readFile(eventFile, "utf8");
      if (!content.endsWith("\n")) throw new Error("PARTIAL_JOURNAL_EVENT");
      let rows:unknown[];
      try { rows=content.trimEnd().split("\n").map(line=>JSON.parse(line) as unknown); }
      catch {throw new Error("CORRUPT_JOURNAL_EVENT");}
      events=validateEvents(rows);
      if (events.length > 16) throw new Error("JOURNAL_EVENT_LIMIT");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return { reservation: value as unknown as OperationRecord, events };
  }
}

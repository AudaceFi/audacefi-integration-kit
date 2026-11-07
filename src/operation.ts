import { AudaceFiClient, ClientError, mint, parseQuote, rawAmount, uuid, type Quote, type Submission } from "./client.ts";
import { category, closed, integer, timestamp, type Category } from "./contract.ts";
import { digest } from "./canonical.ts";
import { FileJournal, type JournalEvent, type OperationRecord } from "./journal.ts";
import { assertSignatureEncoding, inspectTransaction } from "./transaction.ts";

export interface Operation {
  actor: "ai_agent" | "trading_bot";
  operationKey: string;
  seasonId: string;
  category: Category;
  playerPublicKey: string;
  tokenInMint: string;
  tokenOutMint: string;
  amountIn: number;
  amountInRaw: string;
  inputDecimals: number;
}
export interface VerifiedTarget {
  network: "devnet";
  expectedGenesis: string;
  observedGenesis: string;
  durableProtocol: "audacefi.bench.submission.v1";
  usdcMainnet: string;
  allowedPrograms: string[];
  mappings: { mainnet: string; devnet: string; decimals: number }[];
}
export interface BuildRecovery { createdAt: number; lastValidBlockHeight: number }
export interface SignedRecovery { transaction: string; quote: Quote; build: BuildRecovery }
export interface OperatorPorts {
  /** Must verify the actual deployment, genesis, programs and current asset mappings. */
  verifyTarget: () => Promise<VerifiedTarget>;
  /** Reference deployment-approval check, including after credential resolution before early API writes. */
  assertTargetCurrent?: () => void | Promise<void>;
  /** Persist caller-owned admission state after reservation and before the first POST. */
  onReserved?: () => void;
  /** Build from the validated quote; never a model-supplied transaction. */
  build: (operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<string>;
  /** Independently inspect semantics and collect fresh balances, total fees, eligibility and blockhash evidence. */
  verifyPlan: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<PlanEvidence>;
  /** Optional for custom ports; the reference suite refreshes chain/policy evidence after wallet waits and before each transmission. */
  revalidate?: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<PlanEvidence>;
  /** Ranked recovery is available only through an adapter that can revalidate the exact old signed message. */
  recovery?: {
    capture: (messageHash: string) => BuildRecovery;
    restore: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>, build: BuildRecovery) => void;
    target: () => VerifiedTarget;
    expired: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, build: BuildRecovery) => Promise<boolean>;
  };
  /** Wallet-owned signing authority; not an API key. No signer is bundled or automatically selected. */
  sign: (transaction: string) => Promise<{ transaction: string; signature: string }>;
}
/** `reason` keeps only code-shaped error messages (library, client, RPC or port codes); other text becomes UNCLASSIFIED_FAILURE. Ports must not put secrets in error messages. */
export interface OperationResult { state: "SUBMITTED" | "RECORDED" | "UNKNOWN" | "AMBIGUOUS" | "UNSENT"; intentId: string | null; txid: string | null; reason?: string }
// Uppercase words joined by underscores, none over 16 characters: long tokens such as keys or hex digests are not codes.
const failureCode=(error:unknown)=>error instanceof Error && error.message.length<=64 && /^[A-Z][A-Z0-9]{0,15}(?:_[A-Z0-9]{1,16})+$/.test(error.message)?error.message:"UNCLASSIFIED_FAILURE";
export interface PlanEvidence {
  operationHash: string; quoteId: string; messageHash: string; genesisHash: string;
  balanceObservedAtMs: number; eligibilityObservedAtMs: number; blockhashObservedAtMs: number;
  inputBalanceRaw: string; gasBalanceLamports: string; requiredGasLamports: string;
  outputBalanceRaw?: string;
  eligible: true;
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function validateOperation(o: Operation): Operation {
  closed(o,["actor","operationKey","seasonId","category","playerPublicKey","tokenInMint","tokenOutMint","amountIn","amountInRaw","inputDecimals"]);
  if (o.actor !== "ai_agent" && o.actor !== "trading_bot") throw new Error("INVALID_ACTOR");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(o.operationKey)) throw new Error("INVALID_OPERATION_KEY");
  uuid(o.seasonId); category(o.category); mint(o.playerPublicKey); mint(o.tokenInMint); mint(o.tokenOutMint); rawAmount(o.amountInRaw);
  const decimals = integer(o.inputDecimals, 0, 9);
  const s = String(o.amountIn), parts = s.split(".");
  if (!/^[0-9]+(?:[.][0-9]+)?$/.test(s) || (parts[1]?.length ?? 0) > decimals || o.amountIn <= 0 || o.amountIn > 1e12 || BigInt(parts[0]! + (parts[1] ?? "").padEnd(decimals,"0")) !== BigInt(o.amountInRaw) || o.tokenInMint === o.tokenOutMint) throw new Error("AMOUNT_UNIT_MISMATCH");
  return structuredClone(o);
}
function validateTarget(t: VerifiedTarget, o: Operation, outputDecimals: number | undefined): VerifiedTarget {
  if (t.network !== "devnet" || t.durableProtocol !== "audacefi.bench.submission.v1" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(t.expectedGenesis) || t.expectedGenesis !== t.observedGenesis) throw new Error("UNVERIFIED_TARGET");
  mint(t.usdcMainnet);
  if (t.allowedPrograms.length < 1 || t.allowedPrograms.length > 8 || t.mappings.length < 2 || t.mappings.length > 64) throw new Error("INVALID_TARGET");
  t.allowedPrograms.forEach(mint);
  for (const m of t.mappings) { mint(m.mainnet); mint(m.devnet); integer(m.decimals,0,9); }
  if (new Set(t.mappings.map(m=>m.mainnet)).size !== t.mappings.length || new Set(t.mappings.map(m=>m.devnet)).size !== t.mappings.length) throw new Error("DUPLICATE_MAPPING");
  const input=t.mappings.find(m=>m.mainnet===o.tokenInMint), output=t.mappings.find(m=>m.mainnet===o.tokenOutMint);
  if (!input || !output || input.decimals!==o.inputDecimals) throw new Error("MAPPING_REQUIRED");
  if (outputDecimals!==undefined && output.decimals!==outputDecimals) throw new Error("OUTPUT_DECIMALS_MISMATCH");
  return structuredClone(t);
}
function validateQuote(q: Quote,o: Operation,t: VerifiedTarget,now: number): void {
  if (timestamp(q.expiresAt)<=now || timestamp(q.expiresAt)>now+q.ttlSeconds*1000+30000 || q.amountInRaw!==o.amountInRaw) throw new Error("QUOTE_EXPIRED_OR_MISMATCHED");
  if (q.kind==="route") {
    if (q.mintInMainnet!==o.tokenInMint || q.mintOutMainnet!==o.tokenOutMint || q.mintInDevnet!==t.mappings.find(m=>m.mainnet===o.tokenInMint)?.devnet || q.mintOutDevnet!==t.mappings.find(m=>m.mainnet===o.tokenOutMint)?.devnet || q.feeBps!==20 || q.quoteId===q.quoteIdOut) throw new Error("ROUTE_MAPPING_MISMATCH");
  } else {
    const buy=o.tokenInMint===t.usdcMainnet, sell=o.tokenOutMint===t.usdcMainnet;
    const token=buy?o.tokenOutMint:o.tokenInMint;
    if (buy===sell || q.direction!==(buy?"buy":"sell") || q.mintMainnet!==token || q.mintDevnet!==t.mappings.find(m=>m.mainnet===token)?.devnet) throw new Error("QUOTE_MAPPING_MISMATCH");
  }
}
/**
 * `notAfterMs`, such as a signal's expiry, binds until the SIGNED write begins under the journal lock.
 * Once that write begins, the transaction follows the normal submission and reconciliation rules.
 * `outputDecimals`, when set, must equal the verified mapping's decimals for the token received; checked before any reservation.
 * `journalVersion`, when set, is a `capacity()` snapshot's `version`; the reservation is refused on another journal or once it changed.
 */
export interface OperationLimits { notAfterMs?: number | undefined; outputDecimals?: number | undefined; journalVersion?: string | undefined }
/** One explicit operation, no scheduler/retries, shared by both actor types. A FileJournal counts it from its first step. */
export async function runOperation(client: AudaceFiClient,journal: FileJournal,input: Operation,ports: OperatorPorts,clock:()=>number=Date.now,limits:OperationLimits={}): Promise<OperationResult> {
  const task=()=>runTracked(client,journal,input,ports,clock,limits);
  return journal instanceof FileJournal?journal.trackRun(task):task();
}
type Resume = Awaited<ReturnType<FileJournal["read"]>> & { signedRecovery: unknown };
function operationCommitment(client: AudaceFiClient, operation: Readonly<Operation>, target: Readonly<VerifiedTarget>) {
  const { origin, apiBasePath, officialProxyIdentity: officialProxy } = client;
  return digest({ origin, ...(apiBasePath ? { apiBasePath, officialProxy } : {}), operation, target });
}
function recoverSigned(raw: unknown, signed: JournalEvent, operation: Readonly<Operation>, target: Readonly<VerifiedTarget>, now: number): SignedRecovery {
  const saved=closed(raw,["transaction","quote","build"]);
  const savedQuote=closed(saved.quote,["kind","intentId","quoteId","quoteIdOut","amountInRaw","expiresAt","ttlSeconds",
    "mintMainnet","mintDevnet","direction","price","expo","priceUsd","mintInMainnet","mintInDevnet","mintOutMainnet","mintOutDevnet",
    "priceIn","priceOut","amountOutGrossRaw","feeRaw","feeBps","amountOutNetRaw"]);
  const quote=parseQuote(savedQuote.kind==="single"?{...savedQuote,kind:undefined}:savedQuote);
  const build=closed(saved.build,["createdAt","lastValidBlockHeight"]);
  if(typeof saved.transaction!=="string" || quote.intentId!==signed.intentId || quote.quoteId!==signed.quoteId ||
      (quote.kind==="route"?quote.quoteIdOut:undefined)!==signed.quoteOutId || signed.playerPublicKey!==operation.playerPublicKey ||
      signed.genesisHash!==target.expectedGenesis)throw new Error("RECOVERY_SIGNED_BINDING_MISMATCH");
  const checked=inspectTransaction(saved.transaction,operation.playerPublicKey,target.allowedPrograms,true);
  if(checked.transactionHash!==signed.transactionHash || checked.messageHash!==signed.messageHash || !signed.playerSignature)throw new Error("RECOVERY_SIGNED_BINDING_MISMATCH");
  assertSignatureEncoding(signed.playerSignature,checked.playerSignatureBytes);
  return {transaction:saved.transaction,quote,build:{createdAt:integer(build.createdAt,0,now),lastValidBlockHeight:integer(build.lastValidBlockHeight,1,Number.MAX_SAFE_INTEGER)}};
}

/** The ranked caller holds the inbox lock and has matched the original exact signal line. */
export async function resumeRankedOperation(client: AudaceFiClient, journal: FileJournal, key: string, ports: OperatorPorts,
  expiresAtMs: number): Promise<void> {
  const entry = await journal.read(key), last = entry.events.at(-1);
  const recoveringCreate = !last || (last.stage === "AMBIGUOUS" && entry.events.length === 1 && !last.intentId);
  const recoveringSigned = last && ["SIGNED", "SIGNATURE_POSTING", "SEND_REFUSED"].includes(last.stage);
  if (!ports.recovery || (!recoveringCreate && !recoveringSigned) || (recoveringCreate && expiresAtMs <= Date.now())) return;
  assertJournalTarget(entry.reservation, client);
  const saved = await journal.readRecovery(key);
  if (!saved.operation || (recoveringSigned && !saved.signed)) return;
  const operation = validateOperation(saved.operation as Operation);
  if (operation.operationKey !== key) throw new Error("RECOVERY_OPERATION_MISMATCH");
  if (recoveringSigned) {
    const signed = entry.events.find(event => event.stage === "SIGNED");
    const target = validateTarget(ports.recovery.target(), operation, undefined);
    if (!signed?.intentId || !signed.playerSignature || entry.reservation.payloadHash !== operationCommitment(client, operation, target)) {
      throw new Error("RECOVERY_SIGNED_BINDING_MISMATCH");
    }
    const exact = recoverSigned(saved.signed, signed, operation, target, Date.now());
    if (await ports.recovery.expired(exact.transaction, operation, exact.quote, exact.build)) {
      const remote = await client.readSubmissionStatus(signed.intentId);
      if (remote.submission || remote.resultStatus !== null) return;
      await journal.append(key, { stage: "EXPIRED_UNSENT", intentId: signed.intentId, txid: signed.playerSignature });
      return;
    }
  }
  await journal.trackRun(() => runTracked(client, journal, operation, ports, Date.now,
    { notAfterMs: expiresAtMs }, { ...entry, signedRecovery: saved.signed }));
}

async function runTracked(client: AudaceFiClient,journal: FileJournal,input: Operation,ports: OperatorPorts,clock:()=>number,limits:OperationLimits,resume?:Resume): Promise<OperationResult> {
  const o=freeze(validateOperation(input));
  const bounds=closed(limits,["notAfterMs","outputDecimals","journalVersion"]);
  const notAfter=bounds.notAfterMs===undefined?undefined:integer(bounds.notAfterMs,1,8000000000000);
  const outputDecimals=bounds.outputDecimals===undefined?undefined:integer(bounds.outputDecimals,0,9);
  const journalVersion=bounds.journalVersion;
  if(journalVersion!==undefined && (typeof journalVersion!=="string" || !/^[0-9a-f]{64}$/.test(journalVersion)))throw new Error("INVALID_JOURNAL_VERSION");
  // An older JavaScript journal adapter can ignore extra arguments. Require the implementation that enforces them.
  if((notAfter!==undefined || journalVersion!==undefined || client.apiBasePath) && !(journal instanceof FileJournal))throw new Error("JOURNAL_LIMITS_UNSUPPORTED");
  // A read-only client could only fail at the first write: refuse before reading or reserving anything.
  if(!client.writesAuthorized)throw new Error("WRITES_NOT_AUTHORIZED");
  const apiBasePath=client.apiBasePath||undefined, officialProxy=client.officialProxyIdentity;
  if(apiBasePath && (!officialProxy || officialProxy.actor!==o.actor))throw new Error("OFFICIAL_PROXY_IDENTITY_MISMATCH");
  if(apiBasePath)await client.assertExecuteScope();
  const state=await client.readState(o.category,"real"), now=clock(), s=state.season.active,w=state.wallet;
  if (!s || s.id!==o.seasonId || s.status!=="active" || s.executionMode!=="devnet_onchain" || s.startsAt===null || s.endsAt===null || timestamp(s.startsAt)>now || timestamp(s.endsAt)<=now || timestamp(state.asOf)>now+30000 || now-timestamp(state.asOf)>120000 || w.state!=="ok" || w.walletAddress!==o.playerPublicKey || w.seasonId!==s.id || w.seasonExecutionMode!=="devnet_onchain" || w.mode!=="real" || w.category!==o.category.replace("-","_")) throw new Error("STATE_NOT_EXECUTABLE");
  const target=freeze(validateTarget(await ports.verifyTarget(),o,outputDecimals));
  const priorSigned = resume?.events.find(event => event.stage === "SIGNED");
  let last=now,signatureJournaled=Boolean(priorSigned),deadlineReached=false;
  function current():number {
    const at=integer(clock(),0,8000000000000);
    if(at<last)throw new Error("CLOCK_REGRESSION");last=at;
    if(!s || s.endsAt===null || at>=timestamp(s.endsAt) || at-timestamp(state.asOf)>120000)throw new Error("EVIDENCE_EXPIRED");
    // Recorded here because the client reports a refusal inside its pre-send guard as GUARD_REFUSED_BEFORE_SEND.
    if(notAfter!==undefined && !signatureJournaled && at>=notAfter){deadlineReached=true;throw new Error("OPERATION_DEADLINE_PASSED");}
    return at;
  }
  current();
  const commitment=operationCommitment(client,o,target);
  const reservation=[o.operationKey,commitment,o.tokenInMint,o.amountInRaw,client.origin] as const;
  if(resume) {
    if(resume.reservation.payloadHash!==commitment || resume.reservation.tokenInMint!==o.tokenInMint ||
        resume.reservation.amountInRaw!==o.amountInRaw)throw new Error("RECOVERY_OPERATION_MISMATCH");
  } else if(ports.recovery) {
    if(!(journal instanceof FileJournal))throw new Error("JOURNAL_RECOVERY_UNSUPPORTED");
    await journal.reserve(...reservation,journalVersion,officialProxy,o);
    ports.onReserved?.();
  } else if(apiBasePath)await journal.reserve(...reservation,journalVersion,officialProxy);
  else if(journalVersion===undefined)await journal.reserve(...reservation);
  else await journal.reserve(...reservation,journalVersion);
  if(!resume && !ports.recovery)ports.onReserved?.();
  let intentId=priorSigned?.intentId??null, sending=false;
  try {
    const targetGuard=async()=>{current();await ports.assertTargetCurrent?.();current();};
    let q: Readonly<Quote>, unsigned: string, recovered: SignedRecovery | undefined;
    if(priorSigned && intentId && ports.recovery) {
      recovered=freeze(recoverSigned(resume!.signedRecovery,priorSigned,o,target,current()));
      q=recovered.quote;
      const unsignedBytes=Buffer.from(recovered.transaction,"base64");
      // inspectTransaction has already required the exact legacy two-signature layout.
      unsignedBytes.fill(0,1,129);
      unsigned=unsignedBytes.toString("base64");
      validateQuote(q,o,target,current());
      ports.recovery.restore(unsigned,o,q,target,recovered.build);
    } else {
      const input={...o,idempotencyKey:o.operationKey};
      const intent=resume?await client.createIntent(input,targetGuard,true):await client.createIntent(input,targetGuard);
      intentId=intent.intentId;
      await journal.append(o.operationKey,{stage:"INTENT",intentId,replayed:intent.replayed,
        ...(resume && intent.replayed ? {exactInputBound:true as const} : {})});
      // A fresh reservation never explains a server replay. Only the exact retained request may recover one.
      if(intent.replayed && !resume)throw new Error("REPLAYED_INTENT_RECONCILE");
      q=freeze(await client.quote(intentId,o.amountInRaw,targetGuard));validateQuote(q,o,target,current());
      await journal.append(o.operationKey,{stage:"QUOTED",intentId,quoteId:q.quoteId,...(q.kind==="route"?{quoteOutId:q.quoteIdOut}:{})});
      unsigned=await ports.build(o,q,target);
    }
    const quoteOutId=q.kind==="route"?q.quoteIdOut:undefined;
    const plan=inspectTransaction(unsigned,o.playerPublicKey,target.allowedPrograms,false);
    let evidence=freeze(structuredClone(await ports.verifyPlan(unsigned,o,q,target)));
    const guard=()=>{
      const observedNow=current();validateQuote(q,o,target,observedNow);
      if(evidence.operationHash!==digest(o) || evidence.quoteId!==q.quoteId || evidence.messageHash!==plan.messageHash || evidence.genesisHash!==target.expectedGenesis || evidence.eligible!==true)throw new Error("PLAN_NOT_VERIFIED");
      for(const at of [evidence.balanceObservedAtMs,evidence.eligibilityObservedAtMs,evidence.blockhashObservedAtMs]) {
        integer(at,0,8000000000000);
        if(at>observedNow+30000 || observedNow-at>120000)throw new Error("PLAN_EVIDENCE_STALE");
      }
      if(BigInt(rawAmount(evidence.inputBalanceRaw))<BigInt(o.amountInRaw) || BigInt(rawAmount(evidence.gasBalanceLamports))<BigInt(rawAmount(evidence.requiredGasLamports)))throw new Error("INSUFFICIENT_VERIFIED_BALANCE");
    };
    const freshGuard=async()=>{
      guard();
      if(ports.revalidate) evidence=freeze(structuredClone(await ports.revalidate(unsigned,o,q,target)));
      guard();
    };
    guard();
    const signed=recovered ? {transaction:recovered.transaction,signature:priorSigned!.playerSignature!} : await ports.sign(unsigned);
    const checked=inspectTransaction(signed.transaction,o.playerPublicKey,target.allowedPrograms,true);
    if (checked.messageHash!==plan.messageHash) throw new Error("MESSAGE_CHANGED_AFTER_SIGNING");
    assertSignatureEncoding(signed.signature,checked.playerSignatureBytes);
    if(!ports.recovery)await freshGuard();
    const signedEvent:JournalEvent={stage:"SIGNED",intentId,quoteId:q.quoteId,...(quoteOutId?{quoteOutId}:{}),messageHash:checked.messageHash,transactionHash:checked.transactionHash,playerPublicKey:o.playerPublicKey,playerSignature:signed.signature,genesisHash:target.expectedGenesis};
    if(!recovered) {
      const build=ports.recovery?.capture(checked.messageHash);
      if(build)await journal.append(o.operationKey,signedEvent,notAfter===undefined?undefined:current,{transaction:signed.transaction,quote:q,build});
      else if(notAfter===undefined)await journal.append(o.operationKey,signedEvent);
      else await journal.append(o.operationKey,signedEvent,current);
    }
    signatureJournaled=true;
    if(ports.recovery && !resume?.events.some(event=>event.stage==="SIGNATURE_POSTING")) {
      await freshGuard();
      await journal.append(o.operationKey,{stage:"SIGNATURE_POSTING",intentId});
    }
    // A proven durable pre-send refusal comes after acknowledgement of this exact signature.
    if(resume?.events.at(-1)?.stage!=="SEND_REFUSED") await client.recordSignature(intentId,signed.signature,freshGuard);
    guard();
    await journal.append(o.operationKey,{stage:"SENDING",intentId});
    sending=true;
    let saved: Submission;
    try {
      saved=await client.submitDurable(intentId,{quoteId:q.quoteId,...(quoteOutId?{quoteOutId}:{}),transaction:signed.transaction},freshGuard);
    } catch (error) {
      if(ports.recovery && error instanceof ClientError && !error.ambiguous) {
        await journal.append(o.operationKey,{stage:"SEND_REFUSED",intentId});
        sending=false;
      }
      throw error;
    }
    if (saved.messageHash!==checked.messageHash || saved.playerSignature!==signed.signature || saved.playerPublicKey!==o.playerPublicKey || saved.txid!==signed.signature) throw new Error("SUBMISSION_BINDING_MISMATCH");
    await journal.append(o.operationKey,{stage:saved.state==="UNKNOWN"?"AMBIGUOUS":saved.state,intentId,txid:saved.txid});
    return {state:saved.state,intentId,txid:saved.txid};
  } catch (error) {
    const reason=deadlineReached?"OPERATION_DEADLINE_PASSED":failureCode(error);
    // The client reports a write as non-ambiguous only if its transport was never called: a create-intent
    // refused that way left no server state, so the operation is closed. Everything else stays ambiguous.
    if(!resume && intentId===null && error instanceof ClientError && !error.ambiguous) {
      await journal.append(o.operationKey,{stage:"UNSENT"});
      return {state:"UNSENT",intentId,txid:null,reason};
    }
    if(ports.recovery && signatureJournaled && !sending) {
      return {state:"AMBIGUOUS",intentId,txid:null,reason};
    }
    // Even an abort or malformed write response cannot authorize a replacement.
    if(!(resume && intentId===null && resume.events.at(-1)?.stage==="AMBIGUOUS")) {
      await journal.append(o.operationKey,{stage:"AMBIGUOUS",...(intentId?{intentId}:{})});
    }
    return {state:"AMBIGUOUS",intentId,txid:null,reason};
  }
}
/** Close an unsigned server-new intention or a built replay bound to the exact retained input. The reservation stays counted. */
export async function abandonOperation(journal: FileJournal,key:string): Promise<void> {
  const entry=await journal.read(key), intentId=entry.events.find(e=>e.intentId)?.intentId;
  await journal.append(key,{stage:"ABANDONED",...(intentId?{intentId}:{})});
}
function assertJournalTarget(reservation: OperationRecord, client: AudaceFiClient): void {
  if (reservation.origin!==client.origin) throw new Error("RECONCILIATION_ORIGIN_MISMATCH");
  if ((reservation.apiBasePath??"")!==(client.apiBasePath??"")) throw new Error("RECONCILIATION_API_BASE_PATH_MISMATCH");
  if (reservation.version===2 &&
      (client.officialProxyIdentity?.accountId!==reservation.accountId || client.officialProxyIdentity?.actor!==reservation.actor)) {
    throw new Error("RECONCILIATION_PROXY_IDENTITY_MISMATCH");
  }
}
/** Read only. Null means no durable record observed, never permission to resend. */
export async function reconcileOperation(client: AudaceFiClient,journal: FileJournal,key:string): Promise<Submission|null> {
  const entry=await journal.read(key), intent=entry.events.find(e=>e.intentId)?.intentId;
  assertJournalTarget(entry.reservation, client);
  if (!intent) throw new Error("INTENT_UNKNOWN_MANUAL_RECONCILIATION");
  const saved=await client.readSubmission(intent);
  if (saved) assertSubmissionBinding(saved, entry.events.find(e=>e.stage==="SIGNED"));
  return saved;
}
function assertSubmissionBinding(saved: Submission, signed: JournalEvent | undefined): void {
  if (!signed || saved.intentId!==signed.intentId || saved.quoteId!==signed.quoteId || saved.quoteOutId!==(signed.quoteOutId??null) ||
      saved.messageHash!==signed.messageHash || saved.playerSignature!==signed.playerSignature ||
      saved.playerPublicKey!==signed.playerPublicKey || saved.txid!==signed.playerSignature) throw new Error("RECONCILIATION_BINDING_MISMATCH");
}
/** The caller supplies final chain evidence from its pinned verifier; RECORDED is never final. */
export type FinalEvidence = {status:"unknown"}|{status:"confirmed"|"failed";commitment:"finalized";genesisHash:string;txid:string};
type VerifyFinal = (saved:Readonly<Submission>,expected:Readonly<{genesisHash:string;origin:string;apiBasePath?:"/api"}>)=>Promise<FinalEvidence>;
type FinalStatus = "confirmed"|"failed"|"unknown";
export async function finalizeOperation(client: AudaceFiClient,journal: FileJournal,key:string,verifyFinal:VerifyFinal,beforeRecord?:()=>Promise<void>): Promise<FinalStatus> {
  return settleFinalResult(client,journal,key,verifyFinal,{beforeRecord});
}
/** Reconcile exact server and chain state. An explicit guard permits replaying a result the server reports missing. */
export async function recoverFinalResult(client: AudaceFiClient,journal: FileJournal,key:string,verifyFinal:VerifyFinal,beforeRecord?:()=>Promise<void>): Promise<FinalStatus> {
  return settleFinalResult(client,journal,key,verifyFinal,{recovery:true,beforeRecord});
}
async function settleFinalResult(client: AudaceFiClient,journal: FileJournal,key:string,verifyFinal:VerifyFinal,options: {recovery?: boolean; beforeRecord?: (()=>Promise<void>)|undefined}): Promise<FinalStatus> {
  // One finalization at a time per operation, so the result write is neither duplicated nor contradicted.
  return journal.withFinalizationLock(key,async():Promise<FinalStatus>=>{
    const local=await journal.read(key),signed=local.events.find(e=>e.stage==="SIGNED"),last=local.events.at(-1)?.stage;
    assertJournalTarget(local.reservation, client);
    if(last==="FINAL_CONFIRMED" || last==="FINAL_FAILED")return last==="FINAL_CONFIRMED"?"confirmed":"failed";
    if(!signed?.genesisHash || !signed.intentId)throw new Error("MISSING_NETWORK_BINDING");
    // A stop after SENDING left no response record: mark it ambiguous before any further remote write.
    if(last==="SENDING")await journal.append(key,{stage:"AMBIGUOUS",...(signed.intentId?{intentId:signed.intentId}:{})});
    const stored=options.recovery?await client.readSubmissionStatus(signed.intentId):undefined;
    if(stored && (!stored.resultStatusKnown || (stored.resultStatus===null && !options.beforeRecord)))return "unknown";
    const saved=stored?stored.submission:await reconcileOperation(client,journal,key);
    if (!saved) return "unknown";
    assertSubmissionBinding(saved,signed);
    const apiBasePath=local.reservation.apiBasePath;
    const proof=await verifyFinal(freeze(saved),freeze({genesisHash:signed.genesisHash,origin:client.origin,...(apiBasePath?{apiBasePath}:{})}));
    if(proof.status==="unknown")return "unknown";
    const status=proof.status;
    if ((status!=="confirmed" && status!=="failed") || proof.commitment!=="finalized" || proof.genesisHash!==signed.genesisHash || proof.txid!==saved.txid) throw new Error("INVALID_FINAL_EVIDENCE");
    if(stored?.resultStatus && stored.resultStatus!==status)throw new Error("FINAL_RESULT_STATUS_MISMATCH");
    const final:JournalEvent={stage:status==="confirmed"?"FINAL_CONFIRMED":"FINAL_FAILED",intentId:saved.intentId,txid:saved.txid};
    // Validate the local transition first: a result write must never be left unrecordable.
    await journal.check(key,final);
    if(!stored || stored.resultStatus===null)await client.recordConfirmedResult(saved.intentId,status,options.beforeRecord);
    await journal.append(key,final);
    return status;
  });
}

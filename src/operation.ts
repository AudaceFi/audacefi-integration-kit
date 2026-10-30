import { AudaceFiClient, ClientError, mint, rawAmount, uuid, type Quote, type Submission } from "./client.ts";
import { category, closed, integer, timestamp, type Category } from "./contract.ts";
import { digest } from "./canonical.ts";
import { FileJournal, type JournalEvent } from "./journal.ts";
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
export interface OperatorPorts {
  /** Must verify the actual deployment, genesis, programs and current asset mappings. */
  verifyTarget: () => Promise<VerifiedTarget>;
  /** Reference deployment-approval check, including after credential resolution before early API writes. */
  assertTargetCurrent?: () => void | Promise<void>;
  /** Build from the validated quote; never a model-supplied transaction. */
  build: (operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<string>;
  /** Independently inspect semantics and collect fresh balances, total fees, eligibility and blockhash evidence. */
  verifyPlan: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<PlanEvidence>;
  /** Optional for custom ports; the reference suite refreshes chain/policy evidence after wallet waits and before each transmission. */
  revalidate?: (transaction: string, operation: Readonly<Operation>, quote: Readonly<Quote>, target: Readonly<VerifiedTarget>) => Promise<PlanEvidence>;
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
function validateTarget(t: VerifiedTarget, o: Operation): VerifiedTarget {
  if (t.network !== "devnet" || t.durableProtocol !== "audacefi.bench.submission.v1" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(t.expectedGenesis) || t.expectedGenesis !== t.observedGenesis) throw new Error("UNVERIFIED_TARGET");
  mint(t.usdcMainnet);
  if (t.allowedPrograms.length < 1 || t.allowedPrograms.length > 8 || t.mappings.length < 2 || t.mappings.length > 64) throw new Error("INVALID_TARGET");
  t.allowedPrograms.forEach(mint);
  for (const m of t.mappings) { mint(m.mainnet); mint(m.devnet); integer(m.decimals,0,9); }
  if (new Set(t.mappings.map(m=>m.mainnet)).size !== t.mappings.length || new Set(t.mappings.map(m=>m.devnet)).size !== t.mappings.length) throw new Error("DUPLICATE_MAPPING");
  const input=t.mappings.find(m=>m.mainnet===o.tokenInMint), output=t.mappings.find(m=>m.mainnet===o.tokenOutMint);
  if (!input || !output || input.decimals!==o.inputDecimals) throw new Error("MAPPING_REQUIRED");
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
/** One explicit operation, no scheduler/retries, shared by both actor types. */
export async function runOperation(client: AudaceFiClient,journal: FileJournal,input: Operation,ports: OperatorPorts,clock:()=>number=Date.now): Promise<OperationResult> {
  const o=freeze(validateOperation(input));
  // A read-only client could only fail at the first write: refuse before reading or reserving anything.
  if(!client.writesAuthorized)throw new Error("WRITES_NOT_AUTHORIZED");
  const state=await client.readState(o.category,"real"), now=clock(), s=state.season.active,w=state.wallet;
  if (!s || s.id!==o.seasonId || s.status!=="active" || s.executionMode!=="devnet_onchain" || s.startsAt===null || s.endsAt===null || timestamp(s.startsAt)>now || timestamp(s.endsAt)<=now || timestamp(state.asOf)>now+30000 || now-timestamp(state.asOf)>120000 || w.state!=="ok" || w.walletAddress!==o.playerPublicKey || w.seasonId!==s.id || w.seasonExecutionMode!=="devnet_onchain" || w.mode!=="real" || w.category!==o.category.replace("-","_")) throw new Error("STATE_NOT_EXECUTABLE");
  const target=freeze(validateTarget(await ports.verifyTarget(),o));
  let last=now;
  function current():number {
    const at=integer(clock(),0,8000000000000);
    if(at<last)throw new Error("CLOCK_REGRESSION");last=at;
    if(!s || s.endsAt===null || at>=timestamp(s.endsAt) || at-timestamp(state.asOf)>120000)throw new Error("EVIDENCE_EXPIRED");
    return at;
  }
  current();
  const commitment=digest({origin:client.origin,operation:o,target});
  await journal.reserve(o.operationKey,commitment,o.tokenInMint,o.amountInRaw,client.origin);
  let intentId:string|null=null;
  try {
    const targetGuard=async()=>{current();await ports.assertTargetCurrent?.();current();};
    const intent=await client.createIntent({...o,idempotencyKey:o.operationKey},targetGuard);intentId=intent.intentId;
    await journal.append(o.operationKey,{stage:"INTENT",intentId,replayed:intent.replayed});
    // A fresh local reservation cannot explain a server replay: stop and reconcile the original key.
    // The replay is journaled so this operation can never be abandoned locally.
    if(intent.replayed)throw new Error("REPLAYED_INTENT_RECONCILE");
    const q=freeze(await client.quote(intentId,o.amountInRaw,targetGuard));validateQuote(q,o,target,current());
    const quoteOutId=q.kind==="route"?q.quoteIdOut:undefined;
    await journal.append(o.operationKey,{stage:"QUOTED",intentId,quoteId:q.quoteId,...(quoteOutId?{quoteOutId}:{})});
    const unsigned=await ports.build(o,q,target);
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
    const signed=await ports.sign(unsigned);
    const checked=inspectTransaction(signed.transaction,o.playerPublicKey,target.allowedPrograms,true);
    if (checked.messageHash!==plan.messageHash) throw new Error("MESSAGE_CHANGED_AFTER_SIGNING");
    assertSignatureEncoding(signed.signature,checked.playerSignatureBytes);
    await freshGuard();
    await journal.append(o.operationKey,{stage:"SIGNED",intentId,quoteId:q.quoteId,...(quoteOutId?{quoteOutId}:{}),messageHash:checked.messageHash,transactionHash:checked.transactionHash,playerPublicKey:o.playerPublicKey,playerSignature:signed.signature,genesisHash:target.expectedGenesis});
    await client.recordSignature(intentId,signed.signature,freshGuard);
    guard();
    await journal.append(o.operationKey,{stage:"SENDING",intentId});
    const saved=await client.submitDurable(intentId,{quoteId:q.quoteId,...(quoteOutId?{quoteOutId}:{}),transaction:signed.transaction},freshGuard);
    if (saved.messageHash!==checked.messageHash || saved.playerSignature!==signed.signature || saved.playerPublicKey!==o.playerPublicKey || saved.txid!==signed.signature) throw new Error("SUBMISSION_BINDING_MISMATCH");
    await journal.append(o.operationKey,{stage:saved.state==="UNKNOWN"?"AMBIGUOUS":saved.state,intentId,txid:saved.txid});
    return {state:saved.state,intentId,txid:saved.txid};
  } catch (error) {
    // The client reports a write as non-ambiguous only if its transport was never called: a create-intent
    // refused that way left no server state, so the operation is closed. Everything else stays ambiguous.
    if(intentId===null && error instanceof ClientError && !error.ambiguous) {
      await journal.append(o.operationKey,{stage:"UNSENT"});
      return {state:"UNSENT",intentId,txid:null,reason:failureCode(error)};
    }
    // Even an abort or malformed write response cannot authorize a replacement.
    await journal.append(o.operationKey,{stage:"AMBIGUOUS",...(intentId?{intentId}:{})});
    return {state:"AMBIGUOUS",intentId,txid:null,reason:failureCode(error)};
  }
}
/** Local closure of an intention the server reported as new and this journal never signed: no journal can hold a signed transaction for it. Refused after SIGNED, after a replay or without a journaled INTENT. The reservation stays counted. */
export async function abandonOperation(journal: FileJournal,key:string): Promise<void> {
  const entry=await journal.read(key), intentId=entry.events.find(e=>e.intentId)?.intentId;
  await journal.append(key,{stage:"ABANDONED",...(intentId?{intentId}:{})});
}
/** Read only. Null means no durable record observed, never permission to resend. */
export async function reconcileOperation(client: AudaceFiClient,journal: FileJournal,key:string): Promise<Submission|null> {
  const entry=await journal.read(key), intent=entry.events.find(e=>e.intentId)?.intentId;
  if (entry.reservation.origin!==client.origin) throw new Error("RECONCILIATION_ORIGIN_MISMATCH");
  if (!intent) throw new Error("INTENT_UNKNOWN_MANUAL_RECONCILIATION");
  const saved=await client.readSubmission(intent);
  const signed=entry.events.find(e=>e.stage==="SIGNED");
  if (saved && (!signed || saved.quoteId!==signed.quoteId || saved.quoteOutId!==(signed.quoteOutId??null) || saved.messageHash!==signed.messageHash || saved.playerSignature!==signed.playerSignature || saved.playerPublicKey!==signed.playerPublicKey || saved.txid!==signed.playerSignature)) throw new Error("RECONCILIATION_BINDING_MISMATCH");
  return saved;
}
/** The caller supplies final chain evidence from its pinned verifier; RECORDED is never final. */
export type FinalEvidence = {status:"unknown"}|{status:"confirmed"|"failed";commitment:"finalized";genesisHash:string;txid:string};
export async function finalizeOperation(client: AudaceFiClient,journal: FileJournal,key:string,verifyFinal:(saved:Readonly<Submission>,expected:Readonly<{genesisHash:string;origin:string}>)=>Promise<FinalEvidence>): Promise<"confirmed"|"failed"|"unknown"> {
  // One finalization at a time per operation, so the result write is neither duplicated nor contradicted.
  return journal.withFinalizationLock(key,async():Promise<"confirmed"|"failed"|"unknown">=>{
    const local=await journal.read(key),signed=local.events.find(e=>e.stage==="SIGNED"),last=local.events.at(-1)?.stage;
    if(local.reservation.origin!==client.origin)throw new Error("RECONCILIATION_ORIGIN_MISMATCH");
    if(last==="FINAL_CONFIRMED" || last==="FINAL_FAILED")return last==="FINAL_CONFIRMED"?"confirmed":"failed";
    if(!signed?.genesisHash)throw new Error("MISSING_NETWORK_BINDING");
    // A stop after SENDING left no response record: mark it ambiguous before any further remote write.
    if(last==="SENDING")await journal.append(key,{stage:"AMBIGUOUS",...(signed.intentId?{intentId:signed.intentId}:{})});
    const saved=await reconcileOperation(client,journal,key);
    if (!saved) return "unknown";
    const proof=await verifyFinal(freeze(saved),freeze({genesisHash:signed.genesisHash,origin:client.origin}));
    if(proof.status==="unknown")return "unknown";
    const status=proof.status;
    if ((status!=="confirmed" && status!=="failed") || proof.commitment!=="finalized" || proof.genesisHash!==signed.genesisHash || proof.txid!==saved.txid) throw new Error("INVALID_FINAL_EVIDENCE");
    const final:JournalEvent={stage:status==="confirmed"?"FINAL_CONFIRMED":"FINAL_FAILED",intentId:saved.intentId,txid:saved.txid};
    // Validate the local transition first: a result write must never be left unrecordable.
    await journal.check(key,final);
    await client.recordConfirmedResult(saved.intentId,status);
    await journal.append(key,final);
    return status;
  });
}

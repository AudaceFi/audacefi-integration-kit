import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudaceFiClient, ClientError, parseQuote, rawAmount } from "../src/client.ts";
import { runOperation, reconcileOperation, finalizeOperation, abandonOperation } from "../src/operation.ts";
import { FileJournal, unsafeJournalOwnership } from "../src/journal.ts";
import { digest } from "../src/canonical.ts";
import { inspectTransaction } from "../src/transaction.ts";
import { runAiAgent, runTradingBot } from "../src/operators.ts";
import { harness, journalFor, asset, syntheticId, clock } from "./connected-harness.ts";

for(const actor of ["ai_agent","trading_bot"] as const)test("connected lifecycle with local-only transport: "+actor,async t=>{
  const h=harness(actor),{journal,directory}=await journalFor(t);
  const {actor:ignored,...operation}=h.operation;
  const result=await (actor==="ai_agent"?runAiAgent:runTradingBot)({client:h.client,journal,operation,ports:h.ports,clock:()=>clock});
  assert.equal(result.state,"SUBMITTED");assert.deepEqual(h.calls.map(c=>c.path.split("/").at(-1)),["state","swap-intents","quote","signature","submit-durable"]);
  assert.equal((await reconcileOperation(h.client,journal,h.operation.operationKey))?.state,"RECORDED");
  assert.equal(await finalizeOperation(h.client,journal,h.operation.operationKey,async()=>({status:"unknown"})),"unknown");
  assert.equal(h.calls.some(c=>c.path.endsWith("/result")),false);
  assert.equal(await finalizeOperation(h.client,journal,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash})),"confirmed");
  const contents=(await Promise.all((await readdir(directory)).map(n=>readFile(join(directory,n),"utf8")))).join("");
  assert.equal(contents.includes("synthetic-access-token"),false);assert.equal(contents.includes('"transaction":'),false);
  assert.match(contents,/FINAL_CONFIRMED/);
});
test("lost response: reconcile exact signed operation, never submit a replacement",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.faults.lostSubmit=true;
  assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>clock)).state,"AMBIGUOUS");
  const count=h.calls.filter(c=>c.method==="POST").length;
  const saved=await reconcileOperation(h.client,journal,h.operation.operationKey);assert.equal(saved?.state,"RECORDED");
  await assert.rejects(runOperation(h.client,journal,h.operation,h.ports,()=>clock),/ALREADY_RESERVED/);
  await assert.rejects(runOperation(h.client,journal,{...h.operation,operationKey:"synthetic-new-key"},h.ports,()=>clock),/UNRESOLVED_OPERATION/);
  assert.equal(h.calls.filter(c=>c.method==="POST").length,count);
});
test("server replay on a fresh local reservation stops before quoting",async t=>{
  const h=harness(),{journal}=await journalFor(t);
  const client=new AudaceFiClient({origin:h.client.origin,credential:()=>"synthetic-access-token",writes:"explicitly-authorized",transport:async(url,init)=>new URL(url).pathname==="/v1/swap-intents"?new Response(JSON.stringify({intentId:syntheticId(2),status:"built",replayed:true}),{headers:{"content-type":"application/json"}}):h.transport(url,init)});
  assert.equal((await runOperation(client,journal,h.operation,h.ports,()=>clock)).state,"AMBIGUOUS");
  assert.equal(h.calls.some(c=>c.path.endsWith("/quote")),false);assert.equal(h.counts().signs,0);
  assert.deepEqual((await journal.read(h.operation.operationKey)).events.map(e=>e.stage),["INTENT","AMBIGUOUS"]);
  // Another journal may have signed this intention: it can never be closed locally.
  assert.equal((await journal.read(h.operation.operationKey)).events[0]?.replayed,true);
  await assert.rejects(abandonOperation(journal,h.operation.operationKey),/REPLAYED_OPERATION_RECONCILE/);
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"1",h.client.origin),/UNRESOLVED_OPERATION/);
});

test("a legacy intention with no recorded replay status cannot be abandoned or unlock a new key",async t=>{
  const h=harness(),{journal}=await journalFor(t);
  await journal.reserve(h.operation.operationKey,digest({legacy:true}),asset(1),"1",h.client.origin);
  await journal.append(h.operation.operationKey,{stage:"INTENT",intentId:syntheticId(2)});
  await journal.append(h.operation.operationKey,{stage:"AMBIGUOUS",intentId:syntheticId(2)});
  assert.equal((await journal.read(h.operation.operationKey)).events[0]?.replayed,undefined);
  await assert.rejects(abandonOperation(journal,h.operation.operationKey),/INTENT_REPLAY_STATUS_UNKNOWN/);
  assert.equal((await journal.read(h.operation.operationKey)).events.at(-1)?.stage,"AMBIGUOUS");
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"1",h.client.origin),/UNRESOLVED_OPERATION/);
});

test("a legacy signed journal remains reconcilable without rewriting its replay status",async t=>{
  const h=harness(),{journal,directory}=await journalFor(t);
  await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  const path=join(directory,digest({key:h.operation.operationKey})+".events");
  const events=(await readFile(path,"utf8")).trimEnd().split("\n").map(line=>JSON.parse(line) as {stage:string;replayed?:boolean});
  assert.equal(events[0]?.replayed,false);
  for(const event of events)if(event.stage==="INTENT")delete event.replayed;
  await writeFile(path,events.map(event=>JSON.stringify(event)).join("\n")+"\n");
  assert.equal((await journal.read(h.operation.operationKey)).events[0]?.replayed,undefined);
  assert.equal(await finalizeOperation(h.client,journal,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash})),"confirmed");
  assert.equal((await journal.read(h.operation.operationKey)).events.at(-1)?.stage,"FINAL_CONFIRMED");
  assert.equal(h.calls.filter(c=>c.path.endsWith("/result")).length,1);
});
test("finalization after a stop at SENDING records ambiguity before the result write",async t=>{
  const h=harness(),{journal,directory}=await journalFor(t),append=journal.append.bind(journal);
  journal.append=async(key,event)=>{if(event.stage!=="SENDING" && h.calls.some(c=>c.path.endsWith("/submit-durable")))throw new Error("synthetic process stop");return append(key,event);};
  await assert.rejects(runOperation(h.client,journal,h.operation,h.ports,()=>clock),/synthetic process stop/);
  const restarted=await FileJournal.create(directory,{maxOperations:2,inputBudgets:{[asset(1)]:"2000000"}});
  assert.equal((await restarted.read(h.operation.operationKey)).events.at(-1)?.stage,"SENDING");
  assert.equal(await finalizeOperation(h.client,restarted,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash})),"confirmed");
  assert.deepEqual((await restarted.read(h.operation.operationKey)).events.map(e=>e.stage).slice(-3),["SENDING","AMBIGUOUS","FINAL_CONFIRMED"]);
  assert.equal(h.calls.filter(c=>c.path.endsWith("/result")).length,1);
});
test("final result is never posted when the local journal cannot record it",async t=>{
  const h=harness(),{journal}=await journalFor(t),append=journal.append.bind(journal);
  journal.append=async(key,event)=>{if(event.stage==="SENDING" || event.stage==="AMBIGUOUS")throw new Error("synthetic process stop");return append(key,event);};
  await assert.rejects(runOperation(h.client,journal,h.operation,h.ports,()=>clock),/synthetic process stop/);
  const signed=(await journal.read(h.operation.operationKey)).events.find(e=>e.stage==="SIGNED")!;
  const proof={protocol:"audacefi.bench.submission.v1",intentId:signed.intentId,quoteId:signed.quoteId,quoteOutId:null,messageHash:signed.messageHash,playerSignature:signed.playerSignature,playerPublicKey:signed.playerPublicKey,txid:signed.playerSignature,recordedAt:new Date(clock).toISOString(),state:"RECORDED"};
  const client=new AudaceFiClient({origin:h.client.origin,credential:()=>"synthetic-access-token",writes:"explicitly-authorized",transport:async(url,init)=>new URL(url).pathname.endsWith("/submission")?new Response(JSON.stringify({protocol:"audacefi.bench.submission.v1",submission:proof}),{headers:{"content-type":"application/json"}}):h.transport(url,init)});
  await assert.rejects(finalizeOperation(client,journal,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash})),/JOURNAL_FINAL_BINDING_REQUIRED/);
  assert.equal(h.calls.some(c=>c.path.endsWith("/result")),false);
});
test("a refusal before any journaled signature can be closed locally, keeping its budget",async t=>{
  const h=harness(),{journal}=await journalFor(t,{maxOperations:3,inputBudgets:{[asset(1)]:"1500000"}});
  h.ports.sign=async()=>{throw new Error("synthetic wallet refusal");};
  const r=await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  assert.deepEqual([r.state,r.reason],["AMBIGUOUS","UNCLASSIFIED_FAILURE"]);
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"1",h.client.origin),/UNRESOLVED_OPERATION/);
  await abandonOperation(journal,h.operation.operationKey);
  await assert.rejects(journal.append(h.operation.operationKey,{stage:"AMBIGUOUS"}),/TERMINAL_JOURNAL_CONFLICT/);
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"500001",h.client.origin),/BUDGET_EXHAUSTED/);
  await journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"500000",h.client.origin);
});
test("an operation with a journaled signature cannot be abandoned",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.faults.rejectPath="/signature";
  const r=await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  assert.deepEqual([r.state,r.reason],["AMBIGUOUS","HTTP_503"]);
  await assert.rejects(abandonOperation(journal,h.operation.operationKey),/SIGNED_OPERATION_RECONCILE/);
});
test("a pre-send guard refusal or a timeout before transmission is not ambiguous",async()=>{
  let sent=0;const c=new AudaceFiClient({origin:"https://example.invalid",timeoutMs:20,writes:"explicitly-authorized",credential:()=>"synthetic-secret",transport:async()=>{sent++;return new Response("{}",{headers:{"content-type":"application/json"}});}});
  const input={seasonId:syntheticId(1),category:"degen" as const,tokenInMint:asset(1),tokenOutMint:asset(2),amountIn:1,idempotencyKey:"synthetic-key-1"};
  await assert.rejects(c.createIntent(input,()=>{throw new Error("synthetic guard refusal");}),e=>e instanceof ClientError&&e.code==="GUARD_REFUSED_BEFORE_SEND"&&!e.ambiguous);
  await assert.rejects(c.createIntent(input,async()=>{await new Promise(r=>setTimeout(r,60));}),e=>e instanceof ClientError&&e.code==="REQUEST_TIMEOUT"&&!e.ambiguous);
  await new Promise(r=>setTimeout(r,80));assert.equal(sent,0);
});
test("a held reservation lock is reported explicitly and never broken",async t=>{
  const {journal,directory}=await journalFor(t);
  await writeFile(join(directory,"reservation.lock"),"synthetic held lock\n");
  await assert.rejects(journal.reserve("synthetic-key",digest({a:1}),asset(1),"1","https://example.invalid"),/RESERVATION_LOCK_HELD/);
  assert.equal(await readFile(join(directory,"reservation.lock"),"utf8"),"synthetic held lock\n");
});
test("journal ownership check refuses shared or foreign POSIX directories",()=>{
  assert.equal(unsafeJournalOwnership({mode:0o40700,uid:1000},"linux",1000),false);
  for(const [mode,uid] of [[0o40755,1000],[0o40770,1000],[0o40707,1000],[0o40700,0]] as const)assert.equal(unsafeJournalOwnership({mode,uid},"linux",1000),true);
  assert.equal(unsafeJournalOwnership({mode:0o40777,uid:0},"win32",undefined),false);
});
test("journal creation refuses a group-accessible directory on POSIX",{skip:process.platform==="win32"?"POSIX modes are not enforced on Windows":false},async t=>{
  const base=await mkdtemp(join(tmpdir(),"audacefi-starter-permissions-"));t.after(()=>rm(base,{recursive:true,force:true}));
  const directory=join(base,"journal");await mkdir(directory);await chmod(directory,0o750);
  await assert.rejects(FileJournal.create(directory,{maxOperations:1,inputBudgets:{[asset(1)]:"1"}}),/UNSAFE_JOURNAL_PERMISSIONS/);
});
test("a create-intent refused before transmission closes the operation as UNSENT, keeping its budget",async t=>{
  const h=harness(),{journal}=await journalFor(t,{maxOperations:3,inputBudgets:{[asset(1)]:"1500000"}});
  let credentials=0;
  const client=new AudaceFiClient({origin:h.client.origin,transport:h.transport,writes:"explicitly-authorized",credential:()=>{if(++credentials===2)throw new Error("synthetic vault unavailable");return "synthetic-access-token";}});
  const r=await runOperation(client,journal,h.operation,h.ports,()=>clock);
  assert.deepEqual([r.state,r.intentId,r.reason],["UNSENT",null,"CREDENTIAL_UNAVAILABLE"]);
  assert.equal(h.calls.some(c=>c.method==="POST"),false);
  assert.deepEqual((await journal.read(h.operation.operationKey)).events.map(e=>e.stage),["UNSENT"]);
  await assert.rejects(journal.append(h.operation.operationKey,{stage:"AMBIGUOUS"}),/TERMINAL_JOURNAL_CONFLICT/);
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"500001",h.client.origin),/BUDGET_EXHAUSTED/);
  await journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"500000",h.client.origin);
});
test("a write that reached the transport is never UNSENT, even if the transport throws a non-ambiguous ClientError",async t=>{
  const h=harness(),{journal}=await journalFor(t);let creates=0;
  const client=new AudaceFiClient({origin:h.client.origin,credential:()=>"synthetic-access-token",writes:"explicitly-authorized",transport:async(url,init)=>{
    if(new URL(url).pathname==="/v1/swap-intents"){creates++;throw new ClientError("SYNTHETIC_UPSTREAM_RESET",null,false);}
    return h.transport(url,init);
  }});
  const r=await runOperation(client,journal,h.operation,h.ports,()=>clock);
  assert.deepEqual([r.state,r.reason,creates],["AMBIGUOUS","SYNTHETIC_UPSTREAM_RESET",1]);
  await assert.rejects(journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"1",h.client.origin),/UNRESOLVED_OPERATION/);
});
test("UNSENT can only be the first journal event",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.ports.sign=async()=>{throw new Error("synthetic wallet refusal");};
  await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  await assert.rejects(journal.append(h.operation.operationKey,{stage:"UNSENT"}),/INVALID_JOURNAL_ORDER/);
});
test("a read-only client is refused before any read or reservation",async t=>{
  const h=harness(),{journal}=await journalFor(t,{maxOperations:1,inputBudgets:{[asset(1)]:"1000000"}});
  const client=new AudaceFiClient({origin:h.client.origin,transport:h.transport,credential:()=>"synthetic-access-token"});
  await assert.rejects(runOperation(client,journal,h.operation,h.ports,()=>clock),/WRITES_NOT_AUTHORIZED/);
  assert.equal(h.calls.length,0);
  await journal.reserve("synthetic-next-key",digest({n:1}),asset(1),"1000000",h.client.origin);
});
test("finalization checks the reservation origin before any journal record",async t=>{
  const h=harness(),{journal,directory}=await journalFor(t),append=journal.append.bind(journal);
  journal.append=async(key,event)=>{if(event.stage!=="SENDING" && h.calls.some(c=>c.path.endsWith("/submit-durable")))throw new Error("synthetic process stop");return append(key,event);};
  await assert.rejects(runOperation(h.client,journal,h.operation,h.ports,()=>clock),/synthetic process stop/);
  const restarted=await FileJournal.create(directory,{maxOperations:2,inputBudgets:{[asset(1)]:"2000000"}});
  const other=new AudaceFiClient({origin:"https://different.invalid",transport:h.transport,writes:"explicitly-authorized",credential:()=>"synthetic-access-token"});
  await assert.rejects(finalizeOperation(other,restarted,h.operation.operationKey,async()=>({status:"unknown"})),/RECONCILIATION_ORIGIN_MISMATCH/);
  assert.equal((await restarted.read(h.operation.operationKey)).events.at(-1)?.stage,"SENDING");
});
test("an operation whose intention was never journaled cannot be abandoned",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.faults.rejectPath="/swap-intents";
  const r=await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  assert.deepEqual([r.state,r.intentId,r.reason],["AMBIGUOUS",null,"HTTP_503"]);
  await assert.rejects(abandonOperation(journal,h.operation.operationKey),/INTENT_UNKNOWN_MANUAL_RECONCILIATION/);
});
test("a held append lock blocks journal writes, including abandonment, and is never broken",async t=>{
  const h=harness(),{journal,directory}=await journalFor(t);h.ports.sign=async()=>{throw new Error("synthetic wallet refusal");};
  await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  const lock=join(directory,digest({key:h.operation.operationKey})+".append.lock");await writeFile(lock,"synthetic held lock\n");
  await assert.rejects(abandonOperation(journal,h.operation.operationKey),/JOURNAL_APPEND_LOCK_HELD/);
  assert.equal(await readFile(lock,"utf8"),"synthetic held lock\n");
});
test("concurrent or repeated finalization sends one result write",async t=>{
  const h=harness(),{journal}=await journalFor(t);await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  let entered=()=>{},release=()=>{};
  const inVerifier=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const slow:Parameters<typeof finalizeOperation>[3]=async(saved,expected)=>{entered();await gate;return {status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash};};
  const first=finalizeOperation(h.client,journal,h.operation.operationKey,slow);
  await inVerifier;
  await assert.rejects(finalizeOperation(h.client,journal,h.operation.operationKey,async(saved,expected)=>({status:"failed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash})),/FINALIZATION_LOCK_HELD/);
  release();assert.equal(await first,"confirmed");
  assert.equal(await finalizeOperation(h.client,journal,h.operation.operationKey,async()=>{throw new Error("verifier must not run again");}),"confirmed");
  assert.equal(h.calls.filter(c=>c.path.endsWith("/result")).length,1);
});
test("failure reason keeps codes but never long tokens or free text",async t=>{
  for(const [message,expected] of [["ABCDEF0123456789".repeat(4),"UNCLASSIFIED_FAILURE"],["AFK_ABCDEFGHIJKLMNOPQRSTUV_X","UNCLASSIFIED_FAILURE"],["Synthetic plan refusal","UNCLASSIFIED_FAILURE"],["SYNTHETIC_PLAN_REFUSED","SYNTHETIC_PLAN_REFUSED"]] as const){
    const h=harness(),{journal}=await journalFor(t);h.ports.verifyPlan=async()=>{throw new Error(message);};
    assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>clock)).reason,expected);
  }
});
test("idempotency key cannot be rebound to another input",async t=>{
  const {journal}=await journalFor(t);
  await journal.reserve("synthetic-key",digest({input:1}),asset(1),"1","https://audacefi.synthetic.invalid");
  await assert.rejects(journal.reserve("synthetic-key",digest({input:2}),asset(1),"1","https://audacefi.synthetic.invalid"),/PAYLOAD_CONFLICT/);
});
test("durable budgets survive re-open and forbid policy changes",async t=>{
  const policy={maxOperations:2,inputBudgets:{[asset(1)]:"1000000"}},h=harness(),{journal,directory}=await journalFor(t,policy);
  await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  await finalizeOperation(h.client,journal,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash}));
  const again=await FileJournal.create(directory,policy);
  await assert.rejects(again.reserve("synthetic-operation-two",digest({x:2}),asset(1),"1",h.client.origin),/BUDGET_EXHAUSTED/);
  await assert.rejects(FileJournal.create(directory,{...policy,maxOperations:3}),/POLICY_CHANGED/);
});
for(const fault of ["stale","wallet","window","network","mapping","expiry","plan","signature","wrong-amount"] as const)test("refuse before transmission: "+fault,async t=>{
  const h=harness(),{journal}=await journalFor(t);
  if(fault==="stale")h.faults.stateEdit=v=>{v.asOf=new Date(clock-120001).toISOString();};
  if(fault==="wallet")h.faults.stateEdit=v=>{v.wallet.walletAddress=asset(9);};
  if(fault==="window")h.faults.stateEdit=v=>{v.season.active.endsAt=new Date(clock).toISOString();};
  if(fault==="network")h.ports.verifyTarget=async()=>({...h.target,observedGenesis:asset(9)});
  if(fault==="mapping")h.faults.quoteEdit=v=>{v.mintDevnet=asset(9);};
  if(fault==="expiry")h.faults.quoteEdit=v=>{v.expiresAt=new Date(clock).toISOString();};
  if(fault==="plan")h.ports.verifyPlan=async()=>{throw new Error("Synthetic plan refusal");};
  if(fault==="signature"){const original=h.ports.sign;h.ports.sign=async v=>{const s=await original(v);return {...s,signature:"1".repeat(88)};};}
  if(fault==="wrong-amount")h.operation.amountInRaw="1000001";
  // Context and input faults refuse before any reservation; later faults are journaled as AMBIGUOUS.
  const before={stale:/STATE_NOT_EXECUTABLE/,wallet:/STATE_NOT_EXECUTABLE/,window:/STATE_NOT_EXECUTABLE/,network:/UNVERIFIED_TARGET/,"wrong-amount":/AMOUNT_UNIT_MISMATCH/} as Record<string,RegExp>;
  if(before[fault])await assert.rejects(runOperation(h.client,journal,h.operation,h.ports,()=>clock),before[fault]);
  else assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>clock)).state,"AMBIGUOUS");
  assert.equal(h.calls.some(c=>c.path.endsWith("/submit-durable")),false);
});
test("no durable route means fail closed; no fallback executor",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.faults.rejectPath="/submit-durable";
  const r=await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  assert.equal(r.state,"AMBIGUOUS");
  assert.deepEqual(h.calls.filter(c=>c.method==="POST").map(c=>c.path.split("/").at(-1)),["swap-intents","quote","signature","submit-durable"]);
});
test("unbound submission response is ambiguous, not success",async t=>{
  const h=harness(),{journal}=await journalFor(t);h.faults.badSubmitBinding=true;
  assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>clock)).state,"AMBIGUOUS");
});
test("reconciliation will not send credentials to a new origin",async t=>{
  const h=harness(),{journal}=await journalFor(t);await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  let calls=0;const client=new AudaceFiClient({origin:"https://different.invalid",credential:()=>{calls++;return "synthetic-secret";},transport:h.transport});
  await assert.rejects(reconcileOperation(client,journal,h.operation.operationKey),/ORIGIN_MISMATCH/);assert.equal(calls,0);
});
test("HTTPS origin only, no credentials, paths, fragments or query",()=>{
  for(const origin of ["http://example.invalid","https://user:secret@example.invalid","https://example.invalid/path","https://example.invalid/?key=x","https://example.invalid/#key"])
    assert.throws(()=>new AudaceFiClient({origin,credential:()=>"synthetic-secret"}));
});
test("writes off by default, secret never in error or serialized client",async()=>{
  const h=harness(),secret="synthetic-access-private";
  const client=new AudaceFiClient({origin:h.client.origin,credential:()=>secret,transport:async()=>{throw new Error(secret);}});
  await assert.rejects(client.readState("degen"),e=>e instanceof ClientError&&!JSON.stringify(e).includes(secret)&&!e.message.includes(secret)&&!("cause"in e));
  await assert.rejects(client.createIntent({...h.operation,idempotencyKey:h.operation.operationKey}),/WRITES_NOT_AUTHORIZED/);
  assert.equal(JSON.stringify(client).includes(secret),false);
});
for(const kind of ["size-header","size-stream","utf8","content-type","redirect","post-schema","429","timeout"] as const)test("bounded transport failure: "+kind,async()=>{
  const h=harness();let calls=0;
  const client=new AudaceFiClient({origin:h.client.origin,credential:()=>"synthetic-access-token",maxResponseBytes:128,timeoutMs:10,writes:"explicitly-authorized",transport:async()=>{
    calls++;
    if(kind==="timeout")return new Promise(()=>{});
    if(kind==="429")return new Response("private-body",{status:429});
    if(kind==="redirect"){const r=new Response("{}",{headers:{"content-type":"application/json"}});Object.defineProperty(r,"redirected",{value:true});return r;}
    if(kind==="size-header")return new Response("{}",{headers:{"content-type":"application/json","content-length":"129"}});
    if(kind==="size-stream")return new Response("x".repeat(129),{headers:{"content-type":"application/json"}});
    if(kind==="utf8")return new Response(new Uint8Array([255]),{headers:{"content-type":"application/json"}});
    if(kind==="content-type")return new Response("{}",{headers:{"content-type":"text/html"}});
    return new Response("{}",{headers:{"content-type":"application/json"}});
  }});
  await assert.rejects(client.createIntent({...h.operation,idempotencyKey:h.operation.operationKey}),e=>e instanceof ClientError&&e.ambiguous);
  assert.equal(calls,1);
});
test("credential resolution timeout never sends a late request",async()=>{
  let calls=0;const c=new AudaceFiClient({origin:"https://example.invalid",timeoutMs:5,credential:async()=>{await new Promise(r=>setTimeout(r,20));return "synthetic-secret";},transport:async()=>{calls++;throw new Error();}});
  await assert.rejects(c.readState("degen"),/TIMEOUT/);await new Promise(r=>setTimeout(r,25));assert.equal(calls,0);
});
test("route quote preserves two leg IDs and integer fee math",()=>{
  const q={kind:"route",intentId:syntheticId(2),quoteId:syntheticId(3),quoteIdOut:syntheticId(4),mintInMainnet:asset(1),mintInDevnet:asset(2),mintOutMainnet:asset(3),mintOutDevnet:asset(4),amountInRaw:"1000",priceIn:{price:"1",expo:0,priceUsd:1},priceOut:{price:"1",expo:0,priceUsd:1},amountOutGrossRaw:"1000",feeRaw:"2",amountOutNetRaw:"998",feeBps:20,expiresAt:new Date(clock+60000).toISOString(),ttlSeconds:60};
  assert.equal(parseQuote(q).kind,"route");assert.throws(()=>parseQuote({...q,amountOutNetRaw:"999"}));
  for(const value of ["0","01","1.1","-1","18446744073709551616"])assert.throws(()=>rawAmount(value));
});
test("journal partial record/link cannot be silently treated as absent",async t=>{
  const {journal,directory}=await journalFor(t);
  await journal.reserve("synthetic-key",digest({a:1}),asset(1),"1","https://example.invalid");
  const keyHash=digest({key:"synthetic-key"});await writeFile(join(directory,keyHash+".events"),'{"stage":');
  await assert.rejects(journal.read("synthetic-key"),/PARTIAL_JOURNAL/);
  await writeFile(join(directory,keyHash+".events"),'{}\n');await assert.rejects(journal.read("synthetic-key"),/CORRUPT_JOURNAL/);
});
test("legacy envelope rejects modified message, unexpected programs and trailing bytes",async()=>{
  const h=harness(),encoded=await h.ports.build(h.operation,parseQuote(h.quote),h.target);
  const signed=await h.ports.sign(encoded);
  assert.ok(inspectTransaction(signed.transaction,h.operation.playerPublicKey,h.target.allowedPrograms,true).messageHash);
  const raw=Buffer.from(signed.transaction,"base64");raw[raw.length-1]=raw[raw.length-1]!^1;
  assert.throws(()=>inspectTransaction(raw.toString("base64"),h.operation.playerPublicKey,h.target.allowedPrograms,true),/SIGNATURE/);
  assert.throws(()=>inspectTransaction(encoded,h.operation.playerPublicKey,[asset(9)],false),/UNEXPECTED_PROGRAM/);
  assert.throws(()=>inspectTransaction(Buffer.concat([Buffer.from(encoded,"base64"),Buffer.from([0])]).toString("base64"),h.operation.playerPublicKey,h.target.allowedPrograms,false),/TRAILING/);
});
test("final evidence must identify the exact signature and pinned genesis at finalized commitment",async t=>{
  const h=harness(),{journal}=await journalFor(t);await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  await assert.rejects(finalizeOperation(h.client,journal,h.operation.operationKey,async saved=>({status:"confirmed",commitment:"finalized",genesisHash:asset(9),txid:saved.txid})),/INVALID_FINAL_EVIDENCE/);
  assert.equal(h.calls.some(c=>c.path.endsWith("/result")),false);
});
test("late signing invalidates the quote without any submit",async t=>{
  const h=harness(),{journal}=await journalFor(t),original=h.ports.sign;let now=clock;
  h.ports.sign=async raw=>{const result=await original(raw);now=clock+60001;return result;};
  assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>now)).state,"AMBIGUOUS");
  assert.equal(h.calls.some(c=>c.path.endsWith("/submit-durable")),false);
});
for(const point of ["sign","journal","credential"] as const)test("plan observations expire across await: "+point,async t=>{
  const h=harness(),{journal}=await journalFor(t);let now=clock;
  const inspect=h.ports.verifyPlan;
  h.ports.verifyPlan=async(...args)=>({...await inspect(...args),balanceObservedAtMs:clock-110000,eligibilityObservedAtMs:clock-110000,blockhashObservedAtMs:clock-110000});
  if(point==="sign"){const sign=h.ports.sign;h.ports.sign=async raw=>{const out=await sign(raw);now+=20000;return out;};}
  if(point==="journal"){const append=journal.append.bind(journal);journal.append=async(key,event)=>{await append(key,event);if(event.stage==="SENDING")now+=20000;};}
  let credentials=0;
  const client=point==="credential"?new AudaceFiClient({origin:h.client.origin,transport:h.transport,writes:"explicitly-authorized",credential:()=>{credentials++;if(credentials===5)now+=20000;return "synthetic-token";}}):h.client;
  assert.equal((await runOperation(client,journal,h.operation,h.ports,()=>now)).state,"AMBIGUOUS");
  assert.equal(h.calls.some(c=>c.path.endsWith("/submit-durable")),false);
});
for(const corrupt of ["event-prefix","reservation-origin"] as const)test("new admissions validate full old ledger: "+corrupt,async t=>{
  const h=harness(),{journal,directory}=await journalFor(t);
  await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  await finalizeOperation(h.client,journal,h.operation.operationKey,async(saved,expected)=>({status:"confirmed",commitment:"finalized",txid:saved.txid,genesisHash:expected.genesisHash}));
  const file=join(directory,digest({key:h.operation.operationKey})+(corrupt==="event-prefix"?".events":".json"));
  const previous=await readFile(file,"utf8");
  if(corrupt==="event-prefix")await writeFile(file,"not-valid-json\n"+previous);
  else{const value=JSON.parse(previous);delete value.origin;await writeFile(file,JSON.stringify(value));}
  await assert.rejects(journal.read(h.operation.operationKey));
  await assert.rejects(journal.reserve("synthetic-new-operation",digest({a:1}),asset(1),"1",h.client.origin));
});
test("two-leg connected path sends quoteIdOut under the wire quoteOutId name",async t=>{
  const h=harness(),{journal}=await journalFor(t,{maxOperations:1,inputBudgets:{[asset(2)]:"2000000"}});
  h.operation.tokenInMint=asset(2);h.operation.tokenOutMint=asset(5);
  h.target.mappings.push({mainnet:asset(5),devnet:asset(6),decimals:6});
  h.faults.quoteEdit=q=>{
    for(const k of ["mintMainnet","mintDevnet","direction","price","expo","priceUsd"])delete q[k];
    Object.assign(q,{kind:"route",quoteIdOut:syntheticId(4),mintInMainnet:asset(2),mintInDevnet:asset(4),mintOutMainnet:asset(5),mintOutDevnet:asset(6),priceIn:{price:"1",expo:0,priceUsd:1},priceOut:{price:"1",expo:0,priceUsd:1},amountOutGrossRaw:"1000",feeRaw:"2",feeBps:20,amountOutNetRaw:"998"});
  };
  assert.equal((await runOperation(h.client,journal,h.operation,h.ports,()=>clock)).state,"SUBMITTED");
  const request=h.calls.find(c=>c.path.endsWith("/submit-durable"))!.body;
  assert.equal(request.quoteOutId,syntheticId(4));assert.equal("quoteIdOut"in request,false);
});
for(const shape of ["missing-fields","wrong-txid","wrong-order"] as const)test("terminal journal evidence cannot be fabricated by a final label: "+shape,async t=>{
  const h=harness(),{journal,directory}=await journalFor(t);await runOperation(h.client,journal,h.operation,h.ports,()=>clock);
  const file=join(directory,digest({key:h.operation.operationKey})+".events");
  let history=await readFile(file,"utf8");
  if(shape==="wrong-order")history="";
  const event=shape==="missing-fields"?{stage:"FINAL_CONFIRMED"}:{stage:"FINAL_CONFIRMED",intentId:syntheticId(2),txid:"1".repeat(88)};
  await writeFile(file,history+JSON.stringify(event)+"\n");
  await assert.rejects(journal.read(h.operation.operationKey));
  await assert.rejects(journal.reserve("synthetic-fresh-operation",digest({fresh:true}),asset(1),"1",h.client.origin));
});

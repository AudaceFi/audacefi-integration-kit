import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { AudaceFiClient, type FetchPort, type Submission } from "../src/client.ts";
import { FileJournal, type JournalPolicy } from "../src/journal.ts";
import { inspectTransaction } from "../src/transaction.ts";
import type { Operation, OperatorPorts, VerifiedTarget } from "../src/operation.ts";
import { digest } from "../src/canonical.ts";
import { frame, clock } from "./helpers.ts";
export { clock };
export const syntheticId=(n:number)=>[String(n).padStart(8,"0"),"0000","4000","8000","000000000000"].join("-");
export function encode58(bytes:Uint8Array):string {
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n=BigInt("0x"+Buffer.from(bytes).toString("hex")),s="";
  while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}
  for(const byte of bytes){if(byte!==0)break;s="1"+s;}
  return s;
}
export const asset=(n:number)=>encode58(Buffer.alloc(32,n));
export async function journalFor(t:TestContext,policy:JournalPolicy={maxOperations:2,inputBudgets:{[asset(1)]:"2000000"}}) {
  const directory=await mkdtemp(join(tmpdir(),"audacefi-starter-connected-"));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+"audacefi-starter-connected-"));await rm(directory,{recursive:true,force:true});});
  return {directory,journal:await FileJournal.create(directory,policy)};
}
export function harness(actor:Operation["actor"]="trading_bot") {
  const pair=generateKeyPairSync("ed25519");
  const payer=Buffer.from(pair.publicKey.export({type:"spki",format:"der"})).subarray(-32);
  const player=encode58(payer),program=asset(7);
  const operation:Operation={actor,operationKey:"synthetic-operation-one",seasonId:syntheticId(1),category:"crypto-bro",playerPublicKey:player,tokenInMint:asset(1),tokenOutMint:asset(2),amountIn:1,amountInRaw:"1000000",inputDecimals:6};
  const state=frame().state;
  state.season.active.id=operation.seasonId;state.wallet.seasonId=operation.seasonId;state.wallet.walletAddress=player;
  const target:VerifiedTarget={network:"devnet",expectedGenesis:asset(8),observedGenesis:asset(8),durableProtocol:"audacefi.bench.submission.v1",usdcMainnet:asset(1),allowedPrograms:[program],mappings:[{mainnet:asset(1),devnet:asset(3),decimals:6},{mainnet:asset(2),devnet:asset(4),decimals:6}]};
  const quote={intentId:syntheticId(2),quoteId:syntheticId(3),mintMainnet:asset(2),mintDevnet:asset(4),direction:"buy",amountInRaw:operation.amountInRaw,price:"1",expo:0,priceUsd:1,expiresAt:new Date(clock+60000).toISOString(),ttlSeconds:60};
  const calls:{path:string;method:string;body:any}[]=[];
  let saved:Submission|null=null,playerSignature="",builds=0,signs=0;
  const faults={lostSubmit:false,badSubmitBinding:false,rejectPath:"",stateEdit:null as null|((v:any)=>void),quoteEdit:null as null|((v:any)=>void)};
  const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json"}});
  const transport:FetchPort=async(url,init)=>{
    const path=new URL(url).pathname,method=init.method!,body=init.body?JSON.parse(String(init.body)):null;
    assert.equal(init.redirect,"error");assert.equal(init.credentials,"omit");
    calls.push({path,method,body});
    if(faults.rejectPath && path.endsWith(faults.rejectPath))return json({message:"private-body-not-retained"},503);
    if(path==="/v1/me/state"){const v=structuredClone(state);faults.stateEdit?.(v);return json(v);}
    if(path==="/v1/swap-intents"){assert.equal(body.category,"crypto_bro");assert.equal(body.surface,"api");return json({intentId:syntheticId(2),status:"built",replayed:false});}
    if(path.endsWith("/quote")){const v=structuredClone(quote);faults.quoteEdit?.(v);return json(v);}
    if(path.endsWith("/signature")){playerSignature=body.signature;return json({intentId:syntheticId(2),status:"signed"});}
    if(path.endsWith("/submit-durable")){
      const checked=inspectTransaction(body.transaction,player,target.allowedPrograms,true);
      saved={protocol:"audacefi.bench.submission.v1",intentId:syntheticId(2),quoteId:body.quoteId,quoteOutId:body.quoteOutId??null,messageHash:checked.messageHash,playerSignature,playerPublicKey:player,txid:playerSignature,recordedAt:new Date(clock).toISOString(),state:"SUBMITTED"};
      if(faults.lostSubmit)throw new Error("transport-failure-private-material");
      return json(faults.badSubmitBinding?{...saved,messageHash:"0".repeat(64)}:saved);
    }
    if(path.endsWith("/submission"))return json({protocol:"audacefi.bench.submission.v1",submission:saved?{...saved,state:"RECORDED"}:null});
    if(path.endsWith("/result"))return json({intentId:syntheticId(2),status:body.status});
    throw new Error("unexpected simulated route");
  };
  const ports:OperatorPorts={
    verifyTarget:async()=>structuredClone(target),
    build:async()=>{
      builds++;
      const data=Buffer.alloc(8);data.writeBigUInt64LE(BigInt(operation.amountInRaw));
      const message=Buffer.concat([Buffer.from([2,1,1,3]),payer,Buffer.alloc(32,6),Buffer.alloc(32,7),Buffer.alloc(32,8),Buffer.from([1,2,1,0,8]),data]);
      return Buffer.concat([Buffer.from([2]),Buffer.alloc(128),message]).toString("base64");
    },
    verifyPlan:async(encoded,o,q,t)=>{
      assert.equal(Buffer.from(encoded,"base64").readBigUInt64LE(Buffer.from(encoded,"base64").length-8),BigInt(operation.amountInRaw));
      return {operationHash:digest(o),quoteId:q.quoteId,messageHash:inspectTransaction(encoded,player,t.allowedPrograms,false).messageHash,genesisHash:t.expectedGenesis,balanceObservedAtMs:clock,eligibilityObservedAtMs:clock,blockhashObservedAtMs:clock,inputBalanceRaw:"2000000",gasBalanceLamports:"10000",requiredGasLamports:"5000",eligible:true};
    },
    sign:async encoded=>{
      signs++;
      const raw=Buffer.from(encoded,"base64"),signature=signBytes(null,raw.subarray(129),pair.privateKey);
      signature.copy(raw,1);
      return {transaction:raw.toString("base64"),signature:encode58(signature)};
    },
  };
  const client=new AudaceFiClient({origin:"https://audacefi.synthetic.invalid",credential:()=>"synthetic-access-token",transport,writes:"explicitly-authorized"});
  return {client,transport,operation,ports,state,target,quote,calls,faults,counts:()=>({builds,signs})};
}

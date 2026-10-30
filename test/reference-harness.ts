import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { AudaceFiClient, type FetchPort } from "../src/client.ts";
import { createReferenceAdapters } from "../src/reference.ts";
import { SolanaRpcReader } from "../src/rpc.ts";
import type { BenchProfile } from "../src/bench.ts";
import { benchAddresses } from "../src/bench.ts";
import { associatedAddress, ASSOCIATED_TOKEN_PROGRAM, CLOCK_SYSVAR, decode58, discriminator, encode58, hashBytes, SYSTEM_PROGRAM, SYSVAR_OWNER, TOKEN_PROGRAM, UPGRADEABLE_LOADER } from "../src/solana.ts";
import { asset, clock, harness, syntheticId } from "./connected-harness.ts";

export type ReferenceKind = "buy" | "sell" | "route";
export function referenceHarness(kind: ReferenceKind = "buy", actor: "ai_agent" | "trading_bot" = "trading_bot") {
  const old = harness(actor), poster = generateKeyPairSync("ed25519");
  const posterKey = encode58(Buffer.from(poster.publicKey.export({ type: "spki", format: "der" })).subarray(-32));
  const programData = Buffer.alloc(85); programData.writeUInt32LE(3); programData.writeBigUInt64LE(1n, 4); programData[12] = 1; decode58(asset(90), 32).copy(programData, 13); Buffer.from("synthetic-code-only").copy(programData, 45);
  const profile: BenchProfile = { apiOrigin: old.client.origin, expectedGenesis: asset(8), programId: asset(7), programData: asset(89), programDataSha256: hashBytes(programData), admin: asset(90), poster: posterKey, freshnessSeconds: 900, usdcMainnet: asset(1), mappings: [{ mainnet: asset(1), devnet: asset(3), decimals: 6 }, { mainnet: asset(2), devnet: asset(4), decimals: 6 }, { mainnet: asset(5), devnet: asset(6), decimals: 9 }], apiApproval: { protocol: "audacefi.bench.submission.v1", validFromMs: clock - 60000, expiresAtMs: clock + 600000 } };
  old.target.allowedPrograms = [profile.programId, ASSOCIATED_TOKEN_PROGRAM];
  const o = old.operation;
  if (kind !== "buy") { o.tokenInMint = asset(2); o.tokenOutMint = kind === "sell" ? asset(1) : asset(5); }
  const input = profile.mappings.find(m => m.mainnet === o.tokenInMint)!, output = profile.mappings.find(m => m.mainnet === o.tokenOutMint)!;
  const single = { ...old.quote, price: "2", priceUsd: 2, direction: kind === "sell" ? "sell" : "buy" };
  const route = { kind: "route", intentId: syntheticId(2), quoteId: syntheticId(3), quoteIdOut: syntheticId(4), mintInMainnet: input.mainnet, mintInDevnet: input.devnet, mintOutMainnet: output.mainnet, mintOutDevnet: output.devnet, amountInRaw: o.amountInRaw, priceIn: { price: "3", expo: 0, priceUsd: 3 }, priceOut: { price: "2", expo: 0, priceUsd: 2 }, amountOutGrossRaw: "1500000000", feeRaw: "3000000", feeBps: 20, amountOutNetRaw: "1497000000", expiresAt: old.quote.expiresAt, ttlSeconds: 60 };
  const quoteWire: any = kind === "route" ? route : single;
  const a = benchAddresses(profile), accounts = new Map<string, any>();
  const row = (owner: string, bytes: Buffer, lamports = 10000000, executable = false) => ({ owner, executable, lamports, data: [bytes.toString("base64"), "base64"] });
  const program = Buffer.alloc(36); program.writeUInt32LE(2); decode58(profile.programData, 32).copy(program, 4);
  accounts.set(profile.programId, row(UPGRADEABLE_LOADER, program, 10000000, true)); accounts.set(profile.programData, row(UPGRADEABLE_LOADER, programData));
  const config = Buffer.alloc(115); discriminator("account", "BenchConfig").copy(config); decode58(profile.admin, 32).copy(config, 8); decode58(profile.poster, 32).copy(config, 40); decode58(asset(3), 32).copy(config, 72); config.writeBigInt64LE(900n, 104); config[112] = a.config.bump; config[113] = a.vault.bump; config[114] = a.fee.bump;
  accounts.set(a.config.address, row(profile.programId, config)); accounts.set(profile.poster, row(SYSTEM_PROGRAM, Buffer.alloc(0))); accounts.set(o.playerPublicKey, row(SYSTEM_PROGRAM, Buffer.alloc(0)));
  function putToken(owner: string, mint: string, amount = 100000000000n) { const b = Buffer.alloc(165); decode58(mint, 32).copy(b); decode58(owner, 32).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; const address = associatedAddress(owner, mint); accounts.set(address, row(TOKEN_PROGRAM, b)); return address; }
  for (const m of profile.mappings) {
    const mint = Buffer.alloc(82); mint[44] = m.decimals; mint[45] = 1; accounts.set(m.devnet, row(TOKEN_PROGRAM, mint));
    putToken(o.playerPublicKey, m.devnet); putToken(a.vault.address, m.devnet); putToken(a.fee.address, m.devnet);
    const pda = a.price(m.devnet), bytes = Buffer.alloc(69); discriminator("account", "PriceAccount").copy(bytes); decode58(m.devnet, 32).copy(bytes, 8); bytes.writeBigUInt64LE(99n, 40); bytes[68] = pda.bump; accounts.set(pda.address, row(profile.programId, bytes));
  }
  let time = clock, blockHeight = 500, signed = false, walletCalls = 0, keyCalls = 0, credentialCalls = 0;
  const rpcCalls: { method: string; params: any[] }[] = [];
  const controls = { rpcGenesis: profile.expectedGenesis, rpcSlot: 500, blockhashValid: true, finalStatus: "finalized", finalError: null as any, finalMissing: false, walletKey: o.playerPublicKey, mutateMessage: false, expireAfterKey: false, expireCredentialAfterSign: false, expireApprovalAtCredential: 0, revokeAfterSign: false, expireBlockhashAfterSign: false, loseFundsAfterSign: false };
  const allowlist: any = { seasonId: o.seasonId, category: "crypto_bro", allowlistFrozen: true, tokens: profile.mappings.map(m => ({ mint: m.mainnet, decimals: m.decimals, exempt: m.mainnet === profile.usdcMainnet, eligible: m.mainnet !== profile.usdcMainnet })) };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const apiTransport: FetchPort = async (url, init) => {
    assert.equal((init.headers as any).Authorization, "Bearer synthetic-api-credential");
    const target = new URL(url);
    if (target.pathname.endsWith("/allowlist")) { old.calls.push({ path: target.pathname, method: "GET", body: null }); assert.equal(target.searchParams.get("category"), "crypto_bro"); assert.equal(target.searchParams.get("mode"), "real"); return json(allowlist); }
    if (target.pathname.endsWith("/quote")) { old.calls.push({ path: target.pathname, method: init.method!, body: JSON.parse(String(init.body)) }); return json(quoteWire); }
    return old.transport(url, init);
  };
  const client = new AudaceFiClient({ origin: profile.apiOrigin, credential: () => { credentialCalls++; if (signed && controls.expireCredentialAfterSign) time += 62000; if (credentialCalls === controls.expireApprovalAtCredential) time = profile.apiApproval.expiresAtMs; return "synthetic-api-credential"; }, writes: "explicitly-authorized", transport: apiTransport });
  const rawRpc = async (method: string, params: any[]) => {
    rpcCalls.push({ method, params: structuredClone(params) });
    const ctx = (value: unknown) => ({ context: { slot: controls.rpcSlot }, value });
    if (method === "getGenesisHash") return controls.rpcGenesis;
    if (method === "getLatestBlockhash") return ctx({ blockhash: asset(80), lastValidBlockHeight: 1000 });
    if (method === "getBlockHeight") return blockHeight;
    if (method === "isBlockhashValid") return ctx(controls.blockhashValid);
    if (method === "getMultipleAccounts") {
      const c = Buffer.alloc(40); c.writeBigUInt64LE(BigInt(controls.rpcSlot)); c.writeBigInt64LE(BigInt(Math.floor(time / 1000)), 32); accounts.set(CLOCK_SYSVAR, row(SYSVAR_OWNER, c));
      return ctx(params[0].map((key: string) => structuredClone(accounts.get(key) ?? null)));
    }
    if (method === "getFeeForMessage") return ctx(10000);
    if (method === "getMinimumBalanceForRentExemption") return params[0] === 165 ? 2000000 : 1000000;
    if (method === "getSignatureStatuses") return ctx([controls.finalMissing ? null : { slot: controls.rpcSlot, confirmationStatus: controls.finalStatus, confirmations: controls.finalStatus === "finalized" ? null : 1, err: controls.finalError }]);
    if (method === "getTransaction") {
      if (controls.finalMissing) return null;
      const submitted = old.calls.find(c => c.path.endsWith("/submit-durable"))?.body.transaction;
      if (!submitted) return null;
      const bytes = Buffer.from(submitted, "base64"); sign(null, bytes.subarray(129), poster.privateKey).copy(bytes, 65);
      return { slot: controls.rpcSlot, version: "legacy", transaction: [bytes.toString("base64"), "base64"], meta: { err: controls.finalError } };
    }
    throw new Error("UNEXPECTED_SYNTHETIC_RPC_METHOD");
  };
  const rpcTransport: FetchPort = async (url, init) => { assert.equal(url, "https://solana.synthetic.invalid/"); assert.equal((init.headers as any).Authorization, "Bearer synthetic-rpc-credential"); const body = JSON.parse(String(init.body)); return json({ jsonrpc: "2.0", id: body.id, result: await rawRpc(body.method, body.params) }); };
  const rpc = new SolanaRpcReader({ endpoint: "https://solana.synthetic.invalid/", transport: rpcTransport, bearer: () => "synthetic-rpc-credential" });
  const wallet = {
    publicKey: async () => { keyCalls++; if (controls.expireAfterKey) time += 62000; return controls.walletKey; },
    signTransaction: async (encoded: string) => {
      walletCalls++; let input = encoded;
      if (controls.mutateMessage) { const raw = Buffer.from(encoded, "base64"); raw[raw.length - 1] = raw[raw.length - 1]! ^ 1; input = raw.toString("base64"); }
      const value = await old.ports.sign(input); signed = true;
      if (controls.revokeAfterSign) allowlist.allowlistFrozen = false;
      if (controls.expireBlockhashAfterSign) blockHeight = 1001;
      if (controls.loseFundsAfterSign) putToken(o.playerPublicKey, profile.mappings.find(m => m.mainnet === o.tokenInMint)!.devnet, 0n);
      return value.transaction;
    },
  };
  const suite = createReferenceAdapters({ profile, client, rpc, wallet, clock: () => time });
  return { ...old, client, rpc, rpcTransport, rawRpc, profile, suite, wallet, accounts, allowlist, quoteWire, controls, putToken, counts: () => ({ walletCalls, keyCalls, rpc: rpcCalls.length, api: old.calls.length }), rpcCalls, getNow: () => time, setNow: (n: number) => { time = n; } };
}

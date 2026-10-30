import { integer } from "./contract.ts";
import { rawAmount, type Quote } from "./client.ts";
import type { Operation } from "./operation.ts";
import { associatedAddress, ASSOCIATED_TOKEN_PROGRAM, decode58, derivePda, discriminator, SYSTEM_PROGRAM, TOKEN_PROGRAM, type AccountMeta, type Instruction, decodeLegacy } from "./solana.ts";

export interface BenchProfile {
  apiOrigin: string; expectedGenesis: string; programId: string; programData: string; programDataSha256: string;
  admin: string; poster: string; freshnessSeconds: number; usdcMainnet: string;
  mappings: { mainnet: string; devnet: string; decimals: number }[];
  /** Operator attestation from a separately qualified API deployment, not a probe performed by this library. */
  apiApproval: { protocol: "audacefi.bench.submission.v1"; validFromMs: number; expiresAtMs: number };
}
const MAX64 = (1n << 64n) - 1n, MAX128 = (1n << 128n) - 1n;
function bounded(n: bigint, max: bigint, positive = false): bigint { if (n < (positive ? 1n : 0n) || n > max) throw new Error("BENCH_INTEGER_RANGE"); return n; }
function mul(a: bigint, b: bigint): bigint { return bounded(a * b, MAX128); }
function pow10(n: number): bigint { integer(n, 0, 38); return bounded(10n ** BigInt(n), MAX128); }
export function benchAmounts(amount: string, inputDecimals: number, outputDecimals: number, price: string, expo: number, kind: "buy" | "sell" | "route", outputPrice?: string, outputExpo?: number) {
  const input = BigInt(rawAmount(amount)), p = BigInt(rawAmount(price));
  const di = integer(inputDecimals, 0, 9), dout = integer(outputDecimals, 0, 9), e = integer(expo, -18, 18);
  let gross: bigint, fee: bigint, output: bigint;
  if (kind === "buy") {
    fee = mul(input, 10n) / 10000n;
    const net = input - fee;
    gross = e >= 0 ? mul(net, pow10(dout)) / mul(p, pow10(di + e)) : mul(net, pow10(dout - e)) / mul(p, pow10(di));
    output = gross;
  } else if (kind === "sell") {
    gross = e >= 0 ? mul(mul(input, p), pow10(dout + e)) / pow10(di) : mul(mul(input, p), pow10(dout)) / pow10(di - e);
    fee = mul(gross, 10n) / 10000n; output = gross - fee;
  } else {
    const po = BigInt(rawAmount(outputPrice)), eo = integer(outputExpo, -18, 18), k = dout - di + e - eo;
    let numerator = mul(input, p), denominator = po;
    if (k >= 0) numerator = mul(numerator, pow10(k)); else denominator = mul(denominator, pow10(-k));
    gross = numerator / denominator; fee = mul(gross, 20n) / 10000n; output = gross - fee;
  }
  bounded(gross, MAX64, true); bounded(output, MAX64, true); bounded(fee, MAX64);
  return { gross, fee, output, vaultRequired: kind === "buy" ? output : gross };
}
export function benchAddresses(profile: BenchProfile) {
  const config = derivePda(profile.programId, [Buffer.from("config")]);
  const vault = derivePda(profile.programId, [Buffer.from("vault_authority")]);
  const fee = derivePda(profile.programId, [Buffer.from("fee_authority")]);
  return { config, vault, fee, price: (mint: string) => derivePda(profile.programId, [Buffer.from("price"), decode58(mint, 32)]) };
}
export function benchPlan(profile: BenchProfile, o: Readonly<Operation>, q: Readonly<Quote>) {
  decode58(o.playerPublicKey, 32);
  const input = profile.mappings.find(m => m.mainnet === o.tokenInMint), output = profile.mappings.find(m => m.mainnet === o.tokenOutMint), usdc = profile.mappings.find(m => m.mainnet === profile.usdcMainnet);
  if (!input || !output || !usdc || input.decimals !== o.inputDecimals || input.devnet === output.devnet || q.amountInRaw !== o.amountInRaw) throw new Error("BENCH_MAPPING_REQUIRED");
  const a = benchAddresses(profile), playerIn = associatedAddress(o.playerPublicKey, input.devnet), playerOut = associatedAddress(o.playerPublicKey, output.devnet);
  const vaultIn = associatedAddress(a.vault.address, input.devnet), vaultOut = associatedAddress(a.vault.address, output.devnet);
  const feeMint = q.kind === "route" ? output.devnet : usdc.devnet, feeVault = associatedAddress(a.fee.address, feeMint);
  const meta = (address: string, writable = false, signer = false): AccountMeta => ({ address, writable, signer });
  const instructions: Instruction[] = [{ program: ASSOCIATED_TOKEN_PROGRAM, accounts: [meta(o.playerPublicKey, true, true), meta(playerOut, true), meta(o.playerPublicKey), meta(output.devnet), meta(SYSTEM_PROGRAM), meta(TOKEN_PROGRAM)], data: Buffer.from([1]) }];
  const prices: { mint: string; price: string; expo: number }[] = [];
  let amounts: ReturnType<typeof benchAmounts>;
  let swapAccounts: AccountMeta[], swapData: Buffer;
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(rawAmount(o.amountInRaw)));
  if (q.kind === "route") {
    if (q.mintInMainnet !== input.mainnet || q.mintInDevnet !== input.devnet || q.mintOutMainnet !== output.mainnet || q.mintOutDevnet !== output.devnet || input.mainnet === profile.usdcMainnet || output.mainnet === profile.usdcMainnet || q.feeBps !== 20 || q.quoteId === q.quoteIdOut) throw new Error("BENCH_ROUTE_MISMATCH");
    amounts = benchAmounts(o.amountInRaw, input.decimals, output.decimals, q.priceIn.price, q.priceIn.expo, "route", q.priceOut.price, q.priceOut.expo);
    if (amounts.gross.toString() !== q.amountOutGrossRaw || amounts.fee.toString() !== q.feeRaw || amounts.output.toString() !== q.amountOutNetRaw) throw new Error("BENCH_ROUTE_AMOUNT_MISMATCH");
    prices.push({ mint: input.devnet, price: q.priceIn.price, expo: q.priceIn.expo }, { mint: output.devnet, price: q.priceOut.price, expo: q.priceOut.expo });
    swapAccounts = [meta(a.config.address), meta(input.devnet), meta(output.devnet), meta(usdc.devnet), meta(a.price(input.devnet).address), meta(a.price(output.devnet).address), meta(a.vault.address), meta(vaultIn, true), meta(vaultOut, true), meta(associatedAddress(a.vault.address, usdc.devnet)), meta(a.fee.address), meta(feeVault, true), meta(o.playerPublicKey, true, true), meta(playerIn, true), meta(playerOut, true), meta(TOKEN_PROGRAM)];
    swapData = Buffer.concat([discriminator("global", "swap_route"), amount]);
  } else {
    const buy = input.mainnet === profile.usdcMainnet, token = buy ? output : input;
    if (buy === (output.mainnet === profile.usdcMainnet) || q.direction !== (buy ? "buy" : "sell") || q.mintMainnet !== token.mainnet || q.mintDevnet !== token.devnet) throw new Error("BENCH_SINGLE_MISMATCH");
    amounts = benchAmounts(o.amountInRaw, input.decimals, output.decimals, q.price, q.expo, buy ? "buy" : "sell");
    prices.push({ mint: token.devnet, price: q.price, expo: q.expo });
    swapAccounts = [meta(a.config.address), meta(token.devnet), meta(usdc.devnet), meta(a.price(token.devnet).address), meta(a.vault.address), meta(associatedAddress(a.vault.address, token.devnet), true), meta(associatedAddress(a.vault.address, usdc.devnet), true), meta(a.fee.address), meta(feeVault, true), meta(o.playerPublicKey, true, true), meta(associatedAddress(o.playerPublicKey, token.devnet), true), meta(associatedAddress(o.playerPublicKey, usdc.devnet), true), meta(TOKEN_PROGRAM)];
    swapData = Buffer.concat([discriminator("global", "swap"), Buffer.from([buy ? 0 : 1]), amount]);
  }
  for (const price of prices) {
    const data = Buffer.alloc(20); discriminator("global", "post_price").copy(data); data.writeBigUInt64LE(BigInt(rawAmount(price.price)), 8); data.writeInt32LE(integer(price.expo, -18, 18), 16);
    instructions.push({ program: profile.programId, accounts: [meta(a.config.address), meta(profile.poster, true, true), meta(price.mint), meta(a.price(price.mint).address, true), meta(SYSTEM_PROGRAM)], data });
  }
  instructions.push({ program: profile.programId, accounts: swapAccounts, data: swapData });
  return { instructions, input, output, usdc, playerIn, playerOut, vaultIn, vaultOut, feeVault, feeMint, amounts, prices, addresses: a };
}
/** Decode untrusted wire bytes and compare semantic fields plus message-wide privilege union. */
export function verifyBenchMessage(encoded: string, profile: BenchProfile, o: Readonly<Operation>, q: Readonly<Quote>, allowPlayerSignature = false) {
  const decoded = decodeLegacy(encoded), plan = benchPlan(profile, o, q);
  if (decoded.accounts[0]?.address !== o.playerPublicKey || decoded.accounts[1]?.address !== profile.poster || decoded.signatures[1]!.some(b => b !== 0) || (!allowPlayerSignature && decoded.signatures[0]!.some(b => b !== 0))) throw new Error("BENCH_SIGNER_MISMATCH");
  if (decoded.instructions.length !== plan.instructions.length) throw new Error("BENCH_INSTRUCTION_COUNT");
  const union = new Map<string, AccountMeta>();
  const add = (m: AccountMeta) => { const old = union.get(m.address); union.set(m.address, { address: m.address, signer: m.signer || old?.signer === true, writable: m.writable || old?.writable === true }); };
  plan.instructions.forEach(ix => { ix.accounts.forEach(add); add({ address: ix.program, signer: false, writable: false }); });
  if (decoded.accounts.length !== union.size || decoded.accounts.some(a => { const e = union.get(a.address); return !e || a.signer !== e.signer || a.writable !== e.writable; })) throw new Error("BENCH_PRIVILEGE_MISMATCH");
  for (let i = 0; i < plan.instructions.length; i++) {
    const expected = plan.instructions[i]!, actual = decoded.instructions[i]!;
    if (expected.program !== actual.program || !Buffer.from(expected.data).equals(actual.data) || expected.accounts.length !== actual.accounts.length || expected.accounts.some((a, n) => a.address !== actual.accounts[n]?.address)) throw new Error("BENCH_SEMANTIC_MISMATCH");
  }
  return { decoded, plan };
}

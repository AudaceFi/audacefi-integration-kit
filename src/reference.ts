import { AudaceFiClient, type Quote, type Submission } from "./client.ts";
import { closed, integer, record, timestamp } from "./contract.ts";
import { digest } from "./canonical.ts";
import type { FinalEvidence, Operation, OperatorPorts, PlanEvidence, VerifiedTarget } from "./operation.ts";
import type { RpcPort } from "./rpc.ts";
import { benchAddresses, benchPlan, verifyBenchMessage, type BenchProfile } from "./bench.ts";
import { associatedAddress, ASSOCIATED_TOKEN_PROGRAM, CLOCK_SYSVAR, compileLegacy, decode58, decodeLegacy, discriminator, encode58, hashBytes, isCurvePoint, SYSTEM_PROGRAM, SYSVAR_OWNER, TOKEN_PROGRAM, UPGRADEABLE_LOADER, verifyEd25519 } from "./solana.ts";

export interface WalletPort {
  publicKey: () => string | Promise<string>;
  signTransaction: (unsignedBase64: string) => Promise<string>;
}
interface ChainAccount { owner: string; executable: boolean; lamports: number; bytes: Buffer }
interface BuildRecord { operation: Readonly<Operation>; quote: Readonly<Quote>; blockhash: string; lastValidBlockHeight: number; createdAt: number; checked: boolean }
function freeze<T>(v: T): Readonly<T> { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function context(raw: unknown, minimum: number) { const r = record(raw), slot = integer(record(r.context).slot, minimum, Number.MAX_SAFE_INTEGER); if (!("value" in r)) throw new Error("RPC_VALUE_REQUIRED"); return { slot, value: r.value }; }
function account(raw: unknown): ChainAccount | null {
  if (raw === null) return null;
  const a = record(raw); decode58(a.owner as string, 32);
  if (typeof a.executable !== "boolean" || !Array.isArray(a.data) || a.data.length !== 2 || a.data[1] !== "base64" || typeof a.data[0] !== "string" || a.data[0].length > 1600000) throw new Error("UNSUPPORTED_ACCOUNT_ENCODING");
  const bytes = Buffer.from(a.data[0], "base64"); if (bytes.toString("base64") !== a.data[0]) throw new Error("INVALID_ACCOUNT_BYTES");
  return { owner: a.owner as string, executable: a.executable, lamports: integer(a.lamports, 0, Number.MAX_SAFE_INTEGER), bytes };
}
function owned(a: ChainAccount | null | undefined, owner: string, size?: number): ChainAccount {
  if (!a || a.owner !== owner || a.executable || (size !== undefined && a.bytes.length !== size)) throw new Error("UNVERIFIED_ACCOUNT"); return a;
}
function token(a: ChainAccount | null | undefined, mint: string, owner: string): bigint {
  const b = owned(a, TOKEN_PROGRAM, 165).bytes;
  if (encode58(b.subarray(0, 32)) !== mint || encode58(b.subarray(32, 64)) !== owner || b[108] !== 1 || b.readUInt32LE(72) !== 0 || b.readUInt32LE(109) !== 0 || b.readBigUInt64LE(121) !== 0n || b.readUInt32LE(129) !== 0) throw new Error("UNSAFE_TOKEN_ACCOUNT");
  return b.readBigUInt64LE(64);
}
const transactionEnums = new Set(["AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound", "InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount", "TooManyAccountLocks", "InvalidRentPayingAccount", "WouldExceedMaxAccountCostLimit", "MaxLoadedAccountsDataSizeExceeded"]);
const instructionEnums = new Set(["GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData", "AccountDataTooSmall", "InsufficientFunds", "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized", "UninitializedAccount", "UnbalancedInstruction", "NotEnoughAccountKeys", "AccountNotExecutable", "AccountBorrowFailed", "InvalidSeeds", "InvalidRealloc", "ComputationalBudgetExceeded", "PrivilegeEscalation", "ProgramFailedToComplete", "Immutable", "IncorrectAuthority", "AccountNotRentExempt", "InvalidAccountOwner", "ArithmeticOverflow", "UnsupportedSysvar", "IllegalOwner"]);
function finalError(raw: unknown, instructions: number, accounts: number): string {
  if (raw === null) return "null";
  if (typeof raw === "string" && transactionEnums.has(raw)) return JSON.stringify(raw);
  const e = record(raw), keys = Object.keys(e); if (keys.length !== 1) throw new Error("UNSUPPORTED_FINAL_ERROR");
  if (keys[0] === "InstructionError" && Array.isArray(e.InstructionError) && e.InstructionError.length === 2) {
    const [index, detail] = e.InstructionError; integer(index, 0, instructions - 1);
    if (typeof detail === "string" && instructionEnums.has(detail)) return JSON.stringify({ InstructionError: [index, detail] });
    const custom = record(detail); if (Object.keys(custom).length !== 1 || !("Custom" in custom)) throw new Error("UNSUPPORTED_FINAL_ERROR");
    return JSON.stringify({ InstructionError: [index, { Custom: integer(custom.Custom, 0, 4294967295) }] });
  }
  if (keys[0] === "DuplicateInstruction") return JSON.stringify({ DuplicateInstruction: integer(e.DuplicateInstruction, 0, instructions - 1) });
  if (keys[0] === "InsufficientFundsForRent" || keys[0] === "ProgramExecutionTemporarilyRestricted") {
    const key = keys[0], detail = record(e[key]);
    if (Object.keys(detail).length !== 1 || !("account_index" in detail)) throw new Error("UNSUPPORTED_FINAL_ERROR");
    return JSON.stringify({ [key]: { account_index: integer(detail.account_index, 0, accounts - 1) } });
  }
  throw new Error("UNSUPPORTED_FINAL_ERROR");
}
/** Concrete reference ports. Only explicit method calls perform injected reads/signing. */
export function createReferenceAdapters(options: { profile: BenchProfile; client: AudaceFiClient; rpc: RpcPort; wallet: WalletPort; clock?: () => number }) {
  let cloned: BenchProfile; try { cloned = structuredClone(options.profile); } catch { throw new Error("INVALID_PROFILE"); }
  const p = freeze(cloned), { client, rpc, wallet } = options, clock = options.clock ?? Date.now;
  closed(p, ["apiOrigin", "expectedGenesis", "programId", "programData", "programDataSha256", "admin", "poster", "freshnessSeconds", "usdcMainnet", "mappings", "apiApproval"]);
  let apiUrl: URL; try { apiUrl = new URL(p.apiOrigin); } catch { throw new Error("INVALID_PROFILE_ORIGIN"); }
  if (apiUrl.protocol !== "https:" || apiUrl.origin !== p.apiOrigin || client.origin !== p.apiOrigin || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(p.expectedGenesis) || !/^[0-9a-f]{64}$/.test(p.programDataSha256)) throw new Error("INVALID_PROFILE");
  [p.programId, p.programData, p.admin, p.poster, p.usdcMainnet].forEach(k => decode58(k, 32));
  if (!isCurvePoint(decode58(p.poster, 32)) || p.programId === p.programData || [SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM].includes(p.programId)) throw new Error("INVALID_PROFILE_PROGRAM");
  integer(p.freshnessSeconds, 1, 86400);
  if (!Array.isArray(p.mappings) || p.mappings.length < 2 || p.mappings.length > 64 || new Set(p.mappings.map(m => m.mainnet)).size !== p.mappings.length || new Set(p.mappings.map(m => m.devnet)).size !== p.mappings.length) throw new Error("INVALID_PROFILE_MAPPINGS");
  p.mappings.forEach(m => { closed(m, ["mainnet", "devnet", "decimals"]); decode58(m.mainnet, 32); decode58(m.devnet, 32); integer(m.decimals, 0, 9); });
  const usdc = p.mappings.find(m => m.mainnet === p.usdcMainnet); if (!usdc) throw new Error("USDC_MAPPING_REQUIRED");
  closed(p.apiApproval, ["protocol", "validFromMs", "expiresAtMs"]);
  if (p.apiApproval.protocol !== "audacefi.bench.submission.v1" || integer(p.apiApproval.expiresAtMs, 1, 8000000000000) <= integer(p.apiApproval.validFromMs, 0, 8000000000000)) throw new Error("API_DEPLOYMENT_APPROVAL_REQUIRED");
  const addresses = benchAddresses(p), builds = new Map<string, BuildRecord>();
  let lastSlot = 0, lastTime = 0;
  const now = () => { const t = integer(clock(), lastTime, 8000000000000); lastTime = t; return t; };
  const approval = () => { const t = now(); if (client.origin !== p.apiOrigin || t < p.apiApproval.validFromMs || t >= p.apiApproval.expiresAtMs) throw new Error("API_DEPLOYMENT_APPROVAL_EXPIRED"); };
  const genesis = async () => { if (await rpc.call("getGenesisHash", []) !== p.expectedGenesis) throw new Error("GENESIS_MISMATCH"); };
  const withContext = (raw: unknown) => { const c = context(raw, lastSlot); lastSlot = c.slot; return c; };
  const config = () => ({ commitment: "finalized", minContextSlot: lastSlot });
  async function snapshot(extra: string[] = []) {
    approval(); await genesis();
    const keys = [...new Set([p.programId, p.programData, addresses.config.address, p.poster, CLOCK_SYSVAR, ...p.mappings.map(m => m.devnet), ...extra])];
    if (keys.length > 100) throw new Error("SNAPSHOT_ACCOUNT_LIMIT");
    const c = withContext(await rpc.call("getMultipleAccounts", [keys, { ...config(), encoding: "base64" }]));
    if (!Array.isArray(c.value) || c.value.length !== keys.length) throw new Error("INCOMPLETE_SNAPSHOT");
    const map = new Map(keys.map((k, i) => [k, account((c.value as unknown[])[i])]));
    const program = map.get(p.programId), data = owned(map.get(p.programData), UPGRADEABLE_LOADER);
    if (!program || !program.executable || program.owner !== UPGRADEABLE_LOADER || program.bytes.length !== 36 || program.bytes.readUInt32LE(0) !== 2 || encode58(program.bytes.subarray(4)) !== p.programData || data.bytes.length < 45 || data.bytes.readUInt32LE(0) !== 3 || data.bytes.readBigUInt64LE(4) > BigInt(c.slot) || ![0, 1].includes(data.bytes[12]!) || hashBytes(data.bytes) !== p.programDataSha256) throw new Error("UNVERIFIED_PROGRAM_DEPLOYMENT");
    const b = owned(map.get(addresses.config.address), p.programId, 115).bytes;
    if (!b.subarray(0, 8).equals(discriminator("account", "BenchConfig")) || encode58(b.subarray(8, 40)) !== p.admin || encode58(b.subarray(40, 72)) !== p.poster || encode58(b.subarray(72, 104)) !== usdc!.devnet || b.readBigInt64LE(104) !== BigInt(p.freshnessSeconds) || b[112] !== addresses.config.bump || b[113] !== addresses.vault.bump || b[114] !== addresses.fee.bump) throw new Error("UNVERIFIED_BENCH_CONFIG");
    for (const m of p.mappings) { const mint = owned(map.get(m.devnet), TOKEN_PROGRAM, 82).bytes; if (mint[44] !== m.decimals || mint[45] !== 1) throw new Error("UNVERIFIED_MINT_DECIMALS"); }
    const poster = owned(map.get(p.poster), SYSTEM_PROGRAM, 0);
    const time = owned(map.get(CLOCK_SYSVAR), SYSVAR_OWNER, 40).bytes;
    const slot = time.readBigUInt64LE(0), seconds = time.readBigInt64LE(32), t = now();
    if (slot > BigInt(c.slot) || BigInt(c.slot) - slot > 32n || seconds < 0n || seconds > 8000000000n || Number(seconds) * 1000 > t + 30000 || t - Number(seconds) * 1000 > 120000) throw new Error("STALE_CHAIN_SNAPSHOT");
    approval();
    return { map, slot: c.slot, observedAt: t, poster };
  }
  const target = (): VerifiedTarget => ({ network: "devnet", expectedGenesis: p.expectedGenesis, observedGenesis: p.expectedGenesis, durableProtocol: p.apiApproval.protocol, usdcMainnet: p.usdcMainnet, allowedPrograms: [p.programId, ASSOCIATED_TOKEN_PROGRAM], mappings: structuredClone(p.mappings) });
  const targetMatches = (t: Readonly<VerifiedTarget>) => { if (digest(t) !== digest(target())) throw new Error("TARGET_PROFILE_MISMATCH"); };
  async function verifyPlan(encoded: string, o: Readonly<Operation>, q: Readonly<Quote>, t: Readonly<VerifiedTarget>): Promise<PlanEvidence> {
    approval(); targetMatches(t);
    const { decoded, plan } = verifyBenchMessage(encoded, p, o, q), built = builds.get(decoded.messageHash);
    if (!built || digest(o) !== digest(built.operation) || digest(q) !== digest(built.quote) || decoded.blockhash !== built.blockhash || now() - built.createdAt > 120000) throw new Error("UNKNOWN_REFERENCE_BUILD");
    if (now() >= timestamp(q.expiresAt)) throw new Error("REFERENCE_QUOTE_EXPIRED");
    const state = await client.readState(o.category, "real"), season = state.season.active, w = state.wallet;
    const at = now();
    if (!season || season.id !== o.seasonId || season.status !== "active" || season.executionMode !== "devnet_onchain" || season.startsAt === null || season.endsAt === null || timestamp(season.startsAt) > at || timestamp(season.endsAt) <= at || timestamp(state.asOf) > at + 30000 || at - timestamp(state.asOf) > 120000 || w.state !== "ok" || w.walletAddress !== o.playerPublicKey || w.seasonId !== o.seasonId || w.category !== o.category.replace("-", "_") || w.mode !== "real" || w.seasonExecutionMode !== "devnet_onchain") throw new Error("REFERENCE_STATE_NOT_EXECUTABLE");
    const allow = await client.readAllowlist(o.category, o.seasonId);
    for (const mapping of [plan.input, plan.output]) {
      const token = allow.tokens.find(v => v.mint === mapping.mainnet);
      if (!token || token.decimals !== mapping.decimals || !(token.exempt || (allow.allowlistFrozen && token.eligible))) throw new Error("REFERENCE_ASSET_NOT_ELIGIBLE");
    }
    const eligibilityAt = now();
    const accountKeys = plan.instructions.flatMap(ix => ix.accounts.map(a => a.address));
    const chain = await snapshot(accountKeys), player = owned(chain.map.get(o.playerPublicKey), SYSTEM_PROGRAM, 0);
    const balance = token(chain.map.get(plan.playerIn), plan.input.devnet, o.playerPublicKey);
    const out = chain.map.get(plan.playerOut); if (out) token(out, plan.output.devnet, o.playerPublicKey);
    token(chain.map.get(plan.vaultIn), plan.input.devnet, addresses.vault.address);
    const reserve = token(chain.map.get(plan.vaultOut), plan.output.devnet, addresses.vault.address);
    token(chain.map.get(plan.feeVault), plan.feeMint, addresses.fee.address);
    if (q.kind === "route") token(chain.map.get(associatedAddress(addresses.vault.address, usdc!.devnet)), usdc!.devnet, addresses.vault.address);
    let missingPrices = 0;
    for (const price of plan.prices) {
      const entry = chain.map.get(addresses.price(price.mint).address);
      if (!entry) { missingPrices++; continue; }
      const bytes = owned(entry, p.programId, 69).bytes;
      if (!bytes.subarray(0, 8).equals(discriminator("account", "PriceAccount")) || encode58(bytes.subarray(8, 40)) !== price.mint || bytes[68] !== addresses.price(price.mint).bump) throw new Error("UNVERIFIED_PRICE_ACCOUNT");
    }
    const fee = withContext(await rpc.call("getFeeForMessage", [decoded.message.toString("base64"), config()]));
    const feeLamports = integer(fee.value, 1, Number.MAX_SAFE_INTEGER);
    const outputRent = out ? 0 : integer(await rpc.call("getMinimumBalanceForRentExemption", [165, { commitment: "finalized" }]), 1, Number.MAX_SAFE_INTEGER);
    const priceRent = missingPrices ? integer(await rpc.call("getMinimumBalanceForRentExemption", [69, { commitment: "finalized" }]), 1, Number.MAX_SAFE_INTEGER) : 0;
    // Writable system payers must remain rent-exempt after paying; a zero final balance is not assumed.
    const payerRent = integer(await rpc.call("getMinimumBalanceForRentExemption", [0, { commitment: "finalized" }]), 1, Number.MAX_SAFE_INTEGER);
    const requiredGas = BigInt(feeLamports) + BigInt(outputRent) + BigInt(payerRent);
    const posterRequired = missingPrices ? BigInt(missingPrices) * BigInt(priceRent) + BigInt(payerRent) : 0n;
    if (balance < BigInt(o.amountInRaw) || reserve < plan.amounts.vaultRequired || BigInt(player.lamports) < requiredGas || BigInt(chain.poster.lamports) < posterRequired) throw new Error("REFERENCE_INSUFFICIENT_FUNDS");
    const valid = withContext(await rpc.call("isBlockhashValid", [decoded.blockhash, config()]));
    const height = integer(await rpc.call("getBlockHeight", [config()]), 0, Number.MAX_SAFE_INTEGER);
    if (valid.value !== true || height > built.lastValidBlockHeight) throw new Error("REFERENCE_BLOCKHASH_EXPIRED");
    await genesis(); approval();
    const checkedAt = now(); if (checkedAt - chain.observedAt > 120000 || checkedAt >= timestamp(q.expiresAt)) throw new Error("REFERENCE_EVIDENCE_EXPIRED");
    built.checked = true;
    return { operationHash: digest(o), quoteId: q.quoteId, messageHash: decoded.messageHash, genesisHash: p.expectedGenesis, balanceObservedAtMs: chain.observedAt, eligibilityObservedAtMs: eligibilityAt, blockhashObservedAtMs: checkedAt, inputBalanceRaw: balance.toString(), gasBalanceLamports: String(player.lamports), requiredGasLamports: requiredGas.toString(), eligible: true };
  }
  const ports: OperatorPorts = {
    verifyTarget: async () => { await snapshot(); return target(); },
    assertTargetCurrent: () => { approval(); },
    build: async (o, q, t) => {
      approval(); targetMatches(t); await genesis();
      const at = now(); for (const [key, b] of builds) if (at - b.createdAt > 120000) builds.delete(key);
      if (builds.size >= 8) throw new Error("REFERENCE_BUILD_CACHE_LIMIT");
      const latest = withContext(await rpc.call("getLatestBlockhash", [config()])), value = record(latest.value);
      const blockhash = encode58(decode58(value.blockhash as string, 32)), lastValidBlockHeight = integer(value.lastValidBlockHeight, 1, Number.MAX_SAFE_INTEGER);
      const encoded = compileLegacy(o.playerPublicKey, p.poster, blockhash, benchPlan(p, o, q).instructions), decoded = decodeLegacy(encoded);
      if (builds.has(decoded.messageHash)) throw new Error("REFERENCE_BUILD_ALREADY_EXISTS");
      builds.set(decoded.messageHash, { operation: freeze(structuredClone(o)), quote: freeze(structuredClone(q)), blockhash, lastValidBlockHeight, createdAt: now(), checked: false });
      return encoded;
    },
    verifyPlan, revalidate: verifyPlan,
    sign: async encoded => {
      approval(); const before = decodeLegacy(encoded), built = builds.get(before.messageHash);
      if (!built?.checked) throw new Error("UNVERIFIED_REFERENCE_WALLET");
      let publicKey: string; try { publicKey = await wallet.publicKey(); } catch { throw new Error("REFERENCE_WALLET_UNAVAILABLE"); }
      if (publicKey !== built.operation.playerPublicKey) throw new Error("UNVERIFIED_REFERENCE_WALLET");
      verifyBenchMessage(encoded, p, built.operation, built.quote);
      await verifyPlan(encoded, built.operation, built.quote, target());
      let signed: string; try { signed = await wallet.signTransaction(encoded); } catch { throw new Error("REFERENCE_WALLET_UNAVAILABLE"); }
      const after = decodeLegacy(signed);
      try { publicKey = await wallet.publicKey(); } catch { throw new Error("REFERENCE_WALLET_UNAVAILABLE"); }
      if (publicKey !== built.operation.playerPublicKey || before.messageHash !== after.messageHash || after.signatures[1]!.some(b => b !== 0) || !verifyEd25519(after.message, after.signatures[0]!, built.operation.playerPublicKey)) throw new Error("REFERENCE_WALLET_CHANGED_MESSAGE");
      verifyBenchMessage(signed, p, built.operation, built.quote, true);
      return { transaction: signed, signature: encode58(after.signatures[0]!) };
    },
  };
  async function verifyFinal(saved: Readonly<Submission>, expected: Readonly<{ genesisHash: string; origin: string }>): Promise<FinalEvidence> {
    try {
      if (expected.genesisHash !== p.expectedGenesis || expected.origin !== p.apiOrigin || saved.txid !== saved.playerSignature) return { status: "unknown" };
      decode58(saved.txid, 64); await genesis();
      const status = withContext(await rpc.call("getSignatureStatuses", [[saved.txid], { searchTransactionHistory: true }]));
      if (!Array.isArray(status.value) || status.value.length !== 1 || status.value[0] === null) return { status: "unknown" };
      const s = record(status.value[0]); if (s.confirmationStatus !== "finalized" || s.confirmations !== null || !("err" in s)) return { status: "unknown" };
      const txRaw = await rpc.call("getTransaction", [saved.txid, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
      if (txRaw === null) return { status: "unknown" };
      const tx = record(txRaw), meta = record(tx.meta), slot = integer(tx.slot, 0, status.slot);
      if (integer(s.slot, 0, status.slot) !== slot || tx.version !== "legacy" || !Array.isArray(tx.transaction) || tx.transaction.length !== 2 || tx.transaction[1] !== "base64" || typeof tx.transaction[0] !== "string" || !("err" in meta)) return { status: "unknown" };
      const decoded = decodeLegacy(tx.transaction[0]);
      const err = finalError(meta.err, decoded.instructions.length, decoded.accounts.length);
      if (err !== finalError(s.err, decoded.instructions.length, decoded.accounts.length)) return { status: "unknown" };
      const outcome = err === "null" ? "confirmed" : "failed";
      if (decoded.messageHash !== saved.messageHash || decoded.accounts[0]?.address !== saved.playerPublicKey || encode58(decoded.signatures[0]!) !== saved.txid || !verifyEd25519(decoded.message, decoded.signatures[0]!, saved.playerPublicKey) || !verifyEd25519(decoded.message, decoded.signatures[1]!, decoded.accounts[1]!.address)) return { status: "unknown" };
      await genesis();
      return { status: outcome, commitment: "finalized", genesisHash: p.expectedGenesis, txid: saved.txid };
    } catch { return { status: "unknown" }; }
  }
  return { ports, verifyFinal };
}

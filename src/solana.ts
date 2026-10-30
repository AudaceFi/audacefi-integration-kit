import { createHash, createPublicKey, verify } from "node:crypto";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
export const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
export function encode58(bytes: Uint8Array): string {
  let n = 0n, out = "";
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n > 0n) { out = alphabet[Number(n % 58n)]! + out; n /= 58n; }
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}
export function decode58(value: string, size: number): Buffer {
  if (typeof value !== "string" || value.length < 1 || value.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error("INVALID_BASE58");
  let n = 0n; for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const hex = n === 0n ? "" : n.toString(16);
  const bytes = Buffer.concat([Buffer.alloc(value.length - value.replace(/^1+/, "").length), Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex")]);
  if (bytes.length !== size || encode58(bytes) !== value) throw new Error("INVALID_BASE58_SIZE");
  return bytes;
}
export function hashBytes(raw: Uint8Array): string { return createHash("sha256").update(raw).digest("hex"); }
export function discriminator(namespace: "global" | "account", name: string): Buffer { return createHash("sha256").update(namespace + ":" + name).digest().subarray(0, 8); }
const p = (1n << 255n) - 19n;
function mod(n: bigint): bigint { const v = n % p; return v < 0n ? v + p : v; }
function pow(n: bigint, e: bigint): bigint { let out = 1n, v = mod(n); while (e > 0n) { if (e & 1n) out = mod(out * v); v = mod(v * v); e >>= 1n; } return out; }
const d = mod(-121665n * pow(121666n, p - 2n)), sqrtI = pow(2n, (p - 1n) / 4n);
export function isCurvePoint(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const bytes = Buffer.from(raw), sign = bytes[31]! >> 7; bytes[31] = bytes[31]! & 127;
  let y = 0n; for (let i = 31; i >= 0; i--) y = y * 256n + BigInt(bytes[i]!);
  if (y >= p) return false;
  const y2 = mod(y * y), denominator = mod(d * y2 + 1n);
  if (denominator === 0n) return false;
  const x2 = mod((y2 - 1n) * pow(denominator, p - 2n));
  let x = pow(x2, (p + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * sqrtI);
  return mod(x * x) === x2 && !(x === 0n && sign === 1);
}
export function derivePda(program: string, seeds: readonly Uint8Array[]): { address: string; bump: number } {
  if (seeds.length > 15 || seeds.some(s => s.length > 32)) throw new Error("INVALID_PDA_SEEDS");
  const programBytes = decode58(program, 32);
  for (let bump = 255; bump > 0; bump--) {
    const raw = createHash("sha256").update(Buffer.concat([...seeds.map(s => Buffer.from(s)), Buffer.from([bump]), programBytes, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!isCurvePoint(raw)) return { address: encode58(raw), bump };
  }
  throw new Error("PDA_NOT_FOUND");
}
export function associatedAddress(owner: string, mint: string): string { return derivePda(ASSOCIATED_TOKEN_PROGRAM, [decode58(owner, 32), decode58(TOKEN_PROGRAM, 32), decode58(mint, 32)]).address; }
export interface AccountMeta { address: string; signer: boolean; writable: boolean }
export interface Instruction { program: string; accounts: AccountMeta[]; data: Uint8Array }
function compact(n: number): Buffer { if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("INVALID_SHORTVEC"); const bytes = []; do { let v = n & 127; n >>>= 7; if (n) v |= 128; bytes.push(v); } while (n); return Buffer.from(bytes); }
export function compileLegacy(player: string, poster: string, blockhash: string, instructions: readonly Instruction[]): string {
  if (player === poster || !isCurvePoint(decode58(player, 32)) || !isCurvePoint(decode58(poster, 32))) throw new Error("TWO_DISTINCT_SIGNERS_REQUIRED");
  const metas = new Map<string, AccountMeta>();
  const add = (m: AccountMeta) => { decode58(m.address, 32); const old = metas.get(m.address); metas.set(m.address, { address: m.address, signer: m.signer || old?.signer === true, writable: m.writable || old?.writable === true }); };
  add({ address: player, signer: true, writable: true }); add({ address: poster, signer: true, writable: true });
  for (const ix of instructions) { ix.accounts.forEach(add); add({ address: ix.program, signer: false, writable: false }); }
  const keys = [...metas.values()].sort((a, b) => Number(b.signer) - Number(a.signer) || Number(b.writable) - Number(a.writable));
  if (keys[0]?.address !== player || keys[1]?.address !== poster || keys.filter(k => k.signer).length !== 2 || keys.length > 32 || instructions.length < 1 || instructions.length > 16) throw new Error("UNEXPECTED_ACCOUNTS");
  const position = (key: string) => { const n = keys.findIndex(k => k.address === key); if (n < 0) throw new Error("MISSING_ACCOUNT"); return n; };
  const message = Buffer.concat([Buffer.from([2, 0, keys.filter(k => !k.signer && !k.writable).length]), compact(keys.length), ...keys.map(k => decode58(k.address, 32)), decode58(blockhash, 32), compact(instructions.length), ...instructions.map(ix => Buffer.concat([Buffer.from([position(ix.program)]), compact(ix.accounts.length), Buffer.from(ix.accounts.map(k => position(k.address))), compact(ix.data.length), Buffer.from(ix.data)]))]);
  const transaction = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);
  if (transaction.length > 1232) throw new Error("TRANSACTION_TOO_LARGE");
  return transaction.toString("base64");
}
export function decodeLegacy(encoded: string) {
  if (typeof encoded !== "string" || encoded.length > 1800 || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("INVALID_TRANSACTION");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 230 || bytes.length > 1232 || bytes[0] !== 2) throw new Error("LEGACY_TWO_SIGNERS_REQUIRED");
  const message = bytes.subarray(129); let at = 0;
  const take = (n: number) => { if (!Number.isInteger(n) || n < 0 || at + n > message.length) throw new Error("TRUNCATED_MESSAGE"); const value = message.subarray(at, at + n); at += n; return value; };
  const short = () => { let n = 0, shift = 0; for (let i = 0; i < 3; i++) { const v = take(1)[0]!; n |= (v & 127) << shift; if (!(v & 128)) { if (n > 65535 || (i > 0 && (v & 127) === 0)) throw new Error("INVALID_SHORTVEC"); return n; } shift += 7; } throw new Error("INVALID_SHORTVEC"); };
  const header = take(3), count = short();
  if (header[0] !== 2 || header[1] !== 0 || count < 3 || count > 32 || header[2]! > count - 2) throw new Error("INVALID_REFERENCE_HEADER");
  const accounts = Array.from({ length: count }, (_, i) => ({ address: encode58(take(32)), signer: i < 2, writable: i < count - header[2]! }));
  if (new Set(accounts.map(k => k.address)).size !== count) throw new Error("DUPLICATE_MESSAGE_KEY");
  const blockhash = encode58(take(32)), total = short();
  if (total < 1 || total > 16) throw new Error("INVALID_INSTRUCTION_COUNT");
  const instructions: Instruction[] = [];
  for (let i = 0; i < total; i++) {
    const pi = take(1)[0]!, indexes = take(short());
    if (!accounts[pi] || indexes.length > 32 || indexes.some(n => n >= count)) throw new Error("INVALID_INSTRUCTION_INDEX");
    const size = short(); if (size > 1024) throw new Error("INVALID_INSTRUCTION_DATA");
    instructions.push({ program: accounts[pi]!.address, accounts: [...indexes].map(n => ({ ...accounts[n]! })), data: take(size) });
  }
  if (at !== message.length) throw new Error("TRAILING_MESSAGE");
  return { bytes, message, messageHash: hashBytes(message), accounts, blockhash, instructions, signatures: [bytes.subarray(1, 65), bytes.subarray(65, 129)] };
}
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: string): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decode58(publicKey, 32)]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}

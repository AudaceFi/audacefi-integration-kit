import { createHash, createPublicKey, verify } from "node:crypto";
import { mint } from "./client.ts";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(raw: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(raw)) throw new Error("INVALID_BASE58");
  let n = 0n;
  for (const c of raw) n = n * 58n + BigInt(alphabet.indexOf(c));
  const hex = n === 0n ? "" : n.toString(16);
  return Buffer.concat([Buffer.alloc(raw.length - raw.replace(/^1+/, "").length), Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex")]);
}
export function byteHash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Bounded LEGACY envelope checks. Semantic bench-plan verification is a separate mandatory port. */
export function inspectTransaction(encoded: string, player: string, allowedPrograms: readonly string[], signed: boolean) {
  mint(player);
  if (typeof encoded !== "string" || encoded.length > 1800 || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("INVALID_TRANSACTION");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 1232 || bytes[0] !== 2) throw new Error("LEGACY_TWO_SIGNERS_REQUIRED");
  const message = bytes.subarray(129);
  let at = 0;
  function take(n: number): Buffer { if (at + n > message.length) throw new Error("TRUNCATED_TRANSACTION"); const v = message.subarray(at, at + n); at += n; return v; }
  function short(): number {
    let n = 0, shift = 0;
    for (let i = 0; i < 3; i++) { const v = take(1)[0]!; n |= (v & 127) << shift; if (!(v & 128)) { if (i > 0 && (v & 127) === 0) throw new Error("NON_CANONICAL_SHORTVEC"); return n; } shift += 7; }
    throw new Error("INVALID_SHORTVEC");
  }
  const header = take(3);
  if (header[0] !== 2 || header[1]! > 1) throw new Error("LEGACY_TWO_SIGNERS_REQUIRED");
  const count = short();
  if (count < 3 || count > 32 || header[2]! > count - 2) throw new Error("INVALID_ACCOUNT_COUNT");
  const keys = Array.from({ length: count }, () => take(32));
  const publicBytes = base58(player);
  if (publicBytes.length !== 32 || !keys[0]!.equals(publicBytes)) throw new Error("WRONG_FEE_PAYER");
  take(32); // The trusted target/builder port verifies blockhash freshness against its pinned network.
  const instructions = short();
  if (instructions < 1 || instructions > 16) throw new Error("INVALID_INSTRUCTION_COUNT");
  const allowed = allowedPrograms.map(p => Buffer.from(base58(mint(p))));
  for (let i = 0; i < instructions; i++) {
    const program = take(1)[0]!;
    if (!keys[program] || !allowed.some(k => k.equals(keys[program]!))) throw new Error("UNEXPECTED_PROGRAM");
    const indexes = take(short());
    if (indexes.length > 32 || indexes.some(index => index >= count)) throw new Error("INVALID_INSTRUCTION_ACCOUNTS");
    const dataLength = short(); if (dataLength > 1024) throw new Error("INSTRUCTION_TOO_LARGE"); take(dataLength);
  }
  if (at !== message.length) throw new Error("TRAILING_TRANSACTION_BYTES");
  const playerSig = bytes.subarray(1, 65);
  if (signed) {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]), format: "der", type: "spki" });
    if (!verify(null, message, key, playerSig)) throw new Error("INVALID_PLAYER_SIGNATURE");
  }
  // Cosigning authority must not already have signed a newly submitted player envelope.
  if (bytes.subarray(65, 129).some(b => b !== 0)) throw new Error("UNEXPECTED_COSIGNATURE");
  return { messageHash: byteHash(message), transactionHash: byteHash(bytes), playerSignatureBytes: playerSig };
}
export function assertSignatureEncoding(signature: string, bytes: Uint8Array): void {
  if (!Buffer.from(base58(signature)).equals(bytes)) throw new Error("SIGNATURE_ENCODING_MISMATCH");
}

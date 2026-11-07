import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  OFFICIAL_APPROVAL_MAX_MS, officialApprovalSigningBytes, verifyOfficialApproval,
  type OfficialApprovalBindings, type OfficialApprovalPayload, type SignedOfficialApproval,
} from "../src/official-approval.ts";
import { encode58 } from "../src/solana.ts";

const issuedAtMs = 1_800_000_000_000;
const validFromMs = issuedAtMs + 1_000;
const expiresAtMs = issuedAtMs + 3_600_000;
const issuer = generateKeyPairSync("ed25519");
const unknownIssuer = generateKeyPairSync("ed25519");
const publicKey = (pair: typeof issuer) => encode58(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const anchor = publicKey(issuer);
const expected: OfficialApprovalBindings = {
  deploymentDigest: "a".repeat(64), profileDigest: "b".repeat(64), scopeDigest: "c".repeat(64),
};
const payload: OfficialApprovalPayload = {
  version: 1, ...expected, issuedAtMs, validFromMs, expiresAtMs,
  evidence: {
    proxyReleaseDigest: "1".repeat(64), apiReleaseDigest: "2".repeat(64),
    indexerReleaseDigest: "3".repeat(64), workerReleaseDigest: "4".repeat(64),
    frozenAllowlistDigest: "5".repeat(64), openingSnapshotDigest: "6".repeat(64),
    independentExitDigest: "7".repeat(64),
  },
};

function signed(value: OfficialApprovalPayload, pair = issuer): SignedOfficialApproval {
  return { payload: value, signature: encode58(sign(null, officialApprovalSigningBytes(value), pair.privateKey)) };
}

test("verifies domain-separated canonical bytes regardless of input field order", () => {
  const canonicalPayload = {
    deploymentDigest: expected.deploymentDigest,
    evidence: {
      apiReleaseDigest: payload.evidence.apiReleaseDigest,
      frozenAllowlistDigest: payload.evidence.frozenAllowlistDigest,
      independentExitDigest: payload.evidence.independentExitDigest,
      indexerReleaseDigest: payload.evidence.indexerReleaseDigest,
      openingSnapshotDigest: payload.evidence.openingSnapshotDigest,
      proxyReleaseDigest: payload.evidence.proxyReleaseDigest,
      workerReleaseDigest: payload.evidence.workerReleaseDigest,
    },
    expiresAtMs, issuedAtMs, profileDigest: expected.profileDigest,
    scopeDigest: expected.scopeDigest, validFromMs, version: 1,
  };
  const bytes = Buffer.from("audacefi.official-ranked-approval.v1\n" + JSON.stringify(canonicalPayload));
  const signature = encode58(sign(null, bytes, issuer.privateKey));
  const verified = verifyOfficialApproval({ signature, payload }, anchor, expected, validFromMs);
  assert.deepEqual(verified, payload);
  assert.deepEqual(officialApprovalSigningBytes(payload), bytes);
  assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.evidence));
});

test("refuses a different issuer, invalid signature or a signature outside the approval domain", () => {
  const input = signed(payload);
  const unscoped = encode58(sign(null, Buffer.from("another signing domain"), issuer.privateKey));
  for (const [approval, key] of [
    [input, publicKey(unknownIssuer)], [signed(payload, unknownIssuer), anchor],
    [input, "malformed"], [{ ...input, signature: "malformed" }, anchor],
    [{ ...input, signature: unscoped }, anchor],
  ] as const) {
    assert.throws(() => verifyOfficialApproval(approval, key, expected, validFromMs), /OFFICIAL_APPROVAL_SIGNATURE_INVALID/);
  }
  assert.throws(() => verifyOfficialApproval({ ...input, issuer: anchor }, anchor, expected, validFromMs), /INVALID_OFFICIAL_APPROVAL/);
});

test("binds the exact deployment, profile, account scope and every evidence digest", () => {
  const input = signed(payload);
  for (const name of Object.keys(expected)) {
    const wrong = { ...expected, [name]: "d".repeat(64) };
    assert.throws(() => verifyOfficialApproval(input, anchor, wrong, validFromMs), /OFFICIAL_APPROVAL_BINDING_MISMATCH/);
  }
  for (const name of Object.keys(payload.evidence)) {
    const changed = { ...payload, evidence: { ...payload.evidence, [name]: "8".repeat(64) } };
    assert.throws(() => verifyOfficialApproval({ ...input, payload: changed }, anchor, expected, validFromMs),
      /OFFICIAL_APPROVAL_SIGNATURE_INVALID/);
  }
});

test("enforces an issued, effective, exclusive expiry window of at most one hour", () => {
  const input = signed(payload);
  assert.equal(OFFICIAL_APPROVAL_MAX_MS, 3_600_000);
  assert.deepEqual(verifyOfficialApproval(input, anchor, expected, expiresAtMs - 1), payload);
  for (const time of [issuedAtMs, validFromMs - 1, expiresAtMs, expiresAtMs + 1]) {
    assert.throws(() => verifyOfficialApproval(input, anchor, expected, time), /OFFICIAL_APPROVAL_NOT_CURRENT/);
  }
  for (const invalid of [
    { ...payload, issuedAtMs: validFromMs + 1 }, { ...payload, validFromMs: expiresAtMs },
    { ...payload, expiresAtMs: expiresAtMs + 1 },
  ]) {
    assert.throws(() => officialApprovalSigningBytes(invalid), /INVALID_OFFICIAL_APPROVAL_WINDOW/);
  }
  const tamperedTime = { ...payload, validFromMs: validFromMs + 1 };
  assert.throws(() => verifyOfficialApproval({ ...input, payload: tamperedTime }, anchor, expected, validFromMs + 1),
    /OFFICIAL_APPROVAL_SIGNATURE_INVALID/);
});

test("refuses unknown, missing, malformed or non-JSON fields", () => {
  const input = signed(payload);
  const { openingSnapshotDigest: _missing, ...missingEvidence } = payload.evidence;
  const accessor = { ...payload, get version() { throw new Error("accessor must not be evaluated"); } };
  for (const invalid of [
    { ...payload, version: 2 }, { ...payload, scopeDigest: "C".repeat(64) },
    { ...payload, issuedAtMs: issuedAtMs + 0.1 }, { ...payload, evidence: missingEvidence },
    { ...payload, evidence: { ...payload.evidence, extra: "8".repeat(64) } },
    { ...payload, [Symbol("extra")]: 1 }, accessor, Object.create(payload),
  ]) {
    assert.throws(() => verifyOfficialApproval({ ...input, payload: invalid }, anchor, expected, validFromMs),
      /INVALID_OFFICIAL_APPROVAL|INVALID_INTEGER/);
  }
});

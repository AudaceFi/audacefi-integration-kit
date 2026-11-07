import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createOfficialOperationGuard, OFFICIAL_OPERATION_HORIZON_MS, officialApprovalDeploymentDigest,
  officialApprovalSigningBytes, type OfficialApprovalEvidence, type OfficialApprovalPayload,
} from "../src/official-approval.ts";
import { encode58 } from "../src/solana.ts";

const issuedAtMs = 1_800_000_000_000;
const issuer = generateKeyPairSync("ed25519");
const issuerPublicKey = encode58(issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const evidence: OfficialApprovalEvidence = {
  proxyReleaseDigest: "1".repeat(64), apiReleaseDigest: "2".repeat(64),
  indexerReleaseDigest: "3".repeat(64), workerReleaseDigest: "4".repeat(64),
  frozenAllowlistDigest: "5".repeat(64), openingSnapshotDigest: "6".repeat(64),
  independentExitDigest: "7".repeat(64),
};
const deploymentDigest = officialApprovalDeploymentDigest(evidence);
const bindings = { deploymentDigest, profileDigest: "a".repeat(64), scopeDigest: "b".repeat(64) };

function fixture() {
  const controls = {
    now: issuedAtMs, expiresAtMs: issuedAtMs + OFFICIAL_OPERATION_HORIZON_MS,
    reads: 0, statusChecks: 0, targetChecks: 0, current: true, readAvailable: true,
    statusAdvanceMs: 0, targetAdvanceMs: 0, envelopeEvidence: evidence,
  };
  const source = {
    issuerPublicKey, deploymentDigest, expectedEvidence: evidence,
    read: async () => {
      controls.reads++;
      if (!controls.readAvailable) throw new Error("SYNTHETIC_APPROVAL_SOURCE_UNAVAILABLE");
      const payload: OfficialApprovalPayload = {
        ...bindings, evidence: controls.envelopeEvidence, version: 1,
        issuedAtMs, validFromMs: issuedAtMs, expiresAtMs: controls.expiresAtMs,
      };
      return { payload, signature: encode58(sign(null, officialApprovalSigningBytes(payload), issuer.privateKey)) };
    },
    isCurrent: async (approval: OfficialApprovalPayload) => {
      assert.ok(Object.isFrozen(approval));
      controls.statusChecks++;
      controls.now += controls.statusAdvanceMs;
      return controls.current;
    },
  };
  const open = () => createOfficialOperationGuard(source, bindings, async () => {
    controls.targetChecks++;
    controls.now += controls.targetAdvanceMs;
  }, { clock: () => controls.now });
  return { open, controls, source };
}

test("official admission requires a full operation horizon before and after asynchronous guards", async () => {
  const { open, controls } = fixture();
  controls.expiresAtMs--;
  await assert.rejects(open()(), /OFFICIAL_APPROVAL_HORIZON_TOO_SHORT/);
  assert.equal(controls.targetChecks, 0);

  controls.expiresAtMs++;
  controls.statusAdvanceMs = 1;
  await assert.rejects(open()(), /OFFICIAL_APPROVAL_HORIZON_TOO_SHORT/);
  assert.equal(controls.targetChecks, 0);

  controls.now = issuedAtMs;
  controls.statusAdvanceMs = 0;
  controls.targetAdvanceMs = 1;
  await assert.rejects(open()(), /OFFICIAL_APPROVAL_HORIZON_TOO_SHORT/);
  assert.equal(controls.targetChecks, 1);

  controls.now = issuedAtMs;
  controls.targetAdvanceMs = 0;
  await open()();
});

test("one approval snapshot serves an operation while each gate checks live revocation and expiry", async () => {
  const { open, controls } = fixture();
  const guard = open();
  await Promise.all([guard(), guard()]);
  controls.readAvailable = false;
  controls.now = controls.expiresAtMs - 1;
  await guard();
  assert.equal(controls.reads, 1);
  assert.equal(controls.statusChecks, 3);
  assert.equal(controls.targetChecks, 3);

  controls.current = false;
  await assert.rejects(guard(), /OFFICIAL_APPROVAL_REVOKED/);
  assert.equal(controls.targetChecks, 3);
  controls.current = true;
  controls.targetAdvanceMs = 1;
  await assert.rejects(guard(), /OFFICIAL_APPROVAL_NOT_CURRENT/);
  assert.equal(controls.reads, 1);
});

test("a later invocation can recover from an unavailable approval by reading a new envelope", async () => {
  const { open, controls } = fixture();
  controls.readAvailable = false;
  const unavailable = open();
  await assert.rejects(unavailable(), /SYNTHETIC_APPROVAL_SOURCE_UNAVAILABLE/);
  controls.readAvailable = true;
  await assert.rejects(unavailable(), /SYNTHETIC_APPROVAL_SOURCE_UNAVAILABLE/);
  await open()();
  assert.equal(controls.reads, 2);
  assert.equal(controls.targetChecks, 1);
});

test("a stalled approval callback aborts, refuses the operation and allows a fresh invocation", async () => {
  const { controls, source } = fixture();
  const aborts: string[] = [];
  const stall = (phase: string, signal: AbortSignal) => new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      aborts.push(phase);
      reject(new Error("SYNTHETIC_APPROVAL_ABORTED"));
    }, { once: true });
  });
  for (const phase of ["read", "status", "target"] as const) {
    const guarded = {
      ...source,
      read: phase === "read" ? (signal: AbortSignal) => stall(phase, signal) : source.read,
      isCurrent: phase === "status" ? (_: OfficialApprovalPayload, signal: AbortSignal) => stall(phase, signal) : source.isCurrent,
    };
    const guard = createOfficialOperationGuard(guarded, bindings,
      signal => phase === "target" ? stall(phase, signal) : undefined,
      { clock: () => controls.now, callbackTimeoutMs: 100 });
    const code = phase === "target" ? "OFFICIAL_TARGET_CHECK_TIMEOUT" : `OFFICIAL_APPROVAL_${phase.toUpperCase()}_TIMEOUT`;
    await assert.rejects(guard(), { message: code });
    await createOfficialOperationGuard(source, bindings, () => {}, { clock: () => controls.now })();
  }
  assert.deepEqual(aborts, ["read", "status", "target"]);
});

test("the reference deployment window also has to cover admission and later writes", async () => {
  const { controls, source } = fixture();
  controls.expiresAtMs += 100_000;
  const referenceWindow = { validFromMs: issuedAtMs, expiresAtMs: issuedAtMs + OFFICIAL_OPERATION_HORIZON_MS - 1 };
  const open = () => createOfficialOperationGuard(source, bindings, () => {}, { referenceWindow, clock: () => controls.now });
  await assert.rejects(open()(), /OFFICIAL_APPROVAL_HORIZON_TOO_SHORT/);
  referenceWindow.expiresAtMs++;
  const guard = open();
  await guard();
  controls.now = referenceWindow.expiresAtMs;
  await assert.rejects(guard(), /OFFICIAL_APPROVAL_NOT_CURRENT/);
});

test("even a correctly signed envelope must match the independently configured evidence", async () => {
  const { open, controls, source } = fixture();
  const wrongDigest = "d".repeat(64);
  assert.throws(() => createOfficialOperationGuard({ ...source, deploymentDigest: wrongDigest },
    { ...bindings, deploymentDigest: wrongDigest }, () => {}), /OFFICIAL_APPROVAL_DEPLOYMENT_MISMATCH/);
  assert.equal(controls.reads, 0);
  controls.envelopeEvidence = { ...evidence, openingSnapshotDigest: "8".repeat(64) };
  assert.notEqual(officialApprovalDeploymentDigest(controls.envelopeEvidence), deploymentDigest);
  await assert.rejects(open()(), /OFFICIAL_APPROVAL_EVIDENCE_MISMATCH/);
  assert.equal(controls.statusChecks, 0);
  assert.equal(controls.targetChecks, 0);
  assert.throws(() => officialApprovalDeploymentDigest({ ...evidence, workerReleaseDigest: "0".repeat(64) }),
    /INVALID_OFFICIAL_APPROVAL_EVIDENCE/);
});

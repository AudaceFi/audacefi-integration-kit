import { canonical, digest } from "./canonical.ts";
import { integer } from "./contract.ts";
import { decode58, verifyEd25519 } from "./solana.ts";

const domain = "audacefi.official-ranked-approval.v1\n";
const maxTimestampMs = 8_000_000_000_000;
export const OFFICIAL_APPROVAL_MAX_MS = 60 * 60 * 1_000;
export const OFFICIAL_OPERATION_HORIZON_MS = 120_000;
const officialCallbackTimeoutMs = 5_000;

const bindingKeys = ["deploymentDigest", "profileDigest", "scopeDigest"] as const;
const evidenceKeys = [
  "proxyReleaseDigest", "apiReleaseDigest", "indexerReleaseDigest", "workerReleaseDigest",
  "frozenAllowlistDigest", "openingSnapshotDigest", "independentExitDigest",
] as const;
const payloadKeys = ["version", ...bindingKeys, "issuedAtMs", "validFromMs", "expiresAtMs", "evidence"] as const;

export type OfficialApprovalBindings = Readonly<Record<(typeof bindingKeys)[number], string>>;
export type OfficialApprovalEvidence = Readonly<Record<(typeof evidenceKeys)[number], string>>;
export interface OfficialApprovalPayload extends OfficialApprovalBindings {
  readonly version: 1;
  readonly issuedAtMs: number;
  readonly validFromMs: number;
  readonly expiresAtMs: number;
  readonly evidence: OfficialApprovalEvidence;
}
export interface SignedOfficialApproval {
  readonly payload: OfficialApprovalPayload;
  readonly signature: string;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("INVALID_OFFICIAL_APPROVAL");
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length || actualKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new Error("INVALID_OFFICIAL_APPROVAL");
  }
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !("value" in field)) throw new Error("INVALID_OFFICIAL_APPROVAL");
    fields[key] = field.value;
  }
  return fields;
}

function hexDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("INVALID_OFFICIAL_APPROVAL_DIGEST");
  return value;
}

function parseEvidence(value: unknown): OfficialApprovalEvidence {
  const fields = exactRecord(value, evidenceKeys);
  const entries = evidenceKeys.map(key => {
    const evidenceDigest = hexDigest(fields[key]);
    if (/^0+$/.test(evidenceDigest)) throw new Error("INVALID_OFFICIAL_APPROVAL_EVIDENCE");
    return [key, evidenceDigest];
  });
  return Object.freeze(Object.fromEntries(entries) as OfficialApprovalEvidence);
}

/** The non-secret deployment manifest supplied independently of the issued envelope. */
export function officialApprovalDeploymentDigest(evidence: OfficialApprovalEvidence): string {
  return digest({ protocol: "audacefi.official-ranked-deployment.v1", evidence: parseEvidence(evidence) });
}

function parsePayload(value: unknown): OfficialApprovalPayload {
  const payload = exactRecord(value, payloadKeys);
  if (payload.version !== 1) throw new Error("INVALID_OFFICIAL_APPROVAL_VERSION");
  const issuedAtMs = integer(payload.issuedAtMs, 1, maxTimestampMs);
  const validFromMs = integer(payload.validFromMs, 1, maxTimestampMs);
  const expiresAtMs = integer(payload.expiresAtMs, 1, maxTimestampMs);
  if (issuedAtMs > validFromMs || validFromMs >= expiresAtMs || expiresAtMs - issuedAtMs > OFFICIAL_APPROVAL_MAX_MS) {
    throw new Error("INVALID_OFFICIAL_APPROVAL_WINDOW");
  }
  return Object.freeze({
    version: 1,
    deploymentDigest: hexDigest(payload.deploymentDigest),
    profileDigest: hexDigest(payload.profileDigest),
    scopeDigest: hexDigest(payload.scopeDigest),
    issuedAtMs, validFromMs, expiresAtMs,
    evidence: parseEvidence(payload.evidence),
  });
}

function signingBytes(payload: OfficialApprovalPayload): Buffer {
  return Buffer.from(domain + canonical(payload), "utf8");
}

/** Produce the exact bytes an independently authorized issuer signs. */
export function officialApprovalSigningBytes(payload: OfficialApprovalPayload): Buffer {
  return signingBytes(parsePayload(payload));
}

/** The issuer key comes from the configured release trust anchor, outside the envelope. */
export function verifyOfficialApproval(
  value: unknown, trustedIssuerPublicKey: string, expected: OfficialApprovalBindings, nowMs = Date.now(),
  expectedEvidence?: OfficialApprovalEvidence,
): OfficialApprovalPayload {
  const envelope = exactRecord(value, ["payload", "signature"]);
  const payload = parsePayload(envelope.payload);
  const bindings = exactRecord(expected, bindingKeys);
  if (bindingKeys.some(key => payload[key] !== hexDigest(bindings[key]))) throw new Error("OFFICIAL_APPROVAL_BINDING_MISMATCH");
  assertCurrentWindow(payload, nowMs);
  if (expectedEvidence) {
    const evidenceDigest = officialApprovalDeploymentDigest(expectedEvidence);
    if (evidenceDigest !== payload.deploymentDigest) throw new Error("OFFICIAL_APPROVAL_DEPLOYMENT_MISMATCH");
    if (officialApprovalDeploymentDigest(payload.evidence) !== evidenceDigest) throw new Error("OFFICIAL_APPROVAL_EVIDENCE_MISMATCH");
  }

  try {
    if (typeof envelope.signature === "string" &&
        verifyEd25519(signingBytes(payload), decode58(envelope.signature, 64), trustedIssuerPublicKey)) return payload;
  } catch {
    throw new Error("OFFICIAL_APPROVAL_SIGNATURE_INVALID");
  }
  throw new Error("OFFICIAL_APPROVAL_SIGNATURE_INVALID");
}

type ApprovalWindow = Pick<OfficialApprovalPayload, "validFromMs" | "expiresAtMs">;

function assertCurrentWindow(payload: ApprovalWindow, nowMs: number, minimumRemainingMs = 0): void {
  const now = integer(nowMs, 1, maxTimestampMs);
  if (now < payload.validFromMs || now >= payload.expiresAtMs) throw new Error("OFFICIAL_APPROVAL_NOT_CURRENT");
  if (payload.expiresAtMs - now < minimumRemainingMs) throw new Error("OFFICIAL_APPROVAL_HORIZON_TOO_SHORT");
}

export interface OfficialApprovalSource {
  readonly issuerPublicKey: string;
  readonly deploymentDigest: string;
  readonly expectedEvidence: OfficialApprovalEvidence;
  readonly read: (signal: AbortSignal) => unknown | Promise<unknown>;
  /** Independently check that this exact issuer and envelope are still authorized. */
  readonly isCurrent: (payload: OfficialApprovalPayload, signal: AbortSignal) => boolean | Promise<boolean>;
}

async function runApprovalCheck<T>(
  check: (signal: AbortSignal) => T | Promise<T>, milliseconds: number, code: string,
): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Error(code);
  try {
    const result = await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(timeout);
          controller.abort();
        }, milliseconds);
      }),
      Promise.resolve().then(() => check(controller.signal)),
    ]);
    if (performance.now() >= deadline) {
      controller.abort();
      throw timeout;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Create a fresh guard for one operation or a retry of its saved request. */
export function createOfficialOperationGuard(
  source: OfficialApprovalSource, bindings: OfficialApprovalBindings,
  assertTarget: (signal: AbortSignal) => void | Promise<void>,
  { clock = Date.now, referenceWindow, callbackTimeoutMs = officialCallbackTimeoutMs }:
    { clock?: () => number; referenceWindow?: ApprovalWindow; callbackTimeoutMs?: number } = {},
): () => Promise<void> {
  const { issuerPublicKey, deploymentDigest } = source;
  const read = source.read.bind(source);
  const isCurrent = source.isCurrent.bind(source);
  const expectedEvidence = parseEvidence(source.expectedEvidence);
  const reference = referenceWindow ? { ...referenceWindow } : undefined;
  const timeout = integer(callbackTimeoutMs, 1, officialCallbackTimeoutMs);
  if (deploymentDigest !== bindings.deploymentDigest || deploymentDigest !== officialApprovalDeploymentDigest(expectedEvidence)) {
    throw new Error("OFFICIAL_APPROVAL_DEPLOYMENT_MISMATCH");
  }
  let pinned: Promise<OfficialApprovalPayload> | undefined;
  let admitted = false;
  return async () => {
    pinned ??= runApprovalCheck(read, timeout, "OFFICIAL_APPROVAL_READ_TIMEOUT").then(envelope =>
      verifyOfficialApproval(envelope, issuerPublicKey, bindings, clock(), expectedEvidence));
    const approval = await pinned;
    const horizon = admitted ? 0 : OFFICIAL_OPERATION_HORIZON_MS;
    const checkWindows = () => {
      const now = clock();
      assertCurrentWindow(approval, now, horizon);
      if (reference) assertCurrentWindow(reference, now, horizon);
    };
    checkWindows();
    if (await runApprovalCheck(signal => isCurrent(approval, signal), timeout, "OFFICIAL_APPROVAL_STATUS_TIMEOUT") !== true) {
      throw new Error("OFFICIAL_APPROVAL_REVOKED");
    }
    checkWindows();
    await runApprovalCheck(assertTarget, timeout, "OFFICIAL_TARGET_CHECK_TIMEOUT");
    checkWindows();
    admitted = true;
  };
}

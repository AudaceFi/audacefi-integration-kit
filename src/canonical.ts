import { createHash } from "node:crypto";
export function canonical(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean")
    return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (
    v &&
    typeof v === "object" &&
    Object.getPrototypeOf(v) === Object.prototype
  )
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  throw new Error("NON_CANONICAL_VALUE");
}
export const digest = (v: unknown): string =>
  createHash("sha256")
    .update("audacefi.offline.canonical.v1\n" + canonical(v))
    .digest("hex");

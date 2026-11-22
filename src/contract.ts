export type Category = "degen" | "crypto-bro" | "whale";
export type RankedCategory = Extract<Category, "crypto-bro" | "degen">;
export function isRankedCategory(value: unknown): value is RankedCategory {
  return value === "crypto-bro" || value === "degen";
}

/** Canonical ASCII label used to bind a signal to its configured pair. */
export function normalizeSpotSymbol(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16 ||
      !/^[-A-Za-z0-9_.$!]+(?: [-A-Za-z0-9_.$!]+)*$/.test(value)) return undefined;
  return value.toUpperCase();
}

export function isCanonicalSpotSymbol(value: unknown): value is string {
  return typeof value === "string" && normalizeSpotSymbol(value) === value;
}

export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_OBJECT");
  return value as RecordValue;
}
export function closed(value: unknown, keys: readonly string[]): RecordValue {
  const v = record(value);
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("UNKNOWN_FIELD");
  return v;
}
export function text(v: unknown): string {
  if (typeof v !== "string" || v.length === 0)
    throw new Error("INVALID_TEXT");
  // JSON Schema length counts Unicode code points, not UTF-16 code units.
  let length = 0;
  for (const _ of v) {
    if (++length > 200) throw new Error("INVALID_TEXT");
  }
  return v;
}
export function integer(v: unknown, min = 0, max = 1_000_000_000_000): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("INVALID_INTEGER");
  return v;
}
/** Compare the JSON number's exact decimal form to verified raw units. */
export function matchesRawAmount(amount: unknown, raw: bigint, decimals: number): boolean {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e12) return false;
  const [mantissa, exponent = "0"] = String(amount).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const shift = decimals + Number(exponent) - fraction.length;
  return shift >= 0 && BigInt(whole! + fraction) * 10n ** BigInt(shift) === raw;
}
export function timestamp(v: unknown): number {
  const s = text(v),
    n = Date.parse(s);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) ||
    !Number.isFinite(n) ||
    new Date(n).toISOString() !== s
  )
    throw new Error("INVALID_TIMESTAMP");
  return n;
}
export function category(v: unknown): Category {
  if (v !== "degen" && v !== "crypto-bro" && v !== "whale")
    throw new Error("INVALID_CATEGORY");
  return v;
}
export interface ReadState {
  asOf: string;
  mode: string;
  category: Category;
  season: {
    active: null | {
      id: string;
      status: string;
      executionMode: string;
      startsAt: string | null;
      endsAt: string | null;
    };
  };
  wallet:
    | { state: "unavailable"; code: string }
    | {
        state: "ok";
        seasonId: string;
        seasonExecutionMode: string | null;
        mode: string | null;
        category: string;
        walletAddress: string | null;
      };
}
// A projection of the read response, not a claim to validate the complete API DTO.
// Additional API properties are intentionally ignored and never copied into logs.
export function parseReadState(raw: unknown): ReadState {
  const v = record(raw);
  timestamp(v.asOf);
  const season = record(v.season);
  let active: ReadState["season"]["active"] = null;
  if (season.active !== null) {
    const a = record(season.active);
    if (a.startsAt !== null) timestamp(a.startsAt);
    if (a.endsAt !== null) timestamp(a.endsAt);
    active = {
      id: text(a.id),
      status: text(a.status),
      executionMode: text(a.executionMode),
      startsAt: a.startsAt as string | null,
      endsAt: a.endsAt as string | null,
    };
  }
  const w = record(v.wallet);
  let wallet: ReadState["wallet"];
  if (w.state === "unavailable")
    wallet = { state: "unavailable", code: text(w.code) };
  else if (w.state === "ok") {
    wallet = {
      state: "ok",
      seasonId: text(w.seasonId),
      seasonExecutionMode:
        w.seasonExecutionMode === null ? null : text(w.seasonExecutionMode),
      mode: w.mode === null ? null : text(w.mode),
      category: text(w.category),
      walletAddress: w.walletAddress === null ? null : text(w.walletAddress),
    };
  } else throw new Error("AMBIGUOUS_WALLET_STATE");
  return {
    asOf: v.asOf as string,
    mode: text(v.mode),
    category: category(v.category),
    season: { active },
    wallet,
  };
}
export function readStatePath(
  c: Category,
  mode: "real" | "demo" = "real",
): string {
  category(c);
  if (mode !== "real" && mode !== "demo") throw new Error("INVALID_MODE");
  return "/v1/me/state?category=" + c + "&mode=" + mode;
}

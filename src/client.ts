import { category, closed, integer, parseReadState, readStatePath, record, SOLANA_DEVNET_GENESIS, text, timestamp, type Category } from "./contract.ts";
import type { RankedEvidence, RankedEvidenceRequest } from "./ranked-proof.ts";

export type FetchPort = (url: string, init: RequestInit) => Promise<Response>;
export type RequestGuard = () => void | Promise<void>;
export interface Allowlist { seasonId: string; category: string; allowlistFrozen: boolean; tokens: { mint: string; decimals: number | null; exempt: boolean; eligible: boolean; symbol?: string | null }[] }
export class ClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: string, status: number | null, ambiguous: boolean, retryAfterMs: number | null = null) {
    super(code);
    this.name = "ClientError";
    this.code = code; this.status = status; this.ambiguous = ambiguous;
    this.retryAfterMs = retryAfterMs;
  }
}
export interface ClientOptions {
  origin: string;
  /** Use the reviewed same-origin API proxy on a read-only client. */
  apiBasePath?: "/api";
  credential: () => string | Promise<string>;
  transport?: FetchPort;
  timeoutMs?: number;
  maxResponseBytes?: number;
  writes?: "explicitly-authorized";
}
export interface OfficialProxyIdentity {
  accountId: string;
  actor: "trading_bot" | "ai_agent";
}
export type OfficialProxyOptions = Omit<ClientOptions, "apiBasePath" | "writes"> & OfficialProxyIdentity & {
  /** Check the separately approved live deployment and operator trading window. */
  authorizeWrite: RequestGuard;
};
const officialProxyPermit = Symbol("official ranked proxy");
export function uuid(v: unknown): string {
  const s = text(v);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new Error("INVALID_UUID");
  return s;
}
export function rawAmount(v: unknown): string {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > 18446744073709551615n) throw new Error("INVALID_RAW_AMOUNT");
  return v;
}
export function mint(v: unknown): string {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) throw new Error("INVALID_PUBLIC_KEY");
  return v;
}
function flag(v: unknown): boolean {
  if (typeof v !== "boolean") throw new Error("INVALID_BOOLEAN");
  return v;
}
function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : null;
}
function price(v: unknown): { price: string; expo: number; priceUsd: number } {
  const p = record(v);
  const amount = rawAmount(p.price);
  if (typeof p.priceUsd !== "number" || !Number.isFinite(p.priceUsd) || p.priceUsd <= 0) throw new Error("INVALID_PRICE");
  return { price: amount, expo: integer(p.expo, -18, 18), priceUsd: p.priceUsd };
}
export interface IntentInput {
  seasonId: string;
  category: Category;
  tokenInMint: string;
  tokenOutMint: string;
  amountIn: number;
  idempotencyKey: string;
}
export interface Intent { intentId: string; status: "built"; replayed: boolean }
const exactIntentInputBinding = "audacefi.swap-intent-input.v1";
export interface SingleQuote {
  kind: "single"; intentId: string; quoteId: string; mintMainnet: string; mintDevnet: string;
  direction: "buy" | "sell"; amountInRaw: string; price: string; expo: number; priceUsd: number;
  expiresAt: string; ttlSeconds: number;
}
export interface RouteQuote {
  kind: "route"; intentId: string; quoteId: string; quoteIdOut: string;
  mintInMainnet: string; mintInDevnet: string; mintOutMainnet: string; mintOutDevnet: string;
  amountInRaw: string; priceIn: ReturnType<typeof price>; priceOut: ReturnType<typeof price>;
  amountOutGrossRaw: string; feeRaw: string; feeBps: number; amountOutNetRaw: string;
  expiresAt: string; ttlSeconds: number;
}
export type Quote = SingleQuote | RouteQuote;
export function parseQuote(raw: unknown): Quote {
  const q = record(raw);
  timestamp(q.expiresAt);
  const base = { intentId: uuid(q.intentId), quoteId: uuid(q.quoteId), amountInRaw: rawAmount(q.amountInRaw), expiresAt: q.expiresAt as string, ttlSeconds: integer(q.ttlSeconds, 1, 300) };
  if (q.kind === "route") {
    if (typeof q.feeRaw !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(q.feeRaw)) throw new Error("INVALID_FEE");
    const gross = rawAmount(q.amountOutGrossRaw), net = rawAmount(q.amountOutNetRaw), fee = q.feeRaw;
    if (BigInt(gross) !== BigInt(net) + BigInt(fee)) throw new Error("INVALID_ROUTE_TOTAL");
    return { ...base, kind: "route", quoteIdOut: uuid(q.quoteIdOut), mintInMainnet: mint(q.mintInMainnet), mintInDevnet: mint(q.mintInDevnet), mintOutMainnet: mint(q.mintOutMainnet), mintOutDevnet: mint(q.mintOutDevnet), priceIn: price(q.priceIn), priceOut: price(q.priceOut), amountOutGrossRaw: gross, amountOutNetRaw: net, feeRaw: fee, feeBps: integer(q.feeBps, 0, 10000) };
  }
  if (q.kind !== undefined || (q.direction !== "buy" && q.direction !== "sell")) throw new Error("UNKNOWN_QUOTE_KIND");
  return { ...base, ...price(q), kind: "single", mintMainnet: mint(q.mintMainnet), mintDevnet: mint(q.mintDevnet), direction: q.direction };
}
export interface Submission {
  protocol: "audacefi.bench.submission.v1"; intentId: string; quoteId: string; quoteOutId: string | null;
  messageHash: string; playerSignature: string; playerPublicKey: string; txid: string; recordedAt: string;
  state: "RECORDED" | "SUBMITTED" | "UNKNOWN";
}
export interface SubmissionStatus {
  submission: Submission | null;
  resultStatus: "confirmed" | "failed" | null;
  /** Older deployments omit the terminal-status projection. */
  resultStatusKnown: boolean;
}
function signature(v: unknown): string {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v)) throw new Error("INVALID_SIGNATURE");
  return v;
}
export function parseSubmission(raw: unknown): Submission {
  const s = record(raw);
  if (s.protocol !== "audacefi.bench.submission.v1" || !["RECORDED", "SUBMITTED", "UNKNOWN"].includes(s.state as string)) throw new Error("UNSUPPORTED_SUBMISSION_PROTOCOL");
  if (typeof s.messageHash !== "string" || !/^[0-9a-f]{64}$/.test(s.messageHash)) throw new Error("INVALID_MESSAGE_HASH");
  timestamp(s.recordedAt);
  return { protocol: s.protocol, intentId: uuid(s.intentId), quoteId: uuid(s.quoteId), quoteOutId: s.quoteOutId === null ? null : uuid(s.quoteOutId), messageHash: s.messageHash, playerSignature: signature(s.playerSignature), playerPublicKey: mint(s.playerPublicKey), txid: signature(s.txid), recordedAt: s.recordedAt as string, state: s.state as Submission["state"] };
}

/** Explicit calls only. Construction/import performs no I/O. Credentials stay in memory. */
export class AudaceFiClient {
  readonly origin: string;
  readonly apiBasePath: "" | "/api";
  declare readonly officialProxyIdentity: Readonly<OfficialProxyIdentity> | undefined;
  #credential: ClientOptions["credential"];
  #transport: FetchPort;
  #timeout: number;
  #max: number;
  #writes: boolean;
  #officialProxy?: { identity: Readonly<OfficialProxyIdentity>; authorizeWrite: RequestGuard };
  constructor(options: ClientOptions, permit?: symbol) {
    const u = new URL(options.origin);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("HTTPS_ORIGIN_REQUIRED");
    const apiBasePath = options.apiBasePath;
    this.#writes = options.writes === "explicitly-authorized";
    if (apiBasePath !== undefined && apiBasePath !== "/api") throw new Error("UNSUPPORTED_API_BASE_PATH");
    if (apiBasePath && this.#writes && permit !== officialProxyPermit) throw new Error("API_BASE_PATH_READ_ONLY");
    this.origin = u.origin;
    this.apiBasePath = apiBasePath ?? "";
    Object.defineProperties(this, {
      origin: { writable: false, configurable: false },
      apiBasePath: { writable: false, configurable: false },
      officialProxyIdentity: { get: () => this.#officialProxy?.identity, configurable: false },
    });
    this.#credential = options.credential;
    this.#transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeout = integer(options.timeoutMs ?? 10000, 1, 60000);
    this.#max = integer(options.maxResponseBytes ?? 262144, 128, 1048576);
  }
  /** Construct only after separately qualifying the exact official proxy. No I/O here. */
  static forOfficialRankedProxy(options: OfficialProxyOptions): AudaceFiClient {
    const accountId = uuid(options.accountId), { actor, authorizeWrite } = options;
    if ((actor !== "trading_bot" && actor !== "ai_agent") || typeof authorizeWrite !== "function") {
      throw new Error("OFFICIAL_PROXY_APPROVAL_REQUIRED");
    }
    const client = new AudaceFiClient({ ...options, apiBasePath: "/api", writes: "explicitly-authorized" }, officialProxyPermit);
    client.#officialProxy = { identity: Object.freeze({ accountId, actor }), authorizeWrite };
    return client;
  }
  /** Whether POST methods were explicitly enabled at construction. */
  get writesAuthorized(): boolean { return this.#writes; }
  async #request(method: "GET" | "POST" | "CHECK_EXECUTE_SCOPE", path: string, body?: object, beforeSend?: RequestGuard, existingKey?: string): Promise<unknown> {
    const write = method === "POST";
    const checkExecute = method === "CHECK_EXECUTE_SCOPE";
    if (write && !this.#writes) throw new ClientError("WRITES_NOT_AUTHORIZED", null, false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, sent = false;
    try {
      // Only a write that reached the transport can be ambiguous.
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ClientError("REQUEST_TIMEOUT", null, write && sent)); }, this.#timeout); });
      const perform = async () => {
        let key: string;
        try { key = existingKey ?? await this.#credential(); } catch { throw new ClientError("CREDENTIAL_UNAVAILABLE", null, false); }
        if (typeof key !== "string" || key.length < 8 || key.length > 512 || !/^[A-Za-z0-9_.-]+$/.test(key)) throw new ClientError("INVALID_CREDENTIAL", null, false);
        if (controller.signal.aborted) throw new ClientError("REQUEST_TIMEOUT", null, false);
        try {
          if (this.#officialProxy && existingKey === undefined) {
            const { identity: { accountId, actor }, authorizeWrite } = this.#officialProxy;
            if (write || checkExecute) await authorizeWrite();
            if (controller.signal.aborted || !key.startsWith("afk_")) throw new Error("OFFICIAL_PROXY_ACCOUNT_MISMATCH");
            const me = record(await this.#request("GET", "/v1/me", undefined, undefined, key));
            const account = record(me.account);
            if (account.id !== accountId || account.participantType !== actor ||
                account.status !== "active" || me.onboardingComplete !== true) throw new Error("OFFICIAL_PROXY_ACCOUNT_MISMATCH");
            timestamp(account.participantTypeDeclaredAt);
            if ((write || checkExecute) && (!Array.isArray(me.credentialScopes) ||
                me.credentialScopes.length !== 2 || !me.credentialScopes.includes("read") || !me.credentialScopes.includes("execute"))) {
              throw new ClientError("EXECUTE_SCOPE_REQUIRED", null, false);
            }
          }
          if (controller.signal.aborted) throw new Error("REQUEST_TIMEOUT");
          await beforeSend?.();
        } catch (error) {
          if (error instanceof ClientError && error.code === "EXECUTE_SCOPE_REQUIRED") throw error;
          throw new ClientError("GUARD_REFUSED_BEFORE_SEND", null, false);
        }
        if (controller.signal.aborted) throw new ClientError("REQUEST_TIMEOUT", null, false);
        if (checkExecute) return undefined;
        sent = true;
        const url = this.origin + this.apiBasePath + path;
        const response = await this.#transport(url, { method, headers: { Authorization: "Bearer " + key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
        key = "";
        if (response.redirected || (response.url && (new URL(response.url).origin !== this.origin ||
            (this.#officialProxy && response.url !== url)))) throw new ClientError("REDIRECT_REFUSED", response.status, write);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          const delay = response.status === 429 ? retryAfter(response.headers.get("retry-after")) : null;
          throw new ClientError("HTTP_" + response.status, response.status, write, delay);
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new ClientError("JSON_RESPONSE_REQUIRED", response.status, write);
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.#max)) throw new ClientError("RESPONSE_TOO_LARGE", response.status, write);
        const reader = response.body?.getReader();
        if (!reader) throw new ClientError("EMPTY_RESPONSE", response.status, write);
        const chunks: Uint8Array[] = []; let total = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > this.#max) throw new ClientError("RESPONSE_TOO_LARGE", response.status, write); chunks.push(value); }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(total); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
        catch { throw new ClientError("INVALID_JSON_RESPONSE", response.status, write); }
      };
      return await Promise.race([perform(), deadline]);
    } catch (error) {
      // Once a write reached the transport, no error (even a ClientError thrown by an injected transport) can prove it was not received.
      if (error instanceof ClientError) throw write && sent && !error.ambiguous ? new ClientError(error.code, error.status, true, error.retryAfterMs) : error;
      // Neither transport exceptions nor remote bodies are attached as causes or logged.
      throw new ClientError("TRANSPORT_FAILURE", null, write);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async #post<T>(path: string, body: object, parse: (raw: unknown) => T, beforeSend?:RequestGuard): Promise<T> {
    const raw = await this.#request("POST",path,body,beforeSend);
    try { return parse(raw); }
    catch { throw new ClientError("INVALID_WRITE_RESPONSE",null,true); }
  }
  /** Check the exact official bearer before reserving. Each write rechecks its own bearer. */
  async assertExecuteScope(): Promise<void> {
    if (this.#officialProxy) await this.#request("CHECK_EXECUTE_SCOPE", "/v1/me");
  }
  async readState(c: Category, mode: "real" | "demo" = "real") {
    const state = parseReadState(await this.#request("GET", readStatePath(c, mode)));
    if (state.category !== c || state.mode !== mode) throw new ClientError("STATE_CONTEXT_MISMATCH", null, false);
    return state;
  }
  async readAllowlist(c: Category, seasonId: string): Promise<Allowlist> {
    category(c); uuid(seasonId);
    const raw = record(await this.#request("GET", "/v1/me/allowlist?category=" + c.replace("-", "_") + "&mode=real"));
    if (raw.seasonId !== seasonId || raw.category !== c.replace("-", "_") || !Array.isArray(raw.tokens) || raw.tokens.length > 2048) throw new ClientError("ALLOWLIST_CONTEXT_MISMATCH", null, false);
    const tokens = raw.tokens.map(value => {
      const t = record(value);
      const symbol = typeof t.symbol === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(t.symbol) ? t.symbol.toUpperCase() : t.symbol === null ? null : undefined;
      return { mint: mint(t.mint), decimals: t.decimals === null ? null : integer(t.decimals, 0, 9), exempt: flag(t.exempt), eligible: flag(t.eligible), ...(symbol === undefined ? {} : { symbol }) };
    });
    if (new Set(tokens.map(t => t.mint)).size !== tokens.length) throw new ClientError("DUPLICATE_ALLOWLIST_MINT", null, false);
    return { seasonId, category: raw.category as string, allowlistFrozen: flag(raw.allowlistFrozen), tokens };
  }
  async createIntent(input: IntentInput,beforeSend?:RequestGuard,requireExactBinding = false): Promise<Intent> {
    uuid(input.seasonId); category(input.category); mint(input.tokenInMint); mint(input.tokenOutMint);
    if (input.tokenInMint === input.tokenOutMint || !Number.isFinite(input.amountIn) || input.amountIn <= 0 || input.amountIn > 1e12 || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new Error("INVALID_INTENT");
    const body = { seasonId: input.seasonId, category: input.category.replace("-", "_"), tokenInMint: input.tokenInMint, tokenOutMint: input.tokenOutMint, amountIn: input.amountIn, idempotencyKey: input.idempotencyKey, surface: "api", ...(requireExactBinding ? { inputBinding: exactIntentInputBinding } : {}) };
    return this.#post("/v1/swap-intents",body,raw=>{ const v=record(raw);
    if (requireExactBinding && v.inputBinding !== exactIntentInputBinding) throw new ClientError("INTENT_INPUT_BINDING_UNAVAILABLE", null, true);
    if (v.status !== "built") throw new ClientError("INTENT_NOT_BUILT", null, true);
    return { intentId: uuid(v.intentId), status: "built" as const, replayed: flag(v.replayed) }; },beforeSend);
  }
  async quote(intentId: string, amountInRaw: string,beforeSend?:RequestGuard): Promise<Quote> {
    return this.#post("/v1/swap-intents/"+uuid(intentId)+"/quote",{amountInRaw:rawAmount(amountInRaw)},raw=>{const q=parseQuote(raw);
    if (q.intentId !== intentId || q.amountInRaw !== amountInRaw) throw new ClientError("QUOTE_CONTEXT_MISMATCH", null, true);
    return q; },beforeSend);
  }
  async recordSignature(intentId: string, playerSignature: string,beforeSend?:RequestGuard): Promise<void> {
    await this.#post("/v1/swap-intents/"+uuid(intentId)+"/signature",{signature:signature(playerSignature)},raw=>{ const v=record(raw);
    if (v.intentId !== intentId || v.status !== "signed") throw new ClientError("SIGNATURE_CONTEXT_MISMATCH", null, true);
    },beforeSend);
  }
  async submitDurable(intentId: string, input: { quoteId: string; quoteOutId?: string; transaction: string },beforeSend?:RequestGuard): Promise<Submission> {
    uuid(input.quoteId); if (input.quoteOutId !== undefined) uuid(input.quoteOutId);
    if (typeof input.transaction !== "string" || input.transaction.length < 64 || input.transaction.length > 1800 || Buffer.from(input.transaction, "base64").toString("base64") !== input.transaction) throw new Error("INVALID_TRANSACTION_ENCODING");
    return this.#post("/v1/swap-intents/"+uuid(intentId)+"/submit-durable",{quoteId:input.quoteId,...(input.quoteOutId?{quoteOutId:input.quoteOutId}:{}),transaction:input.transaction},raw=>{const s=parseSubmission(raw);
    if (s.intentId !== intentId || s.quoteId !== input.quoteId || s.quoteOutId !== (input.quoteOutId ?? null)) throw new ClientError("SUBMISSION_CONTEXT_MISMATCH", null, true);
    return s; },beforeSend);
  }
  async readSubmission(intentId: string): Promise<Submission | null> {
    return (await this.readSubmissionStatus(intentId)).submission;
  }
  async readSubmissionStatus(intentId: string): Promise<SubmissionStatus> {
    const v = record(await this.#request("GET", "/v1/swap-intents/" + uuid(intentId) + "/submission"));
    if (v.protocol !== "audacefi.bench.submission.v1") throw new ClientError("UNSUPPORTED_SUBMISSION_PROTOCOL", null, false);
    const resultStatusKnown = Object.hasOwn(v, "resultStatus");
    const resultStatus = resultStatusKnown ? v.resultStatus : null;
    if (resultStatus !== null && resultStatus !== "confirmed" && resultStatus !== "failed") {
      throw new ClientError("INVALID_SUBMISSION_RESULT_STATUS", null, false);
    }
    const submission = v.submission === null ? null : parseSubmission(v.submission);
    if (submission ? submission.intentId !== intentId : resultStatus !== null) {
      throw new ClientError("SUBMISSION_CONTEXT_MISMATCH", null, false);
    }
    return { submission, resultStatus, resultStatusKnown };
  }
  /** Read the account's exact ranked fill when the deployment supports the evidence protocol. */
  async readRankedEvidence(input: Readonly<RankedEvidenceRequest>): Promise<RankedEvidence | null> {
    const apiBasePath = input.apiBasePath;
    const expected = {
      operationKey: input.operationKey, seasonId: uuid(input.seasonId), accountId: uuid(input.accountId),
      actor: input.actor, category: input.category, playerPublicKey: mint(input.playerPublicKey),
      intentId: uuid(input.intentId), txid: signature(input.txid),
    };
    if (input.origin !== this.origin || input.genesisHash !== SOLANA_DEVNET_GENESIS ||
        (apiBasePath !== undefined && apiBasePath !== this.apiBasePath) ||
        (this.#officialProxy && (apiBasePath !== this.apiBasePath ||
          expected.accountId !== this.#officialProxy.identity.accountId || expected.actor !== this.#officialProxy.identity.actor)) ||
        typeof expected.operationKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(expected.operationKey) ||
        expected.category !== "crypto-bro" ||
        (expected.actor !== "trading_bot" && expected.actor !== "ai_agent")) {
      throw new ClientError("RANKED_EVIDENCE_CONTEXT_MISMATCH", null, false);
    }
    const path = "/v1/swap-intents/" + expected.intentId + "/ranked-evidence";
    let raw: unknown;
    try {
      raw = await this.#request("GET", path);
    } catch (error) {
      if (!(error instanceof ClientError) || error.status !== 429 || error.retryAfterMs === null || error.retryAfterMs > 10_000) throw error;
      const delay = Math.max(1000, error.retryAfterMs);
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      raw = await this.#request("GET", path);
    }
    try {
      const envelope = closed(raw, ["protocol", "evidence"]);
      if (envelope.protocol !== "audacefi.bench.ranked-evidence.v1") throw new Error("UNSUPPORTED_RANKED_EVIDENCE_PROTOCOL");
      if (envelope.evidence === null) return null;
      const evidence = closed(envelope.evidence, ["trade", "leaderboard"]);
      const trade = closed(evidence.trade, [...Object.keys(expected), "amountInRaw", "amountOutRaw", "feeRaw"]);
      const leaderboard = closed(evidence.leaderboard, [
        "seasonId", "accountId", "category", "division", "rank", "asOf", "includedIntentId", "includedTxid",
      ]);
      if (Object.entries(expected).some(([key, value]) => !Object.hasOwn(trade, key) || trade[key] !== value) ||
          leaderboard.seasonId !== expected.seasonId || leaderboard.accountId !== expected.accountId ||
          leaderboard.category !== expected.category || leaderboard.includedIntentId !== expected.intentId ||
          leaderboard.includedTxid !== expected.txid) throw new Error("RANKED_EVIDENCE_CONTEXT_MISMATCH");
      const division = leaderboard.division;
      if (division !== "A" && division !== "B" && division !== "C") throw new Error("RANKED_EVIDENCE_DIVISION_INVALID");
      return {
        trade: {
          ...expected, origin: this.origin, genesisHash: SOLANA_DEVNET_GENESIS,
          ...(apiBasePath ? { apiBasePath } : {}),
          amountInRaw: rawAmount(trade.amountInRaw), amountOutRaw: rawAmount(trade.amountOutRaw),
          feeRaw: trade.feeRaw === "0" ? "0" : rawAmount(trade.feeRaw),
        },
        leaderboard: {
          seasonId: expected.seasonId, accountId: expected.accountId, category: expected.category,
          division, rank: integer(leaderboard.rank, 1), asOf: new Date(timestamp(leaderboard.asOf)).toISOString(),
          includedIntentId: expected.intentId, includedTxid: expected.txid,
        },
      };
    } catch {
      throw new ClientError("INVALID_RANKED_EVIDENCE_RESPONSE", null, false);
    }
  }
  async recordConfirmedResult(intentId: string, status: "confirmed" | "failed", beforeSend?: RequestGuard): Promise<void> {
    if (status !== "confirmed" && status !== "failed") throw new Error("INVALID_FINAL_RESULT");
    await this.#post("/v1/swap-intents/"+uuid(intentId)+"/result",{status},raw=>{const v=record(raw);
    if (v.intentId !== intentId || v.status !== status) throw new ClientError("RESULT_CONTEXT_MISMATCH", null, true);
    },beforeSend);
  }
}

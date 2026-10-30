import { integer, record } from "./contract.ts";
import type { FetchPort } from "./client.ts";

const methods = ["getGenesisHash", "getLatestBlockhash", "getBlockHeight", "getMultipleAccounts", "getFeeForMessage", "getMinimumBalanceForRentExemption", "isBlockhashValid", "getTransaction", "getSignatureStatuses"] as const;
export type ReadMethod = typeof methods[number];
export interface RpcPort { call(method: ReadMethod, params: readonly unknown[]): Promise<unknown> }
export class RpcError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; this.name = "RpcError"; } }
/** Explicit, read-method-only JSON-RPC transport. Construction performs no I/O. */
export class SolanaRpcReader implements RpcPort {
  /** Origin only: a provider path may carry a token and stays private. */
  readonly origin: string;
  #endpoint: string; #transport: FetchPort; #auth: (() => string | Promise<string>) | undefined; #timeout: number; #max: number; #id = 0;
  constructor(options: { endpoint: string; transport?: FetchPort; bearer?: () => string | Promise<string>; timeoutMs?: number; maxResponseBytes?: number }) {
    let url: URL; try { url = new URL(options.endpoint); } catch { throw new RpcError("INVALID_RPC_ENDPOINT"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new RpcError("INVALID_RPC_ENDPOINT");
    this.#endpoint = url.href; this.origin = url.origin;
    this.#transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
    this.#auth = options.bearer;
    this.#timeout = integer(options.timeoutMs ?? 10000, 1, 60000);
    this.#max = integer(options.maxResponseBytes ?? 2097152, 1024, 4194304);
  }
  async call(method: ReadMethod, params: readonly unknown[]): Promise<unknown> {
    if (!(methods as readonly string[]).includes(method) || !Array.isArray(params) || params.length > 4) throw new RpcError("RPC_METHOD_REFUSED");
    const id = ++this.#id, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RpcError("RPC_TIMEOUT")); }, this.#timeout); });
      const request = async () => {
        let token = "";
        if (this.#auth) {
          try { token = await this.#auth(); } catch { throw new RpcError("RPC_AUTH_UNAVAILABLE"); }
          if (!/^[A-Za-z0-9._~-]{8,512}$/.test(token)) throw new RpcError("INVALID_RPC_AUTH");
        }
        if (controller.signal.aborted) throw new RpcError("RPC_TIMEOUT");
        const response = await this.#transport(this.#endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
        token = "";
        if (response.redirected || (response.url && response.url !== this.#endpoint)) throw new RpcError("RPC_REDIRECT_REFUSED");
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new RpcError("RPC_HTTP_" + response.status); }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new RpcError("RPC_JSON_REQUIRED");
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.#max)) throw new RpcError("RPC_RESPONSE_LIMIT");
        const reader = response.body?.getReader(); if (!reader) throw new RpcError("RPC_EMPTY_RESPONSE");
        const chunks: Uint8Array[] = []; let total = 0;
        try {
          for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > this.#max) throw new RpcError("RPC_RESPONSE_LIMIT"); chunks.push(next.value); }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        let body: Record<string, unknown>;
        try { body = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { throw new RpcError("RPC_INVALID_JSON"); }
        if (body.jsonrpc !== "2.0" || body.id !== id || "error" in body || !("result" in body)) throw new RpcError("RPC_INVALID_ENVELOPE");
        return body.result;
      };
      return await Promise.race([request(), timeout]);
    } catch (error) { if (error instanceof RpcError) throw error; throw new RpcError("RPC_READ_FAILED"); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
}

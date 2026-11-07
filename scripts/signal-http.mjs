import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = "127.0.0.1";
const maxBodyBytes = 512;
const timeout = Symbol("timeout");
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const scopePattern = /^[0-9a-f]{64}$/;
const validToken = token => typeof token === "string" && tokenPattern.test(token) && !/^afk_/i.test(token);
const sha256 = (value) => createHash("sha256").update(value).digest();

async function within(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds, timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(request, length) {
  const body = Buffer.alloc(length);
  let received = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk) || received + chunk.length > length) throw new Error("INVALID_BODY");
    chunk.copy(body, received);
    received += chunk.length;
  }
  if (received !== length) throw new Error("INVALID_BODY");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
}

/** Wrap the existing gateway without a second queue, retry policy or journal. */
export function createSignalHttpHandler({
  port, token, runScope, parse, accept, bodyTimeoutMs = 3000, responseTimeoutMs = 60_000,
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !validToken(token) || typeof runScope !== "string" || !scopePattern.test(runScope) ||
      typeof parse !== "function" || typeof accept !== "function" ||
      !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 3000 ||
      !Number.isInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > 60_000) {
    throw new Error("INVALID_SIGNAL_HTTP_CONFIGURATION");
  }
  const authority = `${host}:${port}`;
  const expectedToken = sha256(token);
  let active;

  async function handle(request, response) {
    const reply = (status, body, headers = {}) => {
      if (response.destroyed) return;
      const data = JSON.stringify(body);
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "Cache-Control": "no-store",
        Connection: "close",
        ...headers,
      });
      response.end(data);
    };
    const refuse = (status, code, headers) => reply(status, { status: "rejected", code }, headers);
    const headers = request.headersDistinct;
    const header = (name) => headers[name]?.length === 1 ? headers[name][0] : undefined;
    if (request.socket.remoteAddress !== host || header("host") !== authority || headers.origin || headers.upgrade) {
      return refuse(403, "LOOPBACK_REQUIRED");
    }
    if (request.url !== "/signal" && request.url !== "/scope") return refuse(404, "ROUTE_NOT_FOUND");
    const supplied = header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
    if (supplied === undefined || !timingSafeEqual(expectedToken, sha256(supplied))) {
      return refuse(401, "UNAUTHORIZED", { "WWW-Authenticate": "Bearer" });
    }
    if (request.url === "/scope") {
      if (request.method !== "GET") return refuse(405, "GET_REQUIRED", { Allow: "GET" });
      if (headers["transfer-encoding"] || (headers["content-length"] && header("content-length") !== "0")) {
        return refuse(400, "SCOPE_REQUEST_BODY_REFUSED");
      }
      return reply(200, { runScope });
    }
    if (request.method !== "POST") return refuse(405, "POST_REQUIRED", { Allow: "POST" });
    if (header("x-audacefi-run-scope") !== runScope) return refuse(409, "SIGNAL_RUN_SCOPE_MISMATCH");
    const type = header("content-type");
    if (!type || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type) ||
        headers["transfer-encoding"] || headers["content-encoding"]) {
      return refuse(415, "JSON_REQUIRED");
    }
    const declared = header("content-length");
    if (!declared || !/^[1-9][0-9]{0,9}$/.test(declared)) return refuse(411, "CONTENT_LENGTH_REQUIRED");
    const length = Number(declared);
    if (length > maxBodyBytes) return refuse(413, "SIGNAL_TOO_LARGE");
    if (active) return refuse(429, "SIGNAL_IN_PROGRESS", { "Retry-After": "1" });

    let release;
    active = new Promise((resolve) => { release = resolve; });
    const idle = () => { active = undefined; release(); };
    let submitted = false;
    try {
      const line = await within(readBody(request, length), bodyTimeoutMs);
      if (line === timeout) return refuse(408, "SIGNAL_BODY_TIMEOUT");
      const signal = parse(line);
      if (response.destroyed || request.aborted) return;
      const outcome = Promise.resolve().then(() => accept(line));
      submitted = true;
      void outcome.then(idle, idle);
      const receipt = await within(outcome, responseTimeoutMs);
      if (receipt === timeout) return reply(504, { status: "unknown", code: "SIGNAL_RESPONSE_TIMEOUT" });
      reply(200, { ...receipt, signalId: signal.id, sequence: signal.sequence });
    } catch {
      if (submitted) return reply(502, { status: "unknown", code: "SIGNAL_OUTCOME_UNKNOWN" });
      return refuse(400, "INVALID_SIGNAL");
    } finally {
      if (!submitted) idle();
    }
  }

  return { handle, drain: () => active ?? Promise.resolve() };
}

async function main() {
  const [execute, operatorFlag, operator, portFlag, rawPort, ...targetArgs] = process.argv.slice(2);
  const official = targetArgs.length === 2 && targetArgs[0] === "--target" && targetArgs[1] === "official";
  if (execute !== "--execute" || operatorFlag !== "--operator" || !operator ||
      !isAbsolute(operator) || !operator.endsWith(".mjs") || portFlag !== "--port" ||
      !/^[1-9][0-9]{3,4}$/.test(rawPort ?? "") || Number(rawPort) < 1024 || Number(rawPort) > 65535 ||
      (targetArgs.length !== 0 && !official)) {
    process.stderr.write("Usage: npm run signal:http -- --execute --operator <absolute trusted module.mjs> --port <1024-65535> [--target official]\n");
    process.exitCode = 2;
    return;
  }
  const port = Number(rawPort);
  const { default: setup, signalHttpToken } = await import(pathToFileURL(operator).href);
  const { openRankedSignalOperator } = await import("../dist/ranked-signal.js");
  const { parseSpotSignal } = await import("../dist/index.js");
  try {
    if (!validToken(signalHttpToken)) throw new Error("INVALID_SIGNAL_HTTP_TOKEN");
    const { accept, runScope } = await openRankedSignalOperator(setup, official ? "official" : "validation");
    const { handle, drain } = createSignalHttpHandler({ port, token: signalHttpToken, runScope, parse: parseSpotSignal, accept });
    const server = createServer({
      maxHeaderSize: 4096, headersTimeout: 3000, requestTimeout: 5000, keepAliveTimeout: 1000,
      connectionsCheckingInterval: 1000,
    }, (request, response) => {
      void handle(request, response).catch(() => response.destroy());
    });
    server.maxConnections = 8;
    server.maxRequestsPerSocket = 1;
    server.on("checkContinue", (_request, response) => response.writeHead(417, { Connection: "close" }).end());
    const stop = () => server.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const closed = once(server, "close");
      server.listen(port, host);
      await closed;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await drain();
    }
  } finally {
    await setup?.close?.();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("The local signal receiver stopped. Inspect the operator journal before restarting.\n");
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createSignalHttpHandler } from "../scripts/signal-http.mjs";
import { parseSpotSignal } from "../src/signals.ts";

const token = "a".repeat(32);
const runScope = "1".repeat(64);
const line = JSON.stringify({
  id: "signal-001", sequence: 1, symbol: "PILOT", side: "long", targetBps: 1, expiresAtMs: 1000,
});

function request({ body = Buffer.from(line), bodyStream, headers = {}, ...rest } = {}) {
  return Object.assign(bodyStream ?? Readable.from([body]), {
    method: "POST", url: "/signal", socket: { remoteAddress: "127.0.0.1" },
    headersDistinct: {
      host: ["127.0.0.1:8787"], authorization: [`Bearer ${token}`],
      "content-type": ["application/json; charset=utf-8"], "content-length": [String(body.length)],
      "x-audacefi-run-scope": [runScope],
      ...headers,
    },
    ...rest,
  });
}

async function send(handle, incoming = request()) {
  const result = {};
  await handle(incoming, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); },
    end(body) { result.body = JSON.parse(body); },
  });
  return result;
}

function receiver(accept, options = {}) {
  return createSignalHttpHandler({ port: 8787, token, runScope, parse: parseSpotSignal, accept, ...options });
}

test("an authenticated loopback POST passes the exact signal to the existing gateway", async () => {
  const calls = [];
  const receipt = { status: "ranking-pending", ranked: false };
  const { handle } = receiver(async (raw) => { calls.push(raw); return receipt; });
  assert.deepEqual(calls, []);
  const result = await send(handle);
  assert.deepEqual(calls, [line]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ...receipt, signalId: "signal-001", sequence: 1 });
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers.Connection, "close");
});

test("invalid scope, authentication and HTTP inputs are refused before the gateway", async () => {
  let calls = 0;
  const { handle } = receiver(async () => { calls++; });
  const cases = [
    [request({ socket: { remoteAddress: "192.0.2.1" } }), 403],
    [request({ headers: { host: ["other.invalid:8787"] } }), 403],
    [request({ headers: { origin: ["http://127.0.0.1:8787"] } }), 403],
    [request({ url: "/signal?token=fixture" }), 404],
    [request({ method: "GET" }), 405],
    [request({ headers: { authorization: [`Bearer ${"b".repeat(32)}`] } }), 401],
    [request({ headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] } }), 401],
    [request({ headers: { "x-audacefi-run-scope": [] } }), 409],
    [request({ headers: { "x-audacefi-run-scope": ["2".repeat(64)] } }), 409],
    [request({ headers: { "x-audacefi-run-scope": [runScope, runScope] } }), 409],
    [request({ headers: { "content-type": ["text/plain"] } }), 415],
    [request({ headers: { "transfer-encoding": ["chunked"] } }), 415],
    [request({ headers: { "content-encoding": ["gzip"] } }), 415],
    [request({ headers: { "content-length": [] } }), 411],
    [request({ body: Buffer.alloc(513) }), 413],
    [request({ body: Buffer.from([0xff]) }), 400],
    [request({ body: Buffer.from(line.replace('"sequence":1', '"sequence":1,"sequence":2')) }), 400],
    [request({ headers: { "content-length": [String(Buffer.byteLength(line) + 1)] } }), 400],
  ];
  for (const [incoming, expected] of cases) assert.equal((await send(handle, incoming)).status, expected);
  assert.equal(calls, 0);
});

test("scope discovery is authenticated and does not admit a signal", async () => {
  const { handle } = receiver(() => assert.fail("scope discovery admitted a signal"));
  const incoming = request({ method: "GET", url: "/scope", body: Buffer.alloc(0) });
  assert.deepEqual((await send(handle, incoming)).body, { runScope });
  const denied = request({ method: "GET", url: "/scope", headers: { authorization: [] } });
  assert.equal((await send(handle, denied)).status, 401);
  assert.throws(() => receiver(() => {}, { token: "afk_" + token }), /INVALID_SIGNAL_HTTP_CONFIGURATION/);
});

test("an incomplete body times out before admission", async () => {
  let calls = 0;
  const { handle, drain } = receiver(async () => { calls++; }, { bodyTimeoutMs: 10 });
  const bodyStream = new Readable({ read() {} });
  try {
    assert.deepEqual((await send(handle, request({ bodyStream }))).body,
      { status: "rejected", code: "SIGNAL_BODY_TIMEOUT" });
    await drain();
    assert.equal(calls, 0);
  } finally {
    bodyStream.destroy();
  }
});

test("a response deadline preserves the in-flight slot until the gateway settles", async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const { handle, drain } = receiver(async () => { calls++; return pending; }, { responseTimeoutMs: 10 });
  const timedOut = await send(handle);
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.body, { status: "unknown", code: "SIGNAL_RESPONSE_TIMEOUT" });
  const busy = await send(handle);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers["Retry-After"], "1");
  assert.equal(calls, 1);
  release({ status: "ranked", ranked: true });
  await drain();
  assert.equal((await send(handle)).status, 200);
  assert.equal(calls, 2);
});

test("gateway errors are redacted and reported as unknown", async () => {
  const { handle } = receiver(async () => { throw new Error("fixture credential detail"); });
  const result = await send(handle);
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { status: "unknown", code: "SIGNAL_OUTCOME_UNKNOWN" });
});

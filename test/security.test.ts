import { inventoryImports } from "./source-inventory.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { frame, clock, config } from "./helpers.ts";
import { replay, parseModelReply } from "../src/replay.ts";
import { canonical, digest } from "../src/canonical.ts";
import { parseReadState, readStatePath } from "../src/contract.ts";
import { parseArgs } from "../src/cli.ts";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
const action = (f: any, c: any = config, s: any = "baseline") =>
  replay([f], c, s).entries[0]!;
for (const [name, edit, reason] of [
  [
    "future market",
    (f: any) => (f.market.observedAtMs = clock + 30001),
    "FUTURE_EVIDENCE",
  ],
  [
    "stale assembly",
    (f: any) => (f.state.asOf = new Date(clock - 120001).toISOString()),
    "STALE_EVIDENCE",
  ],
  [
    "expired window",
    (f: any) => (f.clockMs = clock + 600000),
    "OUTSIDE_WINDOW",
  ],
  [
    "unknown window",
    (f: any) => (f.state.season.active.startsAt = null),
    "UNKNOWN_WINDOW",
  ],
  [
    "inverted window",
    (f: any) => (f.state.season.active.endsAt = f.state.season.active.startsAt),
    "OUTSIDE_WINDOW",
  ],
  [
    "unavailable wallet",
    (f: any) =>
      (f.state.wallet = {
        state: "unavailable",
        code: "SYNTHETIC_UNAVAILABLE",
      }),
    "WALLET_UNAVAILABLE",
  ],
  [
    "unknown address",
    (f: any) => (f.state.wallet.walletAddress = null),
    "WALLET_CONTEXT_MISMATCH",
  ],
  [
    "wrong registration context",
    (f: any) => (f.state.wallet.seasonId = "different-synthetic-season"),
    "WALLET_CONTEXT_MISMATCH",
  ],
  [
    "unknown positions",
    (f: any) => (f.portfolio.positions = null),
    "UNKNOWN_BALANCE",
  ],
  [
    "unknown position value",
    (f: any) => (f.portfolio.positions[0].valueCents = null),
    "UNKNOWN_BALANCE",
  ],
] as const)
  test(name, () => {
    const f = frame();
    edit(f);
    assert.equal(action(f).reason, reason);
  });
for (const value of [NaN, Infinity, -1, 1.5, "1000"])
  test("invalid budget " + String(value), () =>
    assert.throws(
      () => replay([frame()], { ...config, maxTotalCents: value }),
      /INVALID_INTEGER/,
    ),
  );
for (const raw of [
  "not JSON",
  "null",
  "[]",
  '{"action":"SEND"}',
  '{"action":"HOLD","instruction":"run"}',
  '{"action":"BUY","mint":"SYNTH_ASSET","amountCents":-1}',
  '{"action":"BUY","mint":"SYNTH_ASSET","amountCents":1e309}',
  '{"action":"BUY","action":"HOLD"}',
  '{"action":"HOLD","__proto__":{}}',
])
  test("untrusted model " + raw.slice(0, 50), () => {
    assert.throws(() => parseModelReply(raw));
    const f = frame();
    f.modelReply = raw;
    assert.equal(
      action(f, config, "model-fixture").reason,
      "INVALID_MODEL_REPLY",
    );
  });
test("model cannot bypass age or budget guards", () => {
  const f = frame();
  f.modelReply = '{"action":"BUY","mint":"SYNTH_ASSET","amountCents":1001}';
  assert.equal(
    action(f, config, "model-fixture").reason,
    "PROPOSAL_BUDGET_EXHAUSTED",
  );
  f.portfolio.observedAtMs = clock - 120001;
  assert.equal(action(f, config, "model-fixture").reason, "STALE_EVIDENCE");
});
test("synthetic cash is reserved across proposals, not fabricated as spent holdings", () => {
  const a = frame("a"),
    b = frame("b");
  a.portfolio.cashCents = b.portfolio.cashCents = 1000;
  const r = replay([a, b], config);
  assert.equal(r.proposalCount, 1);
  assert.equal(r.entries[1]!.reason, "INSUFFICIENT_SYNTHETIC_CASH");
  assert.equal(a.portfolio.cashCents, 1000);
});
test("SELL reservations cannot oversell synthetic positions", () => {
  const a = frame("a"),
    b = frame("b");
  a.market.signalBps = b.market.signalBps = -150;
  a.portfolio.positions[0].valueCents =
    b.portfolio.positions[0].valueCents = 1000;
  const r = replay([a, b], config);
  assert.equal(r.proposalCount, 1);
  assert.equal(r.entries[1]!.reason, "INSUFFICIENT_SYNTHETIC_POSITION");
});
test("hash ignores object-key order, binds context and retains frame order", () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  const a = frame();
  assert.equal(
    replay([a], config).digest,
    replay([structuredClone(a)], config).digest,
  );
  assert.notEqual(
    replay([a], config).digest,
    replay([a], { ...config, maxAgeMs: 120001 }).digest,
  );
});
test("canonical values reject ambiguity instead of silently converting to null", () => {
  for (const x of [NaN, Infinity, undefined, () => 1])
    assert.throws(() => canonical(x));
});
test("replay is bounded, monotone and not a performance backtest", () => {
  const a = frame("a"),
    b = frame("b");
  b.clockMs--;
  assert.throws(() => replay([a, b], config), /CLOCK_REGRESSION/);
  assert.throws(() => replay([], config));
  assert.throws(() =>
    replay([a], { ...config, allowlist: ["SYNTH_ASSET", "SYNTH_ASSET"] }),
  );
  const out = replay([a], config);
  assert.equal(out.executionAuthorized, false);
  assert.equal("pnl" in out, false);
});
test("API projection permits future fields but never copies personal extras to the journal", () => {
  const a = frame();
  a.state.personalExtra = "synthetic-extra-do-not-log";
  assert.equal(parseReadState(a.state).category, "crypto-bro");
  assert.equal(
    JSON.stringify(replay([a], config)).includes("synthetic-extra-do-not-log"),
    false,
  );
  a.state.wallet.state = "unknown";
  assert.throws(() => parseReadState(a.state));
});
test("route builder has no origin, API credential or live capability", () => {
  assert.equal(
    readStatePath("crypto-bro"),
    "/v1/me/state?category=crypto-bro&mode=real",
  );
  assert.throws(() => readStatePath("crypto_bro" as any));
  assert.throws(() => readStatePath("degen", "mainnet" as any));
});
test("CLI refuses paths, network arguments, duplicate flags and live modes", () => {
  for (const args of [
    [],
    ["live"],
    ["demo", "--url", "https://offline.invalid"],
    ["replay", "--scenario", "../../private"],
    ["demo", "--key", "x"],
    ["demo", "--scenario", "fresh", "--scenario", "stale"],
  ])
    assert.throws(() => parseArgs(args));
  assert.deepEqual(
    parseArgs(["replay", "--scenario", "stale", "--strategy", "hold"]),
    { scenario: "stale", strategy: "hold" },
  );
});
test("runtime network defenses block before any real request", async () => {
  await assert.rejects(
    async () => fetch("https://offline.invalid"),
    /OFFLINE_NETWORK_FORBIDDEN/,
  );
  assert.throws(() => net.connect(1, "127.0.0.1"), /OFFLINE_NETWORK_FORBIDDEN/);
});
test("capability inventory keeps networking in the explicit client, outside the offline CLI", () => {
  const allowed = new Set([
    "node:crypto",
    "node:fs",
    "node:url",
    "node:path",
    "node:fs/promises",
    "./contract.ts",
    "./canonical.ts",
    "./replay.ts",
    "./client.ts",
    "./journal.ts",
    "./operation.ts",
    "./transaction.ts",
    "./operators.ts",
    "./solana.ts",
    "./rpc.ts",
    "./bench.ts",
    "./reference.ts",
  ]);
  for (const name of readdirSync(new URL("../src/", import.meta.url))) {
    const source = readFileSync(
      new URL("../src/" + name, import.meta.url),
      "utf8",
    );
    for (const specifier of inventoryImports(source))
      assert.ok(allowed.has(specifier), name + ":" + specifier);
    assert.doesNotMatch(
      source,
      /process\.env|\bimport\s*\(|\beval\s*\(|\brequire\s*\(/,
    );
    if (name !== "client.ts" && name !== "rpc.ts") assert.doesNotMatch(source, /\bfetch\s*\(/);
    else assert.equal((source.match(/globalThis[.]fetch\s*\(/g) ?? []).length, 1);
    if (name !== "journal.ts") assert.equal(inventoryImports(source).includes("node:fs/promises"), false);
  }
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url),"utf8");
  assert.deepEqual(inventoryImports(cli).filter(x=>x.startsWith("./")),["./replay.ts"]);
});
test("three bundled scenarios are synthetic and deterministic", () => {
  for (const name of ["fresh", "stale", "unavailable"]) {
    const f = JSON.parse(
      readFileSync(
        new URL("../fixtures/" + name + ".json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(f.synthetic, true);
    const a = replay(f.frames, f.config);
    assert.deepEqual(a, replay(f.frames, f.config));
    if (name === "fresh") assert.equal(a.proposalCount, 2);
    else assert.equal(a.proposalCount, 0);
  }
});

test("OpenAPI and JSONSchema describe the same projection and every required field is checked", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../contract/read-state.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const spec = JSON.parse(
    readFileSync(new URL("../contract/openapi.json", import.meta.url), "utf8"),
  );
  assert.equal(
    spec.paths["/v1/me/state"].get.responses["200"].content["application/json"]
      .schema.$ref,
    "./read-state.schema.json",
  );
  for (const name of schema.required) {
    const state = structuredClone(frame().state);
    delete state[name];
    assert.throws(() => parseReadState(state), name);
  }
  assert.deepEqual(Object.keys(spec.paths).sort(),[
    "/v1/me/state", "/v1/me/allowlist", "/v1/swap-intents", "/v1/swap-intents/{id}/quote",
    "/v1/swap-intents/{id}/signature", "/v1/swap-intents/{id}/submit-durable",
    "/v1/swap-intents/{id}/submission", "/v1/swap-intents/{id}/result",
  ].sort());
});

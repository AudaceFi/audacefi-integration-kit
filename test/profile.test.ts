import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inventoryImports } from "./source-inventory.ts";
import { parseReadState, text } from "../src/contract.ts";
import { replay } from "../src/replay.ts";
import { frame, config } from "./helpers.ts";
test("inventory covers side-effect imports and module re-exports", () => {
  assert.deepEqual(
    inventoryImports("import 'node:child_process'; export * from 'node:net';"),
    ["node:child_process", "node:net"],
  );
  assert.throws(
    () => inventoryImports("import('node:net')"),
    /DYNAMIC_IMPORT_FORBIDDEN/,
  );
});
test("schema expresses nullable string length and exact UTC millisecond profile", () => {
  const s = JSON.parse(
    readFileSync(
      new URL("../contract/read-state.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const w = s.properties.wallet.oneOf[1].properties;
  for (const key of [
    "walletAddress",
    "mode",
    "seasonExecutionMode",
    "category",
    "seasonId",
  ]) {
    assert.equal(w[key].minLength, 1);
    assert.equal(w[key].maxLength, 200);
  }
  assert.ok(s.properties.asOf.pattern);
  const x = frame().state;
  x.asOf = "+010000-01-01T12:00:00.000Z";
  assert.throws(() => parseReadState(x), /INVALID_TIMESTAMP/);
});

test("text limits count Unicode code points without normalization", () => {
  const astral = String.fromCodePoint(0x1f600);
  for (const value of [
    "a".repeat(200), "é".repeat(200), astral.repeat(100),
    astral.repeat(101), astral.repeat(200), "a".repeat(199) + astral,
    "e\u0301".repeat(100),
  ]) assert.equal(text(value), value);
  for (const value of [
    "", "a".repeat(201), "é".repeat(201), astral.repeat(201),
    "a".repeat(200) + astral, "e\u0301".repeat(101), null, 200, [], {},
  ]) assert.throws(() => text(value), /INVALID_TEXT/);
});

test("projection string limits match schema at non-BMP boundaries", () => {
  const schema = JSON.parse(readFileSync(new URL(
    "../contract/read-state.schema.json", import.meta.url,
  ), "utf8"));
  const active = schema.properties.season.properties.active.oneOf[1].properties;
  const wallet = schema.properties.wallet.oneOf[1].properties;
  const fields = [
    ["mode", schema.properties.mode],
    ...["id", "status", "executionMode"].map((key) => ["season.active." + key, active[key]]),
    ...["seasonId", "seasonExecutionMode", "mode", "category", "walletAddress"]
      .map((key) => ["wallet." + key, wallet[key]]),
    ["wallet.code", schema.properties.wallet.oneOf[0].properties.code],
  ];
  for (const [path, rule] of fields) {
    assert.equal(rule.minLength, 1, path);
    assert.equal(rule.maxLength, 200, path);
    for (const count of [0, 100, 101, 200, 201]) {
      const state = frame().state;
      if (path === "wallet.code") state.wallet = { state: "unavailable", code: "synthetic" };
      const keys = path.split(".");
      let parent = state;
      for (const key of keys.slice(0, -1)) parent = parent[key];
      parent[keys[keys.length - 1]] = String.fromCodePoint(0x1f600).repeat(count);
      if (count >= 1 && count <= 200) assert.doesNotThrow(() => parseReadState(state), path);
      else assert.throws(() => parseReadState(state), /INVALID_TEXT/, path);
    }
  }
});

test("Unicode acceptance retains context guards and synthetic-only results", () => {
  const id = String.fromCodePoint(0x1f600).repeat(200);
  const f = frame();
  f.state.season.active.id = id;
  f.state.wallet.seasonId = id;
  const valid = replay([f], config);
  assert.equal(valid.entries[0]?.action, "BUY");
  assert.equal(valid.synthetic, true);
  assert.equal(valid.executionAuthorized, false);
  for (const [change, reason] of [
    [(s: typeof f.state) => { s.mode = id; }, "CONTEXT_MISMATCH"],
    [(s: typeof f.state) => { s.season.active.executionMode = id; }, "NO_ACTIVE_DEVNET_SEASON"],
    [(s: typeof f.state) => { s.wallet.mode = id; }, "WALLET_CONTEXT_MISMATCH"],
  ] as const) {
    const blocked = structuredClone(f);
    change(blocked.state);
    const result = replay([blocked], config);
    assert.equal(result.entries[0]?.action, "HOLD");
    assert.equal(result.entries[0]?.reason, reason);
    assert.equal(result.proposalCount, 0);
    assert.equal(result.executionAuthorized, false);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "../src/replay.ts";
import { frame, clock, config } from "./helpers.ts";
test("fresh synthetic evidence creates a proposal only", () => {
  const r = replay([frame()], config);
  assert.equal(r.entries[0]!.action, "BUY");
  assert.equal(r.executionAuthorized, false);
  assert.equal(r.synthetic, true);
});
test("fresh assembly does not hide stale portfolio evidence", () => {
  const f = frame();
  f.portfolio.observedAtMs = clock - 120001;
  assert.equal(replay([f], config).entries[0]!.action, "HOLD");
});
test("missing balance is not zero or permission", () => {
  const f = frame();
  f.portfolio.cashCents = null;
  assert.equal(replay([f], config).entries[0]!.action, "HOLD");
});
test("mainnet or accounting wallet cannot produce proposals", () => {
  const f = frame();
  f.state.wallet.seasonExecutionMode = "mainnet";
  assert.equal(replay([f], config).entries[0]!.action, "HOLD");
});
test("unapproved mint is blocked even for a model fixture", () => {
  const f = frame();
  f.modelReply = JSON.stringify({
    action: "BUY",
    mint: "OTHER",
    amountCents: 1000,
  });
  assert.equal(replay([f], config, "model-fixture").entries[0]!.action, "HOLD");
});
test("cumulative caps and replay deduplication", () => {
  const a = frame("a"),
    b = frame("b"),
    c = frame("c");
  const r = replay([a, a, b, c], config);
  assert.equal(r.proposalCount, 2);
  assert.equal(r.spentCents, 2000);
  assert.equal(r.entries[1]!.reason, "DUPLICATE_FRAME");
  assert.equal(r.entries[3]!.action, "HOLD");
});
test("same id with different content is an explicit conflict", () => {
  const a = frame("a"),
    b = frame("a");
  b.market.signalBps = -150;
  assert.throws(() => replay([a, b], config), /FRAME_ID_CONFLICT/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replay, type Strategy } from "../src/replay.ts";
import { frame, config, clock } from "./helpers.ts";

for (const [operator, strategy, actions] of [
  ["trading bot", "baseline", ["BUY", "SELL", "HOLD", "HOLD"]],
  ["AI agent", "model-fixture", ["BUY", "BUY", "HOLD", "HOLD"]],
] as const) {
  test(operator + " example is deterministic and never authorizes execution", () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/fresh.json", import.meta.url), "utf8"));
    const result = replay(fixture.frames, fixture.config, strategy);
    assert.deepEqual(result.entries.map((x) => x.action), actions);
    assert.equal(result.proposalCount, 2);
    assert.equal(result.spentCents, 2000);
    assert.equal(result.synthetic, true);
    assert.equal(result.executionAuthorized, false);
    assert.deepEqual(result, replay(fixture.frames, fixture.config, strategy));
  });
}

for (const strategy of ["baseline", "model-fixture"] satisfies Strategy[]) {
  test(strategy + " cannot bypass shared evidence or cumulative limits", () => {
    const make = (id: string) => {
      const f = frame(id);
      f.modelReply = '{"action":"BUY","mint":"SYNTH_ASSET","amountCents":1000}';
      return f;
    };
    const stale = make("stale");
    stale.market.observedAtMs = clock - config.maxAgeMs - 1;
    assert.equal(replay([stale], config, strategy).entries[0]?.reason, "STALE_EVIDENCE");
    const unknown = make("unknown");
    unknown.portfolio.cashCents = null;
    assert.equal(replay([unknown], config, strategy).entries[0]?.reason, "UNKNOWN_BALANCE");
    const a = make("a"), b = make("b");
    const r = replay([a, a, b], { ...config, maxTotalCents: 1000 }, strategy);
    assert.equal(r.proposalCount, 1);
    assert.equal(r.entries[1]?.reason, "DUPLICATE_FRAME");
    assert.equal(r.entries[2]?.reason, "PROPOSAL_BUDGET_EXHAUSTED");
    assert.equal(r.executionAuthorized, false);
  });
}

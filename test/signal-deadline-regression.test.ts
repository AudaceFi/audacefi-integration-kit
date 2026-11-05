import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { FileJournal } from "../src/journal.ts";
import { abandonOperation, runOperation } from "../src/operation.ts";
import { runAiAgent, runTradingBot } from "../src/operators.ts";
import { clock, harness, journalFor } from "./connected-harness.ts";

test("an entry deadline is rechecked under the lock before the SIGNED event write", async t => {
  const h = harness(), { directory, journal } = await journalFor(t);
  let now = clock, eventOpens = 0;
  const deadline = clock + 1, originalOpen = fs.open;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await originalOpen(...args);
    if (flags === "a" && typeof path === "string" && path.startsWith(directory) && path.endsWith(".events") && ++eventOpens === 3) {
      now = deadline;
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const result = await runOperation(h.client, journal, h.operation, h.ports, () => now, { notAfterMs: deadline });
    assert.equal(eventOpens, 4);
    assert.equal(result.state, "AMBIGUOUS");
    assert.equal(result.reason, "OPERATION_DEADLINE_PASSED");
    assert.deepEqual(h.calls.filter(c => c.method === "POST").map(c => c.path.split("/").at(-1)), ["swap-intents", "quote"]);
    assert.deepEqual((await journal.read(h.operation.operationKey)).events.map(e => e.stage), ["INTENT", "QUOTED", "AMBIGUOUS"]);
    await abandonOperation(journal, h.operation.operationKey);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("an entry can complete when the deadline passes during a SIGNED write already started", async t => {
  const h = harness(), { directory, journal } = await journalFor(t);
  let now = clock, eventOpens = 0;
  const deadline = clock + 1, originalOpen = fs.open;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    const handle = await originalOpen(...args);
    if (flags === "a" && typeof path === "string" && path.startsWith(directory) && path.endsWith(".events") && ++eventOpens === 3) {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        assert.equal(now, clock);
        const writing = writeFile(...writeArgs);
        now = deadline;
        await writing;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const result = await runOperation(h.client, journal, h.operation, h.ports, () => now, { notAfterMs: deadline });
    assert.equal(now, deadline);
    assert.equal(result.state, "SUBMITTED");
    assert.deepEqual((await journal.read(h.operation.operationKey)).events.map(e => e.stage), ["INTENT", "QUOTED", "SIGNED", "SENDING", "SUBMITTED"]);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("all runners still call legacy JavaScript journal adapters with the original arguments", async t => {
  for (const mode of ["direct", "bot", "agent"]) {
    const h = harness(mode === "agent" ? "ai_agent" : "trading_bot"), { journal } = await journalFor(t);
    const adapter = {
      reserve(...args: Parameters<FileJournal["reserve"]>) {
        assert.equal(args.length, 5);
        return journal.reserve(...args);
      },
      append(...args: Parameters<FileJournal["append"]>) {
        assert.equal(args.length, 2);
        return journal.append(...args);
      },
    } as unknown as FileJournal;
    const { actor, ...operation } = h.operation;
    const result = mode === "direct"
      ? await runOperation(h.client, adapter, { ...operation, actor }, h.ports, () => clock)
      : await (mode === "bot" ? runTradingBot : runAiAgent)({ client: h.client, journal: adapter, operation, ports: h.ports, clock: () => clock });
    assert.equal(result.state, "SUBMITTED");
  }
});

test("a JavaScript adapter cannot silently ignore deadline or version enforcement", async t => {
  const h = harness(), { journal } = await journalFor(t);
  const adapter = {
    trackRun: journal.trackRun.bind(journal),
    reserve: journal.reserve.bind(journal),
    append: journal.append.bind(journal),
  } as unknown as FileJournal;
  for (const limits of [{ notAfterMs: clock + 1 }, { journalVersion: "0".repeat(64) }]) {
    await assert.rejects(runOperation(h.client, adapter, h.operation, h.ports, () => clock, limits), { message: "JOURNAL_LIMITS_UNSUPPORTED" });
  }
  assert.deepEqual(h.calls, []);
  assert.equal((await journal.capacity(() => clock)).reservedOperations, 0);
});

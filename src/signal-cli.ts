import { parseSpotSignal, prepareSpotSignal, type SpotSignalPolicy } from "./signals.ts";

const fixture: SpotSignalPolicy = {
  symbol: "TEST",
  seasonId: ["00000000", "0000", "0000", "0000", "000000000001"].join("-"),
  category: "degen",
  playerPublicKey: "3".repeat(32),
  usdcMint: "4".repeat(32),
  usdcDecimals: 6,
  assetMint: "5".repeat(32),
  assetDecimals: 6,
  maxEntryBps: 2_000,
  maxPositionRaw: "20000000",
  exitAttempts: 2,
};

async function main(): Promise<void> {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error("PIPE_SIGNALS_ONLY");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > 1_028) throw new Error("SIGNAL_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const lines = input.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length > 2) throw new Error("TOO_MANY_SIGNALS");
  const signals = lines.map(parseSpotSignal);
  const [entry, exit] = signals;
  if (exit && (!entry || entry.side !== "long" || exit.side !== "flat" ||
    exit.sequence <= entry.sequence || exit.id === entry.id)) throw new Error("INVALID_SIGNAL_ORDER");

  const nowMs = Date.now();
  const holdings = { observedAtMs: nowMs, usdcRaw: "100000000", assetRaw: "0" };
  // A fixture journal with room for the entry and two exit attempts: three operation slots, 20 USDC and
  // 40 TEST. Each previewed operation is treated as finalized before the next signal, so none is pending.
  const budget = (limitRaw: string) => ({ limitRaw, remainingRaw: limitRaw });
  const journal: Parameters<typeof prepareSpotSignal>[0]["journal"] = {
    observedAtMs: nowMs,
    unresolvedOperations: 0,
    runningOperations: 0,
    reservedOperations: 0,
    remainingOperations: 3,
    budgets: { [fixture.usdcMint]: budget("20000000"), [fixture.assetMint]: budget("40000000") },
    version: "0".repeat(64),
  };
  const steps = signals.map((signal) => {
    const plan = prepareSpotSignal({ signal, policy: fixture, holdings, journal, nowMs });
    if (plan.kind === "noop") return { side: signal.side, kind: plan.kind };
    const { amountInRaw, tokenInMint } = plan.operation;
    const spent = journal.budgets[tokenInMint]!;
    spent.remainingRaw = (BigInt(spent.remainingRaw) - BigInt(amountInRaw)).toString();
    journal.remainingOperations -= 1;
    journal.reservedOperations += 1;
    // The fixture fills at 1:1. Equal decimals make the credited raw units equal to the debited units.
    if (signal.side === "long") {
      holdings.usdcRaw = (BigInt(holdings.usdcRaw) - BigInt(amountInRaw)).toString();
      holdings.assetRaw = amountInRaw;
    } else {
      holdings.usdcRaw = (BigInt(holdings.usdcRaw) + BigInt(amountInRaw)).toString();
      holdings.assetRaw = "0";
    }
    return { side: signal.side, kind: plan.kind, input: signal.side === "long" ? "USDC" : fixture.symbol, amountInRaw };
  });
  console.log(JSON.stringify({
    mode: "offline-preview",
    ranked: false,
    symbol: fixture.symbol,
    steps,
    finalHoldings: { usdcRaw: holdings.usdcRaw, assetRaw: holdings.assetRaw },
  }));
}

main().catch(() => {
  console.error("Signal preview rejected. Supply up to two fresh TEST signals as JSON lines on stdin.");
  process.exitCode = 1;
});

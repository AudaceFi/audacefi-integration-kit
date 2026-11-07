import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { closed } from "./contract.ts";
import { openRankedSignalOperator, type RankedSignalOperator, type RankedSignalReceipt } from "./ranked-signal.ts";
import { parseSpotSignal, type SpotSignal } from "./signals.ts";

async function main() {
  const [execute, flag, operator, ...options] = process.argv.slice(2);
  const recoverExit = options.at(-1) === "--recover-exit";
  if (recoverExit) options.pop();
  const ready = options[0] === "--emit-ready" || options[0] === "--emit-ready-scope" ? options[0] : undefined;
  const targetArgs = ready ? options.slice(1) : options;
  const official = targetArgs.length === 2 && targetArgs[0] === "--target" && targetArgs[1] === "official";
  if (execute !== "--execute" || flag !== "--operator" || !operator || !isAbsolute(operator) ||
      !operator.endsWith(".mjs") || (targetArgs.length !== 0 && !official) || process.stdin.isTTY) {
    process.stderr.write("Usage: npm run signal:live -- --execute --operator <absolute trusted module.mjs> [--emit-ready|--emit-ready-scope] [--target official] [--recover-exit]\n");
    process.exitCode = 2;
    return;
  }
  const { default: setup } = await import(pathToFileURL(operator).href) as { default: RankedSignalOperator };
  try {
    const gateway = await openRankedSignalOperator(setup, official ? "official" : "validation");
    if (ready === "--emit-ready") process.stdout.write('{"status":"ready"}\n');
    if (ready === "--emit-ready-scope") process.stdout.write(JSON.stringify({ status: "ready", runScope: gateway.runScope }) + "\n");
    await readSignals(recoverExit ? gateway.recoverExit : gateway.accept, gateway.runScope);
  } finally {
    await setup?.close?.();
  }
}

async function readSignals(accept: (line: string) => Promise<RankedSignalReceipt>, runScope: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = Buffer.alloc(0);
  let oversized = false;
  const reject = () => process.stdout.write('{"status":"rejected","ranked":false,"code":"INVALID_SIGNAL"}\n');
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const fragment = chunk.subarray(offset, end < 0 ? chunk.length : end);
      oversized ||= line.length + fragment.length > 4096;
      if (!oversized) line = Buffer.concat([line, fragment]);
      if (end < 0) break;
      let text: string | undefined;
      let signal: SpotSignal | undefined;
      let scopeMismatch = false;
      try {
        if (!oversized) {
          const decoded = decoder.decode(line);
          const frame = closed(JSON.parse(decoded), ["runScope", "signal"]);
          if (typeof frame.runScope === "string" && typeof frame.signal === "string") {
            const keys = [...decoded.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)];
            if (keys.length !== 2) throw new Error("INVALID_SIGNAL_FRAME");
            scopeMismatch = frame.runScope !== runScope;
            if (!scopeMismatch) {
              signal = parseSpotSignal(frame.signal);
              text = frame.signal;
            }
          }
        }
      } catch { /* No signal reached the gateway. */ }
      if (scopeMismatch) process.stdout.write('{"status":"scope-mismatch","ranked":false,"code":"SIGNAL_RUN_SCOPE_MISMATCH"}\n');
      else if (text === undefined || signal === undefined) reject();
      else {
        try {
          const receipt = await accept(text);
          process.stdout.write(JSON.stringify({ ...receipt, signalId: signal.id, sequence: signal.sequence }) + "\n");
        }
        catch { process.stdout.write(JSON.stringify({ status: "unknown", ranked: false, code: "SIGNAL_OUTCOME_UNKNOWN", signalId: signal.id, sequence: signal.sequence }) + "\n"); }
      }
      line = Buffer.alloc(0);
      oversized = false;
      offset = end + 1;
    }
  }
  if (line.length || oversized) reject();
}

main().catch(() => {
  process.stderr.write("The ranked signal gateway stopped. Inspect the operator journal before restarting.\n");
  process.exitCode = 1;
});

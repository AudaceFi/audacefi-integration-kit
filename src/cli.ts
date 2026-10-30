import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { replay, type Strategy } from "./replay.ts";
export function parseArgs(args: string[]): {
  scenario: "fresh" | "stale" | "unavailable";
  strategy: Strategy;
} {
  const [command, ...rest] = args;
  if (command !== "demo" && command !== "replay")
    throw new Error("OFFLINE_COMMAND_REQUIRED");
  let scenario: "fresh" | "stale" | "unavailable" = "fresh",
    strategy: Strategy = "baseline";
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i],
      v = rest[i + 1];
    if (!k || seen.has(k)) throw new Error("INVALID_OFFLINE_ARGUMENT");
    seen.add(k);
    if (
      k === "--scenario" &&
      (v === "fresh" || v === "stale" || v === "unavailable")
    )
      scenario = v;
    else if (
      k === "--strategy" &&
      (v === "baseline" || v === "hold" || v === "model-fixture")
    )
      strategy = v;
    else throw new Error("INVALID_OFFLINE_ARGUMENT");
  }
  return { scenario, strategy };
}
export function main(args: string[]): void {
  const a = parseArgs(args),
    url = new URL("../fixtures/" + a.scenario + ".json", import.meta.url);
  // The path is built solely from closed scenario names; no arbitrary file access.
  const raw = JSON.parse(readFileSync(url, "utf8")) as {
    synthetic: unknown;
    config: unknown;
    frames: unknown[];
  };
  if (raw.synthetic !== true) throw new Error("SYNTHETIC_FIXTURE_REQUIRED");
  console.log(
    JSON.stringify(replay(raw.frames, raw.config, a.strategy), null, 2),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));

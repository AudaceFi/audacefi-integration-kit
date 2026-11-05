import { runOperation, type Operation, type OperationLimits, type OperatorPorts } from "./operation.ts";
import type { AudaceFiClient } from "./client.ts";
import type { FileJournal } from "./journal.ts";
export interface OperatorCall {
  client: AudaceFiClient;
  journal: FileJournal;
  /** May carry `limits`, as a `SpotSignalPlan` operation does. They are applied by `runOperation`, never sent as part of the operation. */
  operation: Omit<Operation,"actor"> & { limits?: OperationLimits };
  ports: OperatorPorts;
  clock?: () => number;
}
// Async, so a malformed call rejects like any other failure instead of throwing synchronously.
async function run(call:OperatorCall,actor:Operation["actor"]) {
  const { limits, ...operation } = { ...call.operation };
  return runOperation(call.client,call.journal,{...operation,actor},call.ports,call.clock,limits);
}
/** An existing bot supplies a policy-approved operation; its exchange executor is never called. */
export function runTradingBot(call:OperatorCall) {
  return run(call,"trading_bot");
}
/** An existing AI system supplies the same closed operation, never executable model text. */
export function runAiAgent(call:OperatorCall) {
  return run(call,"ai_agent");
}

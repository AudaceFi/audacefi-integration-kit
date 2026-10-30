import { runOperation, type Operation, type OperatorPorts } from "./operation.ts";
import type { AudaceFiClient } from "./client.ts";
import type { FileJournal } from "./journal.ts";
export interface OperatorCall {
  client: AudaceFiClient;
  journal: FileJournal;
  operation: Omit<Operation,"actor">;
  ports: OperatorPorts;
  clock?: () => number;
}
/** An existing bot supplies a policy-approved operation; its exchange executor is never called. */
export function runTradingBot(call:OperatorCall) {
  return runOperation(call.client,call.journal,{...call.operation,actor:"trading_bot"},call.ports,call.clock);
}
/** An existing AI system supplies the same closed operation, never executable model text. */
export function runAiAgent(call:OperatorCall) {
  return runOperation(call.client,call.journal,{...call.operation,actor:"ai_agent"},call.ports,call.clock);
}

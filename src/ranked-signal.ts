import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { benchPlan, type BenchProfile } from "./bench.ts";
import { digest } from "./canonical.ts";
import { AudaceFiClient, mint, rawAmount, uuid, type OfficialProxyOptions, type RequestGuard } from "./client.ts";
import { integer, SOLANA_DEVNET_GENESIS } from "./contract.ts";
import { FileJournal, type JournalPolicy } from "./journal.ts";
import { createOfficialOperationGuard, officialApprovalDeploymentDigest,
  type OfficialApprovalBindings, type OfficialApprovalEvidence, type OfficialApprovalSource } from "./official-approval.ts";
import { finalizeOperation, recoverFinalResult, resumeRankedOperation, type Operation, type OperatorPorts } from "./operation.ts";
import { runAiAgent, runTradingBot } from "./operators.ts";
import { openRankedInbox } from "./ranked-inbox.ts";
import { verifyRankedOperation, type RankedOperationStatus, type ReadRankedEvidence } from "./ranked-proof.ts";
import { createReferenceAdapters, type WalletPort } from "./reference.ts";
import type { RpcPort } from "./rpc.ts";
import { parseSpotSignal, prepareSpotSignalFromJournal, type SpotSignalPolicy } from "./signals.ts";

export { SOLANA_DEVNET_GENESIS } from "./contract.ts";
const validationOrigin = "https://audacefi-ranked-validation.invalid";
const category = "crypto-bro";

export interface RankedSignalSetup {
  client: AudaceFiClient;
  rpc: RpcPort;
  wallet: WalletPort;
  profile: BenchProfile;
  journalDirectory: string;
  journalPolicy: JournalPolicy;
  actor: Operation["actor"];
  accountId: string;
  seasonId: string;
  playerPublicKey: string;
  source: string;
  pair: Pick<SpotSignalPolicy, "symbol" | "assetMint" | "maxEntryBps" | "maxPositionRaw" | "exitAttempts"> & {
    minimumFlatOutRaw: string;
    recoveryExit?: { attempts: number; minimumOutRaw: string };
  };
  /** Recheck the separately approved validation deployment, account, ranking and rewards perimeter. */
  assertValidationTarget: () => Promise<void>;
  readEvidence: ReadRankedEvidence;
}
export type OfficialRankedSignalSetup = Omit<RankedSignalSetup, "client" | "assertValidationTarget" | "readEvidence" | "pair"> & {
  pair: RankedSignalSetup["pair"] & Required<Pick<RankedSignalSetup["pair"], "recoveryExit">>;
  api: Omit<OfficialProxyOptions, "accountId" | "actor" | "authorizeWrite">;
  officialApproval: OfficialApprovalSource;
  /** Verify the exact deployment, operator eligibility, opening snapshot and independent exit. */
  assertOfficialTarget: (signal: AbortSignal) => void | Promise<void>;
};

export function officialRankedApprovalBindings(setup: OfficialRankedSignalSetup): OfficialApprovalBindings {
  const { apiApproval, ...profile } = setup.profile;
  const { actor, accountId, seasonId, playerPublicKey, source, pair, journalPolicy } = setup;
  const deploymentDigest = officialApprovalDeploymentDigest(setup.officialApproval.expectedEvidence);
  if (deploymentDigest !== setup.officialApproval.deploymentDigest) throw new Error("OFFICIAL_APPROVAL_DEPLOYMENT_MISMATCH");
  return {
    deploymentDigest,
    profileDigest: digest({ ...profile, protocol: apiApproval.protocol }),
    scopeDigest: digest({ actor, accountId, seasonId, playerPublicKey, source, pair, journalPolicy }),
  };
}

type RankedReceipt = Extract<RankedOperationStatus, { ranked: true }> & {
  operationKey: string; simulatedFeeBps: 20; positionAfterRaw: string;
};
type ClosedUnrankedReceipt = {
  status: "closed-unranked"; ranked: false; operationKey: string; positionAfterRaw: string;
  reason: "unsent" | "abandoned" | "failed" | "independent-exit";
  intentId?: string; txid?: string;
};
export type RankedSignalReceipt = RankedReceipt | ClosedUnrankedReceipt | {
  status: "finality-pending" | "ranking-pending" | "review-required";
  ranked: false;
  operationKey: string;
  intentId?: string;
  txid?: string;
};

/** Process one trusted local source against one dedicated validation wallet and one approved pair. */
export async function createRankedSignalGateway(setup: RankedSignalSetup) {
  return (await createScopedRankedSignalGateway(setup, setup.assertValidationTarget, "validation")).accept;
}

/** Explicit operator-only integration point for a separately qualified league deployment. */
export async function createOfficialRankedSignalGateway(setup: OfficialRankedSignalSetup) {
  return (await createOfficialScopedRankedSignalGateway(setup)).accept;
}

async function createOfficialScopedRankedSignalGateway(setup: OfficialRankedSignalSetup) {
  if (!setup.pair?.recoveryExit) throw new Error("OFFICIAL_RECOVERY_EXIT_REQUIRED");
  const { accountId, actor, assertOfficialTarget, wallet } = setup;
  const source = setup.officialApproval;
  if (!source || typeof source.read !== "function" || typeof source.isCurrent !== "function" ||
      typeof assertOfficialTarget !== "function") {
    throw new Error("OFFICIAL_APPROVAL_REQUIRED");
  }
  const approval = { ...source, expectedEvidence: Object.freeze(structuredClone(source.expectedEvidence)) };
  const bindings = officialRankedApprovalBindings(setup);
  const { frozenAllowlistDigest, openingSnapshotDigest } = approval.expectedEvidence;
  const referenceWindow = { ...setup.profile.apiApproval };
  const guards = new AsyncLocalStorage<() => Promise<void>>();
  const assertTarget = () => {
    const guard = guards.getStore();
    if (!guard) throw new Error("OFFICIAL_APPROVAL_REQUIRED");
    return guard();
  };
  const client = AudaceFiClient.forOfficialRankedProxy({
    ...setup.api, accountId, actor, authorizeWrite: assertTarget,
  });
  const gateway = await createScopedRankedSignalGateway({
    ...setup, accountId, actor, client, readEvidence: request => client.readRankedEvidence(request),
    wallet: { publicKey: () => wallet.publicKey(), signTransaction: async bytes => {
      await assertTarget();
      return wallet.signTransaction(bytes);
    } },
  }, assertTarget, "official-proxy", { frozenAllowlistDigest, openingSnapshotDigest });
  const withApproval = (run: () => Promise<RankedSignalReceipt>) =>
    guards.run(createOfficialOperationGuard(approval, bindings, assertOfficialTarget, { referenceWindow }), run);
  return {
    ...gateway,
    accept: (line: string) => withApproval(() => gateway.accept(line)),
    recoverExit: (line: string) => withApproval(() => gateway.recoverExit(line)),
  };
}

export type RankedSignalOperator = (RankedSignalSetup | OfficialRankedSignalSetup) & { close?: () => Promise<void> };

export async function openRankedSignalOperator(setup: RankedSignalOperator, target: "validation" | "official") {
  if (!setup || typeof setup !== "object") throw new Error("RANKED_OPERATOR_TARGET_MISMATCH");
  if (target === "official" && "assertOfficialTarget" in setup && !("assertValidationTarget" in setup) &&
      typeof setup.assertOfficialTarget === "function") {
    return createOfficialScopedRankedSignalGateway(setup);
  }
  if (target === "validation" && "assertValidationTarget" in setup && !("assertOfficialTarget" in setup) &&
      typeof setup.assertValidationTarget === "function") {
    return createScopedRankedSignalGateway(setup, setup.assertValidationTarget, "validation");
  }
  throw new Error("RANKED_OPERATOR_TARGET_MISMATCH");
}

async function createScopedRankedSignalGateway(
  setup: Omit<RankedSignalSetup, "assertValidationTarget">,
  assertTarget: RequestGuard,
  scopeKind: "validation" | "official-proxy",
  officialSeason?: Pick<OfficialApprovalEvidence, "frozenAllowlistDigest" | "openingSnapshotDigest">,
) {
  const { client, rpc, wallet, actor, readEvidence } = setup;
  const { journalDirectory } = setup;
  const profile = structuredClone(setup.profile);
  const pair = structuredClone(setup.pair);
  const { accountId, seasonId, playerPublicKey, source } = setup;
  uuid(accountId);
  uuid(seasonId);
  mint(playerPublicKey);
  const positionCap = BigInt(rawAmount(pair.maxPositionRaw));
  const minimumFlatOut = BigInt(rawAmount(pair.minimumFlatOutRaw));
  integer(pair.maxEntryBps, 1, 10_000);
  integer(pair.exitAttempts, 2, 10);
  const recoveryAttempts = pair.recoveryExit === undefined ? 0 : integer(pair.recoveryExit.attempts, 1, 8);
  const totalExitAttempts = integer(pair.exitAttempts + recoveryAttempts, 2, 10);
  const recoveryFloor = pair.recoveryExit === undefined ? minimumFlatOut : BigInt(rawAmount(pair.recoveryExit.minimumOutRaw));
  if (recoveryFloor > minimumFlatOut) throw new Error("INVALID_RANKED_RECOVERY_FLOOR");
  if (!/^[A-Z0-9_-]{1,16}$/.test(pair.symbol) || pair.symbol === "USDC" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(source) || (actor !== "trading_bot" && actor !== "ai_agent")) {
    throw new Error("INVALID_RANKED_OPERATOR");
  }
  const routeScope = scopeKind === "official-proxy" ? { apiBasePath: "/api" as const } : {};
  const apiBasePath = routeScope.apiBasePath;
  if ((scopeKind === "validation") !== (client.origin === validationOrigin) ||
      client.origin !== profile.apiOrigin || client.apiBasePath !== (apiBasePath ?? "") || profile.apiBasePath !== apiBasePath ||
      profile.expectedGenesis !== SOLANA_DEVNET_GENESIS || profile.singleSwapFeeBps !== 20 || !client.writesAuthorized) {
    throw new Error(scopeKind === "validation" ? "RANKED_VALIDATION_PROFILE_REQUIRED" : "RANKED_OFFICIAL_PROFILE_REQUIRED");
  }
  const reference = createReferenceAdapters({ profile, client, rpc, wallet });
  const usdc = profile.mappings.find(item => item.mainnet === profile.usdcMainnet);
  const asset = profile.mappings.find(item => item.mainnet === pair.assetMint);
  if (!usdc || usdc.decimals !== 6 || !asset || asset === usdc || asset.decimals > 6) {
    throw new Error("INVALID_RANKED_SPOT_PAIR");
  }
  const policy: SpotSignalPolicy = {
    symbol: pair.symbol, seasonId, category, playerPublicKey,
    usdcMint: usdc.mainnet, usdcDecimals: usdc.decimals, assetMint: asset.mainnet, assetDecimals: asset.decimals,
    maxEntryBps: pair.maxEntryBps, maxPositionRaw: pair.maxPositionRaw, exitAttempts: totalExitAttempts,
  };
  const journal = await FileJournal.create(journalDirectory, setup.journalPolicy);
  const context = {
    origin: client.origin, ...routeScope, genesisHash: profile.expectedGenesis,
    seasonId, accountId, actor, category, playerPublicKey,
  } as const;
  const { apiApproval, ...deployment } = profile;
  // A service release changes write approval, while the same chain and run retain their journal.
  const scope = digest({ context, deployment, protocol: apiApproval.protocol, policy, pair, source,
    ...(officialSeason ? { officialSeason } : {}) });
  const runScope = await journal.rankedRunScope(scope);
  async function assertCurrent() {
    await assertTarget();
    await reference.ports.assertTargetCurrent?.();
  }
  async function assertPair() {
    await assertCurrent();
    const allowlist = await client.readAllowlist(category, seasonId);
    const matches = allowlist.tokens.filter(token => token.symbol === pair.symbol);
    const currency = allowlist.tokens.find(token => token.mint === policy.usdcMint);
    if (!allowlist.allowlistFrozen || matches.length !== 1 || matches[0]!.mint !== policy.assetMint ||
        !matches[0]!.eligible || matches[0]!.exempt || matches[0]!.decimals !== policy.assetDecimals ||
        !currency || currency.decimals !== policy.usdcDecimals || !(currency.eligible || currency.exempt)) {
      throw new Error("RANKED_SYMBOL_NOT_ALLOWLISTED");
    }
    await reference.ports.assertTargetCurrent?.();
  }
  const readHoldings = () => reference.readSpotHoldings(playerPublicKey, policy.assetMint);

  async function readReserved(operationKey: unknown, inputMint: string) {
    if (typeof operationKey !== "string") throw new Error("RANKED_INBOX_STATE_CHANGED");
    const entry = await journal.readIfReserved(operationKey);
    if (entry) {
      const { reservation, events } = entry;
      const signed = events.find(event => event.stage === "SIGNED");
      if (reservation.origin !== client.origin || reservation.apiBasePath !== apiBasePath || reservation.tokenInMint !== inputMint ||
          (reservation.version === 2 && (reservation.accountId !== accountId || reservation.actor !== actor)) ||
          (signed && (signed.playerPublicKey !== playerPublicKey || signed.genesisHash !== profile.expectedGenesis))) {
        throw new Error("RANKED_INBOX_STATE_CHANGED");
      }
    }
    return entry;
  }

  function recordedPosition(row: { completed?: unknown; position_after?: unknown } | undefined): string {
    if (!row) return "0";
    if (row.completed !== 1) throw new Error("RANKED_SIGNAL_PENDING");
    return row.position_after === "0" ? "0" : rawAmount(row.position_after);
  }

  async function accept(line: string, independentExit = false): Promise<RankedSignalReceipt> {
    const signal = parseSpotSignal(line);
    if (signal.symbol !== policy.symbol) throw new Error("SIGNAL_PAIR_NOT_ALLOWED");
    if (independentExit && signal.side !== "flat") throw new Error("RANKED_RECOVERY_FLAT_REQUIRED");
    const payload = digest(line);
    const inputMint = signal.side === "long" ? policy.usdcMint : policy.assetMint;
    return journal.withRankedSignalLock(async () => {
      await journal.assertRankedRunScope(scope, runScope);
      const inbox = await openRankedInbox(resolve(journalDirectory), scope);
      try {
        let saved = inbox.read(signal.id);
        const legacyPayload = saved?.payload === digest(signal);
        if (saved && saved.payload !== payload && !legacyPayload) throw new Error("RANKED_SIGNAL_ID_CONFLICT");
        if (saved?.completed === 0 && saved.independent_exit !== null && saved.independent_exit !== (independentExit ? 1 : 0)) {
          throw new Error("RANKED_SIGNAL_MODE_CONFLICT");
        }
        let entry = saved ? await readReserved(saved.operation_key, inputMint) : null;
        const previous = () => recordedPosition(inbox.previous(signal.sequence));
        const trackedExit = signal.side === "flat" && recoveryAttempts > 0;
        async function freshExitBlockhash() {
          const selected = await reference.selectBuildBlockhash();
          if (inbox.hasEarlierExitBlockhash(signal.id, selected.blockhash)) throw new Error("RANKED_EXIT_WAIT_FOR_FRESH_BLOCKHASH");
          return selected;
        }
        function rankedPorts(before: string, selectedBlockhash?: Awaited<ReturnType<typeof freshExitBlockhash>>): OperatorPorts {
          const verifyPlan: OperatorPorts["verifyPlan"] = async (wire, operation, quote, target) => {
            await assertPair();
            if (quote.kind !== "single") throw new Error("RANKED_SPOT_QUOTE_REQUIRED");
            const { amounts } = benchPlan(profile, operation, quote);
            const minimum = signal.side === "long" ? 1n : independentExit ? recoveryFloor : minimumFlatOut;
            if (amounts.output < minimum || (signal.side === "long" && amounts.output > positionCap)) {
              throw new Error("RANKED_QUOTE_OUTSIDE_LIMITS");
            }
            const proof = await reference.ports.verifyPlan(wire, operation, quote, target);
            const position = signal.side === "long" ? proof.outputBalanceRaw : proof.inputBalanceRaw;
            if (position !== before) throw new Error("RANKED_POSITION_MISMATCH");
            inbox.bindQuote(signal.id, digest({
              amountInRaw: operation.amountInRaw, amountOutRaw: amounts.output.toString(), feeRaw: amounts.fee.toString(),
            }), signal.side === "long" ? amounts.output.toString() : "0");
            return proof;
          };
          return { ...reference.ports, recovery: reference.recovery, verifyPlan, revalidate: verifyPlan,
            ...(trackedExit ? { build: async (operation, quote, target) => {
              const selected = selectedBlockhash ?? await freshExitBlockhash();
              inbox.bindExitBlockhash(signal.id, selected.blockhash);
              return reference.buildAt(operation, quote, target, selected);
            } } : {}),
            assertTargetCurrent: assertPair, onReserved: () => inbox.reserve(signal.id) };
        }
        function closeUnranked(positionAfterRaw: string, reason: ClosedUnrankedReceipt["reason"],
          identifiers: { intentId?: string; txid?: string } = {}): ClosedUnrankedReceipt {
          if (!saved || typeof saved.operation_key !== "string") throw new Error("RANKED_INBOX_STATE_CHANGED");
          if (saved.completed === 1) {
            if (saved.receipt !== null || saved.position_after !== positionAfterRaw) throw new Error("RANKED_INBOX_STATE_CHANGED");
          } else {
            inbox.complete(signal.id, positionAfterRaw, null);
          }
          return { status: "closed-unranked", ranked: false, operationKey: saved.operation_key, positionAfterRaw, reason, ...identifiers };
        }

        if (!entry) {
          const latest = inbox.latest();
          let priorExit: { id: string; position: string } | undefined;
          let before: string;
          if (saved) {
            if (legacyPayload || saved.reserved !== 0 || saved.quote !== null || saved.target_position !== null || saved.result_attempt !== 0) {
              if (typeof saved.operation_key !== "string") throw new Error("RANKED_INBOX_STATE_CHANGED");
              return { status: "review-required", ranked: false, operationKey: saved.operation_key };
            }
            before = previous();
            if (saved.completed === 1 || signal.expiresAtMs <= Date.now()) return closeUnranked(before, "unsent");
            if (latest?.id !== signal.id) throw new Error("RANKED_INBOX_STATE_CHANGED");
          } else {
            if (latest && signal.sequence <= integer(latest.sequence, 1)) throw new Error("RANKED_SIGNAL_SEQUENCE_CONFLICT");
            if (independentExit && latest && latest.completed !== 1) {
              if (latest.target_position === "0" || latest.target_position === null) throw new Error("RANKED_SIGNAL_PENDING");
              const prior = await readReserved(latest.operation_key, policy.usdcMint);
              if (prior?.events.at(-1)?.stage !== "FINAL_CONFIRMED" || typeof latest.id !== "string" ||
                  typeof latest.quote !== "string" || !/^[0-9a-f]{64}$/.test(latest.quote)) throw new Error("RANKED_SIGNAL_PENDING");
              before = rawAmount(latest.target_position);
              priorExit = { id: latest.id, position: before };
            } else {
              before = recordedPosition(latest);
            }
          }
          if ((signal.side === "flat") !== (before !== "0")) {
            throw new Error("RANKED_SIGNAL_ORDER");
          }
          await assertPair();
          if (await wallet.publicKey() !== playerPublicKey) throw new Error("RANKED_WALLET_MISMATCH");
          const planningJournal = !independentExit && signal.side === "flat" && recoveryAttempts > 0 ? {
            claimPlanVersion: () => journal.claimPlanVersion(),
            matchesPlanVersion: journal.matchesPlanVersion.bind(journal),
            capacity: async (clock?: () => number) => {
              const capacity = await journal.capacity(clock);
              const budget = capacity.budgets[inputMint];
              if (budget) {
                const remaining = BigInt(budget.remainingRaw) - BigInt(before) * BigInt(recoveryAttempts);
                budget.remainingRaw = (remaining > 0n ? remaining : 0n).toString();
              }
              capacity.remainingOperations = Math.max(0, capacity.remainingOperations - recoveryAttempts);
              return capacity;
            },
          } : journal;
          const plan = await prepareSpotSignalFromJournal({
            signal: { ...signal, id: digest({ source, accountId, actor, id: signal.id }) }, policy, journal: planningJournal,
            readHoldings: async () => {
              const balances = await readHoldings();
              if (balances.assetRaw !== before) throw new Error("RANKED_POSITION_MISMATCH");
              return balances;
            },
          });
          if (plan.kind !== "operation" || plan.residueRaw !== "0") throw new Error("RANKED_OPERATION_REQUIRED");
          const selectedBlockhash = trackedExit ? await freshExitBlockhash() : undefined;
          if (saved) {
            if (saved.operation_key !== plan.operation.operationKey) throw new Error("RANKED_INBOX_STATE_CHANGED");
          } else {
            inbox.accept(signal.id, signal.sequence, payload, plan.operation.operationKey, independentExit, priorExit);
          }
          const run = actor === "trading_bot" ? runTradingBot : runAiAgent;
          await run({
            client, journal, operation: plan.operation, ports: rankedPorts(before, selectedBlockhash),
          });
          saved = inbox.read(signal.id);
          entry = await readReserved(saved?.operation_key, inputMint);
        } else if (saved?.completed === 0 && !legacyPayload && saved.independent_exit !== null) {
          await resumeRankedOperation(client, journal, String(saved.operation_key), rankedPorts(previous()), signal.expiresAtMs);
          saved = inbox.read(signal.id);
          entry = await readReserved(saved?.operation_key, inputMint);
        }
        if (!saved || typeof saved.operation_key !== "string") throw new Error("RANKED_INBOX_STATE_CHANGED");
        const operationKey = saved.operation_key;
        if (!entry) return { status: "review-required", ranked: false, operationKey };
        const signed = entry.events.find(event => event.stage === "SIGNED");
        const last = entry.events.at(-1);
        if (last?.stage === "UNSENT" || last?.stage === "ABANDONED" || last?.stage === "EXPIRED_UNSENT") {
          return closeUnranked(previous(), last.stage === "ABANDONED" ? "abandoned" : "unsent");
        }
        if (!signed?.intentId || !signed.playerSignature || !entry.events.some(event => event.stage === "SENDING") || last?.stage === "SEND_REFUSED") {
          return { status: "review-required", ranked: false, operationKey };
        }
        const identifiers = { intentId: signed.intentId, txid: signed.playerSignature };
        if (last?.stage === "FINAL_FAILED") return closeUnranked(previous(), "failed", identifiers);
        if (saved.completed === 1) {
          if (last?.stage !== "FINAL_CONFIRMED") throw new Error("RANKED_INBOX_STATE_CHANGED");
          if (saved.receipt === null) {
            const position = signal.side === "flat" && saved.target_position === "0" ? "0" : rawAmount(saved.target_position);
            return closeUnranked(position, "independent-exit", identifiers);
          }
          if (typeof saved.receipt !== "string") throw new Error("RANKED_INBOX_STATE_CHANGED");
          const receipt = JSON.parse(saved.receipt) as RankedReceipt;
          const { amountInRaw, amountOutRaw, feeRaw } = receipt;
          if (receipt.status !== "ranked" || receipt.ranked !== true || receipt.simulatedFeeBps !== 20 ||
              receipt.operationKey !== operationKey || receipt.intentId !== last.intentId || receipt.txid !== last.txid || receipt.seasonId !== seasonId ||
              receipt.accountId !== accountId || receipt.positionAfterRaw !== saved.position_after ||
              saved.quote !== digest({ amountInRaw, amountOutRaw, feeRaw })) {
            throw new Error("RANKED_INBOX_STATE_CHANGED");
          }
          return receipt;
        }
        if (last?.stage !== "FINAL_CONFIRMED") {
          const attempted = saved.result_attempt === 1;
          const final = attempted
            ? await recoverFinalResult(client, journal, operationKey, reference.verifyFinal, assertCurrent)
            : await finalizeOperation(client, journal, operationKey, reference.verifyFinal, async () => {
              await assertCurrent();
              inbox.beforeResult(signal.id);
            });
          if (final === "failed") return closeUnranked(previous(), "failed", identifiers);
          if (final === "unknown") {
            return { status: attempted ? "review-required" : "finality-pending", ranked: false, operationKey, ...identifiers };
          }
        }
        if (independentExit) {
          if (saved.target_position !== "0" || (await readHoldings()).assetRaw !== "0") throw new Error("RANKED_POSITION_MISMATCH");
          return closeUnranked("0", "independent-exit", identifiers);
        }
        const result = await verifyRankedOperation({ ...context, journal, operationKey, usdcMint: policy.usdcMint, readEvidence });
        if (result.status === "not-finalized") throw new Error("RANKED_FINALITY_MISMATCH");
        if (!result.ranked) return { ...result, operationKey };
        const { amountInRaw, amountOutRaw, feeRaw } = result;
        if (saved.quote !== digest({ amountInRaw, amountOutRaw, feeRaw })) throw new Error("RANKED_FILL_MISMATCH");
        const positionAfterRaw = signal.side === "long" ? amountOutRaw : "0";
        if ((await readHoldings()).assetRaw !== positionAfterRaw) {
          throw new Error("RANKED_POSITION_MISMATCH");
        }
        const receipt = { ...result, operationKey, simulatedFeeBps: 20, positionAfterRaw } as const;
        inbox.complete(signal.id, positionAfterRaw, JSON.stringify(receipt));
        return receipt;
      } finally {
        inbox.close();
      }
    });
  }
  return { accept: (line: string) => accept(line), recoverExit: (line: string) => accept(line, true), runScope };
}

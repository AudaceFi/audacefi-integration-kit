// Copy this module beside your reviewed degen-validation-bindings.mjs, outside the checkout.
// The bindings must target an isolated devnet validation season and an enrolled Degen wallet.
import {
  client, rpc, wallet, profile, actor, accountId, seasonId, playerPublicKey, source,
  pair, journalDirectory, entryBudgetRaw, exitBudgetRaw, assertValidationTarget, readEvidence,
} from "./degen-validation-bindings.mjs";

const exitAttempts = pair.exitAttempts + (pair.recoveryExit?.attempts ?? 0);

export default {
  category: "degen",
  client, rpc, wallet, profile, actor, accountId, seasonId, playerPublicKey, source,
  pair, journalDirectory, assertValidationTarget, readEvidence,
  journalPolicy: {
    maxOperations: 1 + exitAttempts,
    inputBudgets: {
      [profile.usdcMainnet]: entryBudgetRaw,
      [pair.assetMint]: exitBudgetRaw,
    },
  },
};

// For local HTTP, also re-export signalHttpToken from your validation bindings.

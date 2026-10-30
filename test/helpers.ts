export const clock = Date.parse("2030-01-01T12:00:00.000Z");
export function frame(id = "synthetic-frame-1"): any {
  return {
    frameId: id,
    clockMs: clock,
    state: {
      asOf: new Date(clock).toISOString(),
      mode: "real",
      category: "crypto-bro",
      season: {
        active: {
          id: "synthetic-season",
          number: 1,
          status: "active",
          executionMode: "devnet_onchain",
          startsAt: new Date(clock - 60000).toISOString(),
          endsAt: new Date(clock + 600000).toISOString(),
        },
        upcoming: null,
      },
      wallet: {
        state: "ok",
        seasonId: "synthetic-season",
        seasonExecutionMode: "devnet_onchain",
        mode: "real",
        category: "crypto_bro",
        walletAddress: "synthetic-wallet",
      },
    },
    market: { mint: "SYNTH_ASSET", observedAtMs: clock, signalBps: 150 },
    portfolio: {
      observedAtMs: clock,
      cashCents: 100000,
      positions: [{ mint: "SYNTH_ASSET", valueCents: 10000 }],
    },
  };
}
export const config = {
  category: "crypto-bro",
  allowlist: ["SYNTH_ASSET"],
  maxAgeMs: 120000,
  maxFutureMs: 30000,
  perProposalCents: 1000,
  maxTotalCents: 2000,
  maxProposals: 2,
  signalThresholdBps: 100,
};

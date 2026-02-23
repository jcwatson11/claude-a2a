import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BudgetTracker } from "../../src/server/services/budget-tracker.js";
import { AppDatabase } from "../../src/server/services/database.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";

const log = pino({ level: "silent" });

describe("BudgetTracker", () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:", log);
  });

  afterEach(() => {
    appDb.close();
  });

  it("allows spending within limits", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.global_daily_limit_usd = 100;
    config.budgets.default_client_daily_limit_usd = 25;

    const tracker = new BudgetTracker(config, log, appDb);
    expect(tracker.check("client1")).toBeNull();
  });

  it("tracks spending and enforces client limit", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.default_client_daily_limit_usd = 1.0;

    const tracker = new BudgetTracker(config, log, appDb);

    tracker.record_cost("client1", 0.5);
    expect(tracker.check("client1")).toBeNull();

    tracker.record_cost("client1", 0.6);
    const err = tracker.check("client1");
    expect(err).toContain("exhausted");
    expect(err).toContain("client1");
  });

  it("enforces global limit", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.global_daily_limit_usd = 1.0;

    const tracker = new BudgetTracker(config, log, appDb);

    tracker.record_cost("client1", 0.5);
    tracker.record_cost("client2", 0.6);
    const err = tracker.check("client3");
    expect(err).toContain("Global");
  });

  it("returns stats", () => {
    const config = loadConfig("/nonexistent");
    const tracker = new BudgetTracker(config, log, appDb);

    tracker.record_cost("alice", 0.5);
    tracker.record_cost("bob", 0.3);

    const stats = tracker.getStats();
    expect(stats.global_spent).toBeCloseTo(0.8);
    expect(stats.clients["alice"]).toBeCloseTo(0.5);
    expect(stats.clients["bob"]).toBeCloseTo(0.3);
  });

  it("uses custom client limit when provided", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.default_client_daily_limit_usd = 10;

    const tracker = new BudgetTracker(config, log, appDb);

    // Spend $2 — within default limit of $10 but exceeds custom limit of $1
    tracker.record_cost("tight-client", 2.0);

    // Default limit: ok
    expect(tracker.check("tight-client")).toBeNull();

    // Custom limit of $1: exhausted
    const err = tracker.check("tight-client", 1.0);
    expect(err).toContain("exhausted");
    expect(err).toContain("tight-client");
  });

  it("writes are immediate — no debounce needed", () => {
    const config = loadConfig("/nonexistent");
    const tracker = new BudgetTracker(config, log, appDb);

    tracker.record_cost("alice", 0.1);
    tracker.record_cost("alice", 0.2);
    tracker.record_cost("alice", 0.3);

    // Data is available immediately (no flush needed)
    const stats = tracker.getStats();
    expect(stats.global_spent).toBeCloseTo(0.6);
    expect(stats.clients["alice"]).toBeCloseTo(0.6);

    // Data survives in a new tracker instance (same DB)
    const tracker2 = new BudgetTracker(config, log, appDb);
    const stats2 = tracker2.getStats();
    expect(stats2.global_spent).toBeCloseTo(0.6);
    expect(stats2.clients["alice"]).toBeCloseTo(0.6);
  });
});

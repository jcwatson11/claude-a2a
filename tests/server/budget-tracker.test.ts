import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BudgetTracker } from "../../src/server/services/budget-tracker.js";
import { loadConfig } from "../../src/server/config.js";
import pino from "pino";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const log = pino({ level: "silent" });
const tmpDir = join(import.meta.dirname, ".tmp-budget-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("BudgetTracker", () => {
  it("allows spending within limits", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.global_daily_limit_usd = 100;
    config.budgets.default_client_daily_limit_usd = 25;

    const tracker = new BudgetTracker(config, log, join(tmpDir, "budget.json"));
    expect(tracker.check("client1")).toBeNull();
  });

  it("tracks spending and enforces client limit", () => {
    const config = loadConfig("/nonexistent");
    config.budgets.default_client_daily_limit_usd = 1.0;

    const tracker = new BudgetTracker(config, log, join(tmpDir, "budget.json"));

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

    const tracker = new BudgetTracker(config, log, join(tmpDir, "budget.json"));

    tracker.record_cost("client1", 0.5);
    tracker.record_cost("client2", 0.6);
    const err = tracker.check("client3");
    expect(err).toContain("Global");
  });

  it("returns stats", () => {
    const config = loadConfig("/nonexistent");
    const tracker = new BudgetTracker(config, log, join(tmpDir, "budget.json"));

    tracker.record_cost("alice", 0.5);
    tracker.record_cost("bob", 0.3);

    const stats = tracker.getStats();
    expect(stats.global_spent).toBeCloseTo(0.8);
    expect(stats.clients["alice"]).toBeCloseTo(0.5);
    expect(stats.clients["bob"]).toBeCloseTo(0.3);
  });
});

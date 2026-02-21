import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../config.js";

interface DailyRecord {
  date: string; // YYYY-MM-DD
  global: number;
  clients: Record<string, number>;
}

export class BudgetTracker {
  private record: DailyRecord;
  private readonly persistPath: string;
  private readonly globalLimit: number;
  private readonly defaultClientLimit: number;
  private readonly log: Logger;

  constructor(config: Config, log: Logger, persistPath?: string) {
    this.globalLimit = config.budgets.global_daily_limit_usd;
    this.defaultClientLimit = config.budgets.default_client_daily_limit_usd;
    this.log = log.child({ component: "budget" });
    this.persistPath =
      persistPath ?? "/var/lib/claude-a2a/budget.json";
    this.record = this.loadOrCreate();
  }

  /** Check if spending is within limits. Returns null if ok, or error message. */
  check(clientName: string, clientLimit?: number): string | null {
    this.rolloverIfNeeded();

    if (this.record.global >= this.globalLimit) {
      return `Global daily budget exhausted ($${this.record.global.toFixed(2)}/$${this.globalLimit.toFixed(2)})`;
    }

    const limit = clientLimit ?? this.defaultClientLimit;
    const clientSpend = this.record.clients[clientName] ?? 0;
    if (clientSpend >= limit) {
      return `Client "${clientName}" daily budget exhausted ($${clientSpend.toFixed(2)}/$${limit.toFixed(2)})`;
    }

    return null;
  }

  /** Record a cost after a successful invocation */
  record_cost(clientName: string, costUsd: number): void {
    this.rolloverIfNeeded();
    this.record.global += costUsd;
    this.record.clients[clientName] =
      (this.record.clients[clientName] ?? 0) + costUsd;
    this.persist();
    this.log.debug(
      { client: clientName, cost: costUsd, globalTotal: this.record.global },
      "recorded cost",
    );
  }

  getStats(): {
    date: string;
    global_spent: number;
    global_limit: number;
    clients: Record<string, number>;
  } {
    this.rolloverIfNeeded();
    return {
      date: this.record.date,
      global_spent: this.record.global,
      global_limit: this.globalLimit,
      clients: { ...this.record.clients },
    };
  }

  private rolloverIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.record.date !== today) {
      this.log.info(
        { oldDate: this.record.date, newDate: today },
        "daily budget rollover",
      );
      this.record = { date: today, global: 0, clients: {} };
      this.persist();
    }
  }

  private loadOrCreate(): DailyRecord {
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(
          readFileSync(this.persistPath, "utf-8"),
        ) as DailyRecord;
        if (data.date === today) return data;
      }
    } catch {
      this.log.warn("failed to load budget file, starting fresh");
    }
    return { date: today, global: 0, clients: {} };
  }

  private persist(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistPath, JSON.stringify(this.record, null, 2));
    } catch (err) {
      this.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "failed to persist budget",
      );
    }
  }
}

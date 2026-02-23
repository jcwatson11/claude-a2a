import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { AppDatabase } from "./database.js";
import type Database from "better-sqlite3";

export class BudgetTracker {
  private readonly globalLimit: number;
  private readonly defaultClientLimit: number;
  private readonly log: Logger;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGetClient: Database.Statement;
  private readonly stmtGetGlobal: Database.Statement;
  private readonly stmtGetAllClients: Database.Statement;

  constructor(config: Config, log: Logger, appDb: AppDatabase) {
    this.globalLimit = config.budgets.global_daily_limit_usd;
    this.defaultClientLimit = config.budgets.default_client_daily_limit_usd;
    this.log = log.child({ component: "budget" });

    this.stmtUpsert = appDb.db.prepare(`
      INSERT INTO budget_records (date, client_name, spent_usd)
      VALUES (?, ?, ?)
      ON CONFLICT(date, client_name)
      DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd
    `);

    this.stmtGetClient = appDb.db.prepare(
      "SELECT spent_usd FROM budget_records WHERE date = ? AND client_name = ?",
    );

    this.stmtGetGlobal = appDb.db.prepare(
      "SELECT COALESCE(SUM(spent_usd), 0) as total FROM budget_records WHERE date = ?",
    );

    this.stmtGetAllClients = appDb.db.prepare(
      "SELECT client_name, spent_usd FROM budget_records WHERE date = ?",
    );
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Check if spending is within limits. Returns null if ok, or error message. */
  check(clientName: string, clientLimit?: number): string | null {
    const date = this.today();

    const globalRow = this.stmtGetGlobal.get(date) as { total: number };
    if (globalRow.total >= this.globalLimit) {
      return `Global daily budget exhausted ($${globalRow.total.toFixed(2)}/$${this.globalLimit.toFixed(2)})`;
    }

    const limit = clientLimit ?? this.defaultClientLimit;
    const clientRow = this.stmtGetClient.get(date, clientName) as
      | { spent_usd: number }
      | undefined;
    const clientSpend = clientRow?.spent_usd ?? 0;
    if (clientSpend >= limit) {
      return `Client "${clientName}" daily budget exhausted ($${clientSpend.toFixed(2)}/$${limit.toFixed(2)})`;
    }

    return null;
  }

  /** Record a cost after a successful invocation */
  record_cost(clientName: string, costUsd: number): void {
    const date = this.today();
    this.stmtUpsert.run(date, clientName, costUsd);
    this.log.info(
      { client: clientName, cost: costUsd },
      "recorded cost",
    );
  }

  /** No-op — writes are immediate with SQLite. Kept for API compatibility. */
  flush(): void {
    // Intentionally empty: SQLite writes are immediate
  }

  getStats(): {
    date: string;
    global_spent: number;
    global_limit: number;
    clients: Record<string, number>;
  } {
    const date = this.today();
    const globalRow = this.stmtGetGlobal.get(date) as { total: number };
    const clientRows = this.stmtGetAllClients.all(date) as {
      client_name: string;
      spent_usd: number;
    }[];

    const clients: Record<string, number> = {};
    for (const row of clientRows) {
      clients[row.client_name] = row.spent_usd;
    }

    return {
      date,
      global_spent: globalRow.total,
      global_limit: this.globalLimit,
      clients,
    };
  }
}

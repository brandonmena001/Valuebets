import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const sourceStatusTable = pgTable("source_status", {
  provider: text("provider").primaryKey(),
  state: text("state").notNull().default("waiting"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  recordsCollected: integer("records_collected").notNull().default(0),
  requestsRemaining: integer("requests_remaining"),
  requestLimit: integer("request_limit"),
  requestsUsed: integer("requests_used").notNull().default(0),
  quotaPeriodStart: timestamp("quota_period_start", { withTimezone: true }),
  message: text("message"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSourceStatusSchema = createInsertSchema(sourceStatusTable).omit({
  updatedAt: true,
});

export type InsertSourceStatus = z.infer<typeof insertSourceStatusSchema>;
export type SourceStatusRecord = typeof sourceStatusTable.$inferSelect;
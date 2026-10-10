import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Caché persistente de respuestas de proveedores que casi no cambian (catálogos de OddsPapi).
 * Evita gastar llamadas de cuota cada vez que se reinicia el servidor.
 */
export const providerCacheTable = pgTable("provider_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProviderCacheRow = typeof providerCacheTable.$inferSelect;

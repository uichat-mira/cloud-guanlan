import {
  foreignKey, index, integer, primaryKey, sqliteTable, text,
} from "drizzle-orm/sqlite-core";

// Shared ingestion tables. Do not move global source/news rows into user space.
export const pocSources = sqliteTable("poc_sources", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  intervalHours: integer("interval_hours").notNull().default(1),
  dueAt: text("due_at").notNull(),
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  lastCheckedAt: text("last_checked_at"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  retryCount: integer("retry_count").notNull().default(0),
});

export const pocNews = sqliteTable("poc_news", {
  url: text("url").primaryKey(),
  sourceId: text("source_id").notNull().references(() => pocSources.id),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  publishedAt: text("published_at"),
  ingestedAt: text("ingested_at").notNull(),
});

export const guanlanAccounts = sqliteTable("guanlan_accounts", {
  accountId: text("account_id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export const guanlanConsumers = sqliteTable("guanlan_consumers", {
  accountId: text("account_id").notNull().references(() => guanlanAccounts.accountId, { onDelete: "cascade" }),
  consumerId: text("consumer_id").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [
  primaryKey({ columns: [t.accountId, t.consumerId] }),
  index("idx_guanlan_consumers_account").on(t.accountId),
]);

export const guanlanAccountSubscriptions = sqliteTable("guanlan_account_subscriptions", {
  accountId: text("account_id").notNull().references(() => guanlanAccounts.accountId, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => pocSources.id, { onDelete: "restrict" }),
  intervalHours: integer("interval_hours").notNull().default(1),
  createdAt: text("created_at").notNull(),
}, t => [
  primaryKey({ columns: [t.accountId, t.sourceId] }),
  index("idx_guanlan_account_subscriptions_source").on(t.sourceId),
]);

export const guanlanConsumerSubscriptions = sqliteTable("guanlan_consumer_subscriptions", {
  accountId: text("account_id").notNull(),
  consumerId: text("consumer_id").notNull(),
  sourceId: text("source_id").notNull().references(() => pocSources.id, { onDelete: "restrict" }),
  intervalHours: integer("interval_hours").notNull().default(1),
  createdAt: text("created_at").notNull(),
}, t => [
  primaryKey({ columns: [t.accountId, t.consumerId, t.sourceId] }),
  foreignKey({
    columns: [t.accountId, t.consumerId],
    foreignColumns: [guanlanConsumers.accountId, guanlanConsumers.consumerId],
  }).onDelete("cascade"),
  index("idx_guanlan_consumer_subscriptions_source").on(t.sourceId),
]);

export const guanlanAccountInterests = sqliteTable("guanlan_account_interests", {
  accountId: text("account_id").notNull().references(() => guanlanAccounts.accountId, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["keyword", "topic"] }).notNull(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [
  primaryKey({ columns: [t.accountId, t.kind, t.value] }),
]);

export const guanlanConsumerInterests = sqliteTable("guanlan_consumer_interests", {
  accountId: text("account_id").notNull(),
  consumerId: text("consumer_id").notNull(),
  kind: text("kind", { enum: ["keyword", "topic"] }).notNull(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [
  primaryKey({ columns: [t.accountId, t.consumerId, t.kind, t.value] }),
  foreignKey({
    columns: [t.accountId, t.consumerId],
    foreignColumns: [guanlanConsumers.accountId, guanlanConsumers.consumerId],
  }).onDelete("cascade"),
]);

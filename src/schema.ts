import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pocNews = sqliteTable("poc_news", {
  url: text("url").primaryKey(),
  sourceId: text("source_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  publishedAt: text("published_at"),
  ingestedAt: text("ingested_at").notNull(),
});

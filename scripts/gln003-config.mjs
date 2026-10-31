#!/usr/bin/env node
// GLN-003: creates a *local*, explicit canary Wrangler config. Never deploys.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CANARY_NAME = "cloud-guanlan-gln003-canary";
export const CANARY_DATABASE = "cloud-guanlan-gln003-canary";
const SENTINEL_D1 = "00000000-0000-0000-0000-000000000000";
const ACCOUNT_RE = /^[0-9a-f]{32}$/i;
const DB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const cron = args.has("--enable-cron");

function fail(reason) {
  throw new Error("GLN003 preflight: " + reason);
}
if ([...args].some(a => !["--dry-run", "--enable-cron"].includes(a))) fail("unknown argument");
if (dryRun && cron) fail("dry-run cannot enable live Cron");
let accountId, databaseId;
if (dryRun) {
  accountId = undefined;
  databaseId = SENTINEL_D1;
} else {
  accountId = process.env.GLN003_ACCOUNT_ID;
  databaseId = process.env.GLN003_DATABASE_ID;
  if (!ACCOUNT_RE.test(accountId ?? "")) fail("GLN003_ACCOUNT_ID missing or invalid");
  if (!DB_RE.test(databaseId ?? "") || databaseId === SENTINEL_D1) fail("GLN003_DATABASE_ID missing/placeholder/invalid");
  if (process.env.GLN003_CONFIRMED_PLAN !== "free") {
    fail("the account's Workers Free plan must be independently confirmed by an authorized operator");
  }
  if (process.env.GLN003_CONFIRM_ISOLATION !== CANARY_NAME) {
    fail("explicit isolation acknowledgement missing");
  }
  if (cron && process.env.GLN003_CONFIRM_CRON !== "yes") {
    fail("explicit Cron activation acknowledgement missing");
  }
}
const config = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: CANARY_NAME,
  main: "../../src/index.ts",
  compatibility_date: "2026-08-06",
  ...(accountId ? { account_id: accountId } : {}),
  workers_dev: true,
  // This Worker only has public GET /health; no user/account API.
  routes: [],
  observability: { enabled: true },
  triggers: { crons: cron ? ["*/5 * * * *"] : [] },
  d1_databases: [{
    binding: "DB",
    database_name: CANARY_DATABASE,
    database_id: databaseId,
    migrations_dir: "../../migrations",
  }],
};
if (config.name !== CANARY_NAME || config.d1_databases[0].database_name !== CANARY_DATABASE) fail("canary identity changed");
const directory = resolve("dist/gln003");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory,"wrangler.json"), JSON.stringify(config,null,2)+"\n", {mode:0o600});
console.log(JSON.stringify({
  generated:"dist/gln003/wrangler.json",
  name:config.name,
  database:config.d1_databases[0].database_name,
  cron:config.triggers.crons,
  dryRun,
  action:"configuration only; no resources changed",
}));

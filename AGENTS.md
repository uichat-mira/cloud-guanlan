# Cloud Guanlan — Repository Engineering Instructions

Follow the **current** [Mira Organization AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md), its work-item ID registry, issue lifecycle, testing and environment policies. Do not infer an override from cached instructions.

## Product ownership

Cloud Guanlan is the Mira Cloud multi-user **news collector and consumption-state service**. Product truth lives in [docs/product-design.md](docs/product-design.md). It does not own the Mira Cloud Account identity system, run Agent/LLM inference, do semantic recommendation, scrape entire articles, or decide whether an external consumer adopts news.

Public sources and private subscriptions must not be conflated. Personal subscriptions/interest profiles and per-consumer status/history are private; the same URL can be fetched once without revealing which users follow it.

## Source of truth and work item contract

- The root product design owns product boundaries; the **GitHub Issue** owns scope, deliverable, acceptance evidence and decisions for one implementation unit.
- The Organization's `work-item-ids.md` is the only semantic ID registry. Do **not** invent a local ticket-number counter or shadow work-item list. Guanlan's proposed `GLN` prefix only becomes canonical after the Organization registry change is approved and merged.
- Project Status `Todo → In Progress → Done` is the sole lifecycle projection; do not use labels or markdown task tables to mirror it.
- Before code changes, read the Issue, current design, related implementation and authorization boundaries; distinguish verified reality from planned capabilities.
- Any contract changes must update the owning Issue, not an ad hoc alternative task board.

## Branches and delivery

- The repository default branch is currently `dev` and is **not** production.
- Normal flow: `feat/* → dev → test → prod`. Create `test`/`prod` only when environment setup is separately authorized; never deploy production from `dev`.
- A paid OpenCode external Worker may be dispatched only for an explicit, authorized, open Issue by a trusted maintainer using exactly `/worker run` on the Issue, or a maintainer-triggered `workflow_dispatch` with the Issue number.
- The repository caller uses the pinned, centralized Organization Worker. Do not duplicate the engine or relax maintainer/issue validation, token permissions or run-scoped identity.
- The Worker must produce an isolated branch, run the repository's verification gate and deliver a **Draft PR targeting dev**. No automatic merge, Issue closure, Project status mutation, deployment or production promotion.
- The paid Worker has a maximum runtime budget of 60 minutes **including verification**. Keep authorized tasks small, avoid packaging/builds unrelated to scope, and do not let slow unrelated work consume the run.
- Provider credentials use GitHub Actions Secrets only, never committed values, CI logs or generated files. A secret name in YAML does not prove that a repo can access the configured Organization secret.

## Cloudflare / D1 boundary

- Cloudflare Workers Free + Cron + D1 is the **preferred design to be measured**, not a verified hosting capability.
- Avoid server-only Node APIs, `better-sqlite3`, full text fetch, persistent host processes and new paid services without explicit design/acceptance.
- The Cloud Auth issuer/audience/session boundaries are owned by Cloud Auth. A signed token does not automatically grant access to another user's Guanlan subscriptions or consumer history.
- Read-only URL tokens must never be able to change state or subscriptions. Status updates are explicit, authenticated and isolated by account and stable consumer identity.
- External feed URLs are untrusted and require SSRF, DNS/redirect and response-size safeguards, to be proven against Workers runtime.
- Do not commit secrets, tokens, private URLs, account content, production D1 data, deployment credentials, wrangler secrets or sensitive logs.

## Verification and release

- `bash scripts/check.sh` is the shared local/CI/Worker gate.
- While no runtime project exists, it explicitly checks documentation scaffolding and refuses runtime files without a `package.json`.
- When runtime code is introduced, the Issue must supply a reproducible `npm run check` (T1/T2 and real Workers/D1 contract verification appropriate to the changed surface); the gate fails if missing.
- Deployment, auth, permission and persistence changes require real runtime/integration evidence. Never claim tests, deployment or Cloudflare Free eligibility based on scaffolding CI alone.
- CI / Sonar / AI Review are evidence, not approval. Merge, acceptance, Issue close and promotion require their own explicit authority.
- No production deployment workflow or Cloudflare bindings are configured by this bootstrap. Production releases must be independently reviewed, protected, smoke tested and rollbackable.

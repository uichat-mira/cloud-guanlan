# Guanlan engineering work items

Guanlan's task contracts live **only in GitHub Issues**, using the Organization-wide [Work Item skill](https://github.com/uichat-mira/.github/blob/main/skills/create-work-item/SKILL.md), [Issue template](https://github.com/uichat-mira/.github/blob/main/.github/ISSUE_TEMPLATE/work-item.yml), [ID registry](https://github.com/uichat-mira/.github/blob/main/docs/governance/work-item-ids.md) and [lifecycle](https://github.com/uichat-mira/.github/blob/main/docs/governance/work-item-lifecycle.md).

The proposed stable news-service domain prefix is **GLN** (`[GLN-001]`, etc.). **Do not allocate it until its Organization registry change is merged.** AGT continues to own actual shared Agent/Worker platform changes; GLN owns Guanlan-specific product/runtime work, including its repository's caller integration.

## Contract per Issue

Write **Goal / Context / Scope / Non-goals / Acceptance criteria / Verification & evidence / Dependencies & risks**. An open Issue alone does not authorize execution. Keep each issue independently testable and short enough for one Worker budget (60 min maximum). Do not mirror task cards in a repo markdown backlog, custom Issue label lifecycle or numbering file.

No Issue should merely say "build Guanlan" or ask the Worker to invent architecture. Use the validated [product design](../product-design.md), existing Mira Cloud identity contract, Cloudflare Free limits and current code as the authority for each acceptance boundary.

## Dispatching the paid OpenCode Worker

1. A maintainer confirms an authorized **open ordinary Issue** with a complete contract. From the repo default branch, the workflow accepts a new Issue comment containing **exactly** `/worker run`. A manual `workflow_dispatch` with the Issue number is also supported.
2. The caller revalidates the human author, their current write permission, open Issue contract and live comment. It calls the pinned [Organization external Worker](https://github.com/uichat-mira/.github/blob/main/.github/workflows/mira-external-worker.yml) with `provider=opencode-go`, `model=deepseek-v4.1-flash`, `base_branch=dev`, `timeout_minutes=60`.
3. Requires GitHub Actions to make `AI_PROVIDER_OPENCODE_GO_KEY` available to this repository **and** allow PR creation by the workflow token. Those account-level settings cannot be proven by the presence of this YAML file.
4. The Worker proposes a **Draft PR into dev** and runs `bash scripts/check.sh`. Review the diff and evidence before accepting; the Worker **never automatically merges**, ships or closes an Issue.
5. If the Worker fails or times out, inspect its run artifacts and branch rather than repeatedly dispatching blindly; an engineering maintainer takes over after repeated ineffective retries.

No paid dispatch is performed as part of infrastructure setup. To validate credentials and GitHub permissions, run a separately authorized, tiny Issue task and inspect real Actions logs.

## Next work package candidates (not Issues, not an authorized execution queue)

1. Free Worker + D1 minimal POC for bounded RSS/Atom fetch, durable state and hourly trigger.
2. Cloud Auth audience-bound service identity and per-consumer authorization boundary.
3. Private source configuration, safe feed discovery and shared URL deduplication.
4. Stateless, paginated Markdown/JSON reading with explicit status writeback and durable consumer history.
5. Usage budget evidence, 90-day cleanup and failure semantics.

These are **candidates**, not official task cards; do not create them without separate explicit work-item authority. The unresolved product decision about free quota exhaustion remains unresolved.

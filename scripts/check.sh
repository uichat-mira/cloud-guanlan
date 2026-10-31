#!/usr/bin/env bash
# One repository gate used by both CI and paid OpenCode Worker verification.
set -euo pipefail

test -s README.md
test -s AGENTS.md
test -s docs/product-design.md
test -s docs/engineering/work-items.md
test -s LICENSE

if [[ -f package.json ]]; then
  # No silent docs-only gate once runnable service code exists.
  if [[ ! -f package-lock.json ]]; then
    echo "::warning::GLN-001 POC has no committed lockfile yet; generating one for this CI invocation (NOT reproducible across future runs)."
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  fi
  command -v node >/dev/null
  command -v npm >/dev/null
  node --version
  npm ci --no-audit --no-fund
  npm run check
else
  # Bootstrap remains docs-only; ensure adding runtime code requires a real
  # package manifest and corresponding test/verification pipeline.
  for path in src worker migrations wrangler.toml wrangler.json wrangler.jsonc; do
    if [[ -e "$path" ]]; then
      echo "Runtime artifact '$path' exists without a package.json and npm run check contract" >&2
      exit 1
    fi
  done
  echo "Guanlan documentation-only bootstrap: no runtime tests are available yet."
fi

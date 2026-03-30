#!/bin/bash
set -euo pipefail

# AgentBridge Release Script
# Usage: ./scripts/release.sh <patch|minor|major> [--dry-run]
#
# Steps:
#   1. Validate environment (clean tree, on master, tools available)
#   2. Bump version in package.json, plugin.json, marketplace.json
#   3. Run typecheck + tests
#   4. Commit on release branch, push, create PR, merge
#   5. Create GitHub Release (triggers npm publish via Actions)

REPO="raysonmeng/agent-bridge"
DRY_RUN=false

# ── Parse args ────────────────────────────────────────────

BUMP_TYPE="${1:-}"
if [[ "$BUMP_TYPE" == "" ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major> [--dry-run]"
  echo ""
  echo "Examples:"
  echo "  ./scripts/release.sh patch      # 0.1.1 → 0.1.2"
  echo "  ./scripts/release.sh minor      # 0.1.1 → 0.2.0"
  echo "  ./scripts/release.sh major      # 0.1.1 → 1.0.0"
  echo "  ./scripts/release.sh patch --dry-run"
  exit 1
fi

if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN MODE]"
fi

# ── Helpers ───────────────────────────────────────────────

# Cross-platform JSON version update (uses node, no sed -i portability issues)
bump_version_in_file() {
  local file="$1"
  local old="$2"
  local new="$3"
  FILE="$file" OLD_VER="$old" NEW_VER="$new" node -e '
    const fs = require("fs");
    const { FILE, OLD_VER, NEW_VER } = process.env;
    const content = fs.readFileSync(FILE, "utf8");
    const updated = content.replace(`"version": "${OLD_VER}"`, `"version": "${NEW_VER}"`);
    if (content === updated) { console.error("WARNING: version not found in " + FILE); process.exit(1); }
    fs.writeFileSync(FILE, updated);
  '
}

PR_URL=""  # global for cleanup access

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo ""
    echo "ERROR: Release failed. Cleaning up..."
    local current_branch
    current_branch=$(git branch --show-current)
    if [[ "$current_branch" == chore/release-* ]]; then
      # Discard uncommitted version bumps before switching branch
      git checkout -- . 2>/dev/null || true
      git checkout master 2>/dev/null || true
      git branch -D "$current_branch" 2>/dev/null || true
      echo "Cleaned up local branch: $current_branch"
      echo "If a remote branch was pushed, delete it with:"
      echo "  git push origin --delete \"$current_branch\""
    fi
    if [[ -n "$PR_URL" ]]; then
      echo "An open PR may need manual cleanup: $PR_URL"
    fi
  fi
}
trap cleanup EXIT

# ── Step 0: Validate environment ─────────────────────────

echo "=== Validating environment ==="

for cmd in gh node bun git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd not found in PATH"
    exit 1
  fi
done

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "master" ]]; then
  echo "Error: must be on master branch (current: $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

git pull origin master

# ── Calculate version ─────────────────────────────────────

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *) echo "Error: bump type must be patch, minor, or major"; exit 1 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

if $DRY_RUN; then
  echo ""
  echo "[DRY RUN] Would bump $CURRENT_VERSION → $NEW_VERSION"
  echo "[DRY RUN] Would update: package.json, plugin.json, marketplace.json"
  echo "[DRY RUN] Would create GitHub Release v$NEW_VERSION"
  exit 0
fi

# Confirm
echo ""
read -rp "Release v$NEW_VERSION? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Step 1: Create release branch FIRST, then bump ───────

echo ""
echo "=== Step 1: Create release branch + bump version ==="

BRANCH_NAME="chore/release-v$NEW_VERSION"
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
  echo "Error: branch $BRANCH_NAME already exists locally"
  exit 1
fi
if git ls-remote --heads origin "$BRANCH_NAME" 2>/dev/null | grep -q .; then
  echo "Error: remote branch $BRANCH_NAME already exists on origin"
  exit 1
fi

git checkout -b "$BRANCH_NAME"

bump_version_in_file "package.json" "$CURRENT_VERSION" "$NEW_VERSION"
bump_version_in_file "plugins/agentbridge/.claude-plugin/plugin.json" "$CURRENT_VERSION" "$NEW_VERSION"
bump_version_in_file ".claude-plugin/marketplace.json" "$CURRENT_VERSION" "$NEW_VERSION"

echo "Updated package.json, plugin.json, marketplace.json → $NEW_VERSION"

# ── Step 2: Verify ────────────────────────────────────────

echo ""
echo "=== Step 2: Verify ==="

echo "Running typecheck..."
bun run typecheck

echo "Running tests..."
bun test src/

echo "All checks passed."

# ── Step 3: Commit, push, PR, merge ──────────────────────

echo ""
echo "=== Step 3: Commit + PR + merge ==="

git add package.json plugins/agentbridge/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to $NEW_VERSION"
git push -u origin "$BRANCH_NAME"

echo "Creating PR..."
PR_URL=$(gh pr create --repo "$REPO" --base master --head "$BRANCH_NAME" \
  --title "chore: bump version to $NEW_VERSION" \
  --body "Automated version bump for v$NEW_VERSION release.")
echo "PR: $PR_URL"

echo "Merging PR..."
PR_NUM=$(echo "$PR_URL" | grep -o '[0-9]*$')
gh pr merge "$PR_NUM" --repo "$REPO" --squash --admin --delete-branch

git checkout master
git pull origin master

RELEASE_SHA=$(git rev-parse HEAD)
echo "Merged. Release SHA: $RELEASE_SHA"

# ── Step 4: Create GitHub Release ─────────────────────────

echo ""
echo "=== Step 4: Create GitHub Release ==="

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  CHANGELOG=$(git log "$LAST_TAG"..HEAD --oneline --no-merges | grep -v "chore: bump" || true)
  COMPARE_BASE="$LAST_TAG"
else
  CHANGELOG=$(git log --oneline --no-merges | grep -v "chore: bump" || true)
  COMPARE_BASE=$(git rev-list --max-parents=0 HEAD | head -1)
fi

FEATS=$(echo "$CHANGELOG" | grep -iE "^[a-f0-9]+ feat" || true)
FIXES=$(echo "$CHANGELOG" | grep -iE "^[a-f0-9]+ fix" || true)
OTHERS=$(echo "$CHANGELOG" | grep -ivE "^[a-f0-9]+ (feat|fix|chore)" || true)

NOTES="## What's Changed"$'\n'
if [[ -n "$FIXES" ]]; then
  NOTES+=$'\n'"### Bug Fixes"$'\n'
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    NOTES+="- ${line#* }"$'\n'
  done <<< "$FIXES"
fi
if [[ -n "$FEATS" ]]; then
  NOTES+=$'\n'"### Features"$'\n'
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    NOTES+="- ${line#* }"$'\n'
  done <<< "$FEATS"
fi
if [[ -n "$OTHERS" ]]; then
  NOTES+=$'\n'"### Other"$'\n'
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    NOTES+="- ${line#* }"$'\n'
  done <<< "$OTHERS"
fi

NOTES+=$'\n'"### Installation"$'\n'
NOTES+='```bash'$'\n'
NOTES+="npm install -g @raysonmeng/agentbridge"$'\n'
NOTES+='```'$'\n'
NOTES+=$'\n'"**Full Changelog:** https://github.com/$REPO/compare/$COMPARE_BASE...v$NEW_VERSION"

RELEASE_URL=$(gh release create "v$NEW_VERSION" \
  --repo "$REPO" \
  --title "v$NEW_VERSION" \
  --notes "$NOTES" \
  --target "$RELEASE_SHA")

echo "Release created: $RELEASE_URL"
echo "npm publish will be triggered automatically by GitHub Actions."
echo ""
echo "=============================="
echo "  Release complete: v$NEW_VERSION"
echo "=============================="

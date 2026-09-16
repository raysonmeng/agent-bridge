#!/usr/bin/env bash
set -euo pipefail

# AgentBridge native installer for macOS, Linux, and WSL.
# The installer consumes a package attached to a GitHub Release. It does not
# require Node/npm and never runs `abg init`.

REPOSITORY="${AGENTBRIDGE_INSTALL_REPOSITORY:-raysonmeng/agent-bridge}"
BASE_URL_OVERRIDE="${AGENTBRIDGE_RELEASE_BASE_URL:-}"
INSTALL_ROOT="${AGENTBRIDGE_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agentbridge}"
BIN_DIR="${AGENTBRIDGE_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
ASSET_NAME="${AGENTBRIDGE_RELEASE_ASSET:-agentbridge.tgz}"
CHECKSUM_NAME="${AGENTBRIDGE_RELEASE_CHECKSUM:-${ASSET_NAME}.sha256}"

VERSION=""
YES=false
DRY_RUN=false
FORCE=false

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install AgentBridge from a GitHub Release without requiring Node/npm.

Options:
  --version VERSION  Install a specific release instead of latest
  --yes              Allow installation of Bun in non-interactive mode
  --dry-run          Print planned actions without changing the machine
  --force            Allow replacement while an AgentBridge pair is active
  -h, --help         Show this help
EOF
}

die() {
  printf 'AgentBridge installer: error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'AgentBridge installer: warning: %s\n' "$*" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --yes)
      YES=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (use --help for usage)"
      ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported operating system: $OS; use macOS, Linux, or WSL" ;;
esac

case "$(uname -m)" in
  arm64|aarch64|x86_64|amd64) ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

for command_name in curl tar; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

hash_command=""
if command -v shasum >/dev/null 2>&1; then
  hash_command="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  hash_command="sha256sum"
else
  die "required checksum command not found: shasum or sha256sum"
fi

version_at_least() {
  local actual="$1" required="$2"
  local actual_major actual_minor actual_patch required_major required_minor required_patch
  [[ "$actual" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  [[ "$required" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  IFS=. read -r actual_major actual_minor actual_patch <<EOF
$actual
EOF
  IFS=. read -r required_major required_minor required_patch <<EOF
$required
EOF
  actual_major="${actual_major:-0}"; actual_minor="${actual_minor:-0}"; actual_patch="${actual_patch:-0}"
  required_major="${required_major:-0}"; required_minor="${required_minor:-0}"; required_patch="${required_patch:-0}"
  [ "$actual_major" -gt "$required_major" ] || {
    [ "$actual_major" -eq "$required_major" ] || return 1
    [ "$actual_minor" -gt "$required_minor" ] || {
      [ "$actual_minor" -eq "$required_minor" ] || return 1
      [ "$actual_patch" -ge "$required_patch" ] || return 1
    }
  }
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    local bun_version
    bun_version="$(bun --version 2>/dev/null || true)"
    version_at_least "$bun_version" "1.3.11" || die "Bun $bun_version is too old; AgentBridge requires Bun >= 1.3.11"
    printf 'Bun %s detected.\n' "$bun_version"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    printf 'Bun is missing; would run the official Bun installer.\n'
    return
  fi

  if [ "$YES" != true ]; then
    if [ ! -t 0 ] || [ ! -t 2 ]; then
      die "Bun is missing; rerun interactively and approve installation, or pass --yes"
    fi
    printf 'Bun is required. Run the official Bun installer now? [y/N] ' >&2
    local answer
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) die "Bun installation was declined" ;;
    esac
  fi

  printf 'Installing Bun from https://bun.sh/install ...\n'
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun installed but is not on PATH; restart your shell and rerun the installer"
  local installed_version
  installed_version="$(bun --version)"
  version_at_least "$installed_version" "1.3.11" || die "installed Bun $installed_version is too old"
}

active_pair_detected() {
  local process_list
  process_list="$(ps -axo pid=,command= 2>/dev/null || true)"
  printf '%s\n' "$process_list" | grep -Eq 'bridge-server\.js|codex[[:space:]].*--enable[[:space:]]+tui_app_server'
}

check_active_pair() {
  if ! active_pair_detected; then
    return
  fi
  if [ "$FORCE" = true ]; then
    warn "an active AgentBridge pair was detected; --force allows replacement"
    return
  fi
  if [ "$DRY_RUN" = true ]; then
    die "an active AgentBridge pair was detected; pass --force to simulate replacement"
  fi
  if [ ! -t 0 ] || [ ! -t 2 ]; then
    die "an active AgentBridge pair was detected; stop it first or rerun with --force"
  fi
  printf 'An active AgentBridge pair was detected. Replace it? [y/N] ' >&2
  local answer
  read -r answer
  case "$answer" in
    y|Y|yes|YES) warn "replacing the active pair" ;;
    *) die "upgrade cancelled; active pair was left untouched" ;;
  esac
}

release_base_url() {
  if [ -n "$BASE_URL_OVERRIDE" ]; then
    printf '%s\n' "${BASE_URL_OVERRIDE%/}"
  elif [ -n "$VERSION" ]; then
    printf '%s\n' "https://github.com/$REPOSITORY/releases/download/v$VERSION"
  else
    printf '%s\n' "https://github.com/$REPOSITORY/releases/latest/download"
  fi
}

sha256_of() {
  if [ "$hash_command" = shasum ]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

register_plugin() {
  local package_root="$1"
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code not found; plugin registration skipped"
    printf 'Install Claude Code with: curl -fsSL https://claude.ai/install.sh | bash\n'
    return
  fi
  if claude plugin marketplace add "$package_root" >/dev/null 2>&1 && \
     claude plugin install agentbridge@agentbridge >/dev/null 2>&1; then
    printf 'Claude Code plugin registered.\n'
  else
    warn 'Claude Code plugin registration failed; rerun "abg init" after checking Claude'
  fi
}

check_external_agents() {
  if ! command -v claude >/dev/null 2>&1; then
    warn 'Claude Code not found; install it with: curl -fsSL https://claude.ai/install.sh | bash'
  fi
  if ! command -v codex >/dev/null 2>&1; then
    warn 'Codex CLI not found; install it from https://github.com/openai/codex'
  fi
}

check_active_pair
ensure_bun

BASE_URL="$(release_base_url)"
if [ "$DRY_RUN" = true ]; then
  printf 'Would download %s/%s and %s/%s\n' "$BASE_URL" "$ASSET_NAME" "$BASE_URL" "$CHECKSUM_NAME"
  printf 'Would stage under %s/versions and activate %s/agentbridge + %s/abg\n' "$INSTALL_ROOT" "$BIN_DIR" "$BIN_DIR"
  printf 'Would register the Claude Code plugin if claude is available.\n'
  exit 0
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agentbridge-install.XXXXXX")"
STAGE="$TEMP_ROOT/package"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT
mkdir -p "$STAGE"

ARCHIVE="$TEMP_ROOT/$ASSET_NAME"
CHECKSUM="$TEMP_ROOT/$CHECKSUM_NAME"
printf 'Downloading AgentBridge release package...\n'
curl -fsSL "$BASE_URL/$ASSET_NAME" -o "$ARCHIVE"
curl -fsSL "$BASE_URL/$CHECKSUM_NAME" -o "$CHECKSUM"

EXPECTED="$(awk 'NF {print tolower($1); exit}' "$CHECKSUM")"
printf '%s' "$EXPECTED" | grep -Eq '^[0-9a-fA-F]{64}$' || die "invalid SHA-256 checksum file"
ACTUAL="$(sha256_of "$ARCHIVE" | tr '[:upper:]' '[:lower:]')"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ASSET_NAME"
printf 'Checksum verified.\n'

tar -xzf "$ARCHIVE" -C "$STAGE"
PAYLOAD="$STAGE/package"
[ -f "$PAYLOAD/package.json" ] || die "release package is missing package.json"
[ -x "$PAYLOAD/dist/cli.js" ] || die "release package is missing executable dist/cli.js"
[ -f "$PAYLOAD/dist/daemon.js" ] || die "release package is missing dist/daemon.js"
[ -f "$PAYLOAD/plugins/agentbridge/server/bridge-server.js" ] || die "release package is missing the Claude plugin bundle"

PACKAGE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9A-Za-z.-]*\)".*/\1/p' "$PAYLOAD/package.json" | head -n 1)"
[ -n "$PACKAGE_VERSION" ] || die "could not determine package version"
if [ -n "$VERSION" ] && [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  die "requested version $VERSION but package contains $PACKAGE_VERSION"
fi

VERSION_DIR="$INSTALL_ROOT/versions/$PACKAGE_VERSION"
mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
STAGED_VERSION="$INSTALL_ROOT/versions/.staging-$PACKAGE_VERSION-$$"
rm -rf "$STAGED_VERSION"
mv "$PAYLOAD" "$STAGED_VERSION"
PREVIOUS_VERSION="$INSTALL_ROOT/versions/.previous-$PACKAGE_VERSION-$$"
if [ -e "$VERSION_DIR" ] || [ -L "$VERSION_DIR" ]; then
  rm -rf "$PREVIOUS_VERSION"
  mv "$VERSION_DIR" "$PREVIOUS_VERSION"
fi
if ! mv "$STAGED_VERSION" "$VERSION_DIR"; then
  if [ -e "$PREVIOUS_VERSION" ] || [ -L "$PREVIOUS_VERSION" ]; then
    mv "$PREVIOUS_VERSION" "$VERSION_DIR"
  fi
  die "could not activate version $PACKAGE_VERSION"
fi
rm -rf "$PREVIOUS_VERSION"

for name in agentbridge abg; do
  link="$BIN_DIR/$name"
  temporary_link="$BIN_DIR/.$name.$$"
  rm -f "$temporary_link"
  ln -s "$VERSION_DIR/dist/cli.js" "$temporary_link"
  mv -f "$temporary_link" "$link"
done

printf 'Installed AgentBridge %s under %s.\n' "$PACKAGE_VERSION" "$VERSION_DIR"
check_external_agents
register_plugin "$VERSION_DIR"

if "$BIN_DIR/abg" doctor >/dev/null 2>&1; then
  printf 'AgentBridge doctor completed.\n'
else
  warn 'AgentBridge doctor reported an incomplete environment; run: abg doctor'
fi

printf '\nNext steps:\n'
printf '  cd /path/to/your/project\n'
printf '  abg init\n'
printf '  abg claude\n'
printf '  # in another terminal: abg codex\n'

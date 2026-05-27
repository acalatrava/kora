#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/korabot/korabot"
INSTALL_DIR="${KORA_INSTALL_DIR:-$HOME/.local/bin}"
KORA_HOME="${KORA_HOME:-$HOME/.kora}"
VERSION="${KORA_VERSION:-latest}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

banner() {
  echo -e "${CYAN}"
  echo '    _       _ _       ____        _   '
  echo '   / \   __| (_) __ _| __ )  ___ | |_ '
  echo '  / _ \ / _` | |/ _` |  _ \ / _ \| __|'
  echo ' / ___ \ (_| | | (_| | |_) | (_) | |_ '
  echo '/_/   \_\__,_|_|\__,_|____/ \___/ \__|'
  echo -e "${NC}"
  echo "  Local-first multi-channel AI Agent runtime"
  echo ""
}

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

check_deps() {
  command -v node >/dev/null 2>&1 || error "Node.js is required. Install it from https://nodejs.org (v20+)"
  
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 20 ]; then
    error "Node.js v20+ required (found v$NODE_VERSION)"
  fi
  info "Node.js $(node -v) detected"

  command -v npm >/dev/null 2>&1 || error "npm is required"
  info "npm $(npm -v) detected"

}

install_korabot() {
  info "Installing Kora..."

  mkdir -p "$INSTALL_DIR"

  if [ "$VERSION" = "latest" ]; then
    npm install -g korabot@latest 2>/dev/null || {
      info "npm global install not available, installing from source..."
      TMPDIR=$(mktemp -d)
      git clone --depth 1 "$REPO" "$TMPDIR/korabot" 2>/dev/null || {
        warn "Could not clone from GitHub. Installing from local source..."
        cd "$(dirname "$0")/.."
        npm install
        npm run build
        npm link
        info "Installed from local source"
        return
      }
      cd "$TMPDIR/korabot"
      npm install
      npm run build
      npm link
      rm -rf "$TMPDIR"
    }
  else
    npm install -g "korabot@$VERSION"
  fi

  info "Kora installed successfully"
}

run_setup() {
  echo ""
  info "Running setup wizard..."
  echo ""
  kora setup
}

main() {
  banner
  check_deps
  install_korabot

  echo ""
  info "Installation complete!"
  echo ""

  read -p "  Run setup wizard now? [Y/n] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    run_setup
  else
    echo ""
    info "Run 'kora setup' when you're ready to configure."
    info "Run 'kora doctor' to check your environment."
  fi
}

main "$@"

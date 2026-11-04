#!/usr/bin/env bash
# Installs Scouter, a read-only terminal file viewer, so that `scouter .` works in any folder.
#
#   curl -fsSL https://raw.githubusercontent.com/indrazm/scouter/main/install.sh | bash
#   ./install.sh              # from a checkout: use that checkout instead of downloading one
#   ./install.sh --uninstall
#
# Scouter runs on Bun (https://bun.sh), which must already be installed. Nothing is written outside the two
# folders below, and nothing is added to your shell configuration.
set -euo pipefail

REPO_URL="${SCOUTER_REPO:-https://github.com/indrazm/scouter.git}"
# A release tag (v0.1.0) or a branch. Unset means: the newest release tag, or `main` before the first release.
REF="${SCOUTER_REF:-}"
INSTALL_DIR="${SCOUTER_HOME:-$HOME/.scouter}"
BIN_DIR="${SCOUTER_BIN_DIR:-$HOME/.local/bin}"
MIN_BUN="1.4.4"

# Marks a folder this installer cloned, so --uninstall and updates never touch anything else.
CLONE_MARKER=".scouter-installer"
# Marks a launcher this installer wrote, so a different program called `scouter` is never overwritten.
LAUNCHER_MARKER="# scouter-launcher"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'scouter installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install Scouter so `scouter .` works anywhere.

Usage: install.sh [--uninstall | --help]

Once installed, update with `scouter --upgrade`, which runs this script again.

Environment:
  SCOUTER_REF       release tag or branch to install (default: newest release tag, else main)
  SCOUTER_HOME      where to keep the program          (default: ~/.scouter)
  SCOUTER_BIN_DIR   where to put the `scouter` command (default: ~/.local/bin)
  SCOUTER_REPO      git URL to install from            (default: https://github.com/indrazm/scouter.git)

Run from a checkout of the repository, it installs that checkout in place instead of downloading a copy.
Run it again to update.
EOF
}

version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

require_bun() {
  command -v bun >/dev/null 2>&1 || fail "Bun is required but was not found. Install it from https://bun.sh and run this again."
  local found
  found="$(bun --version)"
  version_at_least "$found" "$MIN_BUN" || fail "Bun $MIN_BUN or newer is required (found $found). Run: bun upgrade"
}

# The folder this script lives in, when that is a checkout of your own. Empty when piped from curl, and empty
# inside the copy this installer manages (an upgrade runs from there, and must fetch rather than reinstall in place).
checkout_dir() {
  local script="${BASH_SOURCE[0]:-}"
  [ -n "$script" ] && [ -f "$script" ] || return 0
  local here
  here="$(cd "$(dirname "$script")" && pwd -P)"
  [ ! -f "$here/$CLONE_MARKER" ] || return 0
  if [ -f "$here/src/index.ts" ] && grep -q '"name": "scouter"' "$here/package.json" 2>/dev/null; then
    printf '%s' "$here"
  fi
}

latest_release_tag() {
  git ls-remote --tags --refs "$REPO_URL" 'v[0-9]*' 2>/dev/null |
    sed 's#.*refs/tags/##' | sort -V | tail -n 1
}

# Downloads or updates the managed copy at $INSTALL_DIR and prints nothing; sets $app_dir.
fetch_copy() {
  command -v git >/dev/null 2>&1 || fail "git is required to download Scouter."
  # An upgrade follows wherever the existing copy came from, unless told otherwise.
  if [ -f "$INSTALL_DIR/$CLONE_MARKER" ] && [ -z "${SCOUTER_REPO:-}" ]; then
    REPO_URL="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || printf '%s' "$REPO_URL")"
  fi
  local ref="$REF"
  if [ -z "$ref" ]; then
    ref="$(latest_release_tag)"
    if [ -z "$ref" ]; then
      ref="main"
      say "No release found yet; installing the main branch."
    fi
  fi
  if [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/$CLONE_MARKER" ]; then
    [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] ||
      fail "$INSTALL_DIR already exists and was not created by this installer. Set SCOUTER_HOME to another folder."
  fi
  # A first install and an update take the same path: fetch the one wanted commit, then move to it. (A shallow
  # `git clone --branch` of an annotated tag prints a spurious "is not a commit!" warning with some git versions.)
  if [ -f "$INSTALL_DIR/$CLONE_MARKER" ]; then
    say "Updating Scouter ($ref)…"
  else
    say "Downloading Scouter ($ref)…"
    git init --quiet --initial-branch=main "$INSTALL_DIR" || fail "Could not create $INSTALL_DIR."
    git -C "$INSTALL_DIR" remote add origin "$REPO_URL"
    # Marked before the download, so a failed first attempt is simply resumed by running the installer again.
    : >"$INSTALL_DIR/$CLONE_MARKER"
  fi
  git -C "$INSTALL_DIR" -c advice.detachedHead=false fetch --quiet --depth 1 origin "$ref" ||
    fail "Could not download '$ref' from $REPO_URL."
  git -C "$INSTALL_DIR" reset --hard --quiet FETCH_HEAD
  app_dir="$INSTALL_DIR"
}

install_dependencies() {
  say "Installing dependencies…"
  local output
  # Frozen lockfile, and no install scripts: dependencies are not trusted to run code on this machine.
  output="$(cd "$app_dir" && bun install --frozen-lockfile --ignore-scripts 2>&1)" || {
    printf '%s\n' "$output" >&2
    fail "Installing dependencies failed."
  }
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  local launcher="$BIN_DIR/scouter"
  if [ -e "$launcher" ] && ! grep -q "^$LAUNCHER_MARKER" "$launcher" 2>/dev/null; then
    fail "$launcher already exists and is not Scouter's. Remove it, or set SCOUTER_BIN_DIR to another folder."
  fi
  # --config and --no-env-file matter: Bun reads bunfig.toml (including `preload` scripts) and .env from the
  # current folder, and the folder being viewed must never be able to run code or change settings.
  # Paths are shell-escaped, so a folder name with spaces or quotes cannot break the launcher.
  local app_q bin_q
  app_q="$(printf '%q' "$app_dir")"
  bin_q="$(printf '%q' "$BIN_DIR")"
  cat >"$launcher" <<EOF
#!/usr/bin/env bash
$LAUNCHER_MARKER (written by install.sh; update with: scouter --upgrade)
if [ "\${1:-}" = "--upgrade" ]; then
  if [ -f $app_q/$CLONE_MARKER ]; then
    # exec: this launcher is rewritten during the upgrade, so it must not still be running.
    exec env SCOUTER_HOME=$app_q SCOUTER_BIN_DIR=$bin_q bash $app_q/install.sh
  fi
  echo "scouter: this install runs from a checkout ($app_dir); update it there with: git pull" >&2
  exit 1
fi
BUN="\$(command -v bun || true)"
if [ -z "\$BUN" ] && [ -x "\$HOME/.bun/bin/bun" ]; then BUN="\$HOME/.bun/bin/bun"; fi
if [ -z "\$BUN" ]; then
  echo "scouter: Bun is required but was not found. Install it from https://bun.sh" >&2
  exit 1
fi
exec "\$BUN" --config=/dev/null --no-env-file $app_q/src/index.ts "\$@"
EOF
  chmod +x "$launcher"
}

hint_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac
  say ""
  say "$BIN_DIR is not on your PATH. Add it by putting this line in your shell's startup file"
  say "(~/.zshrc, ~/.bashrc, ...), then open a new terminal:"
  say ""
  say "  export PATH=\"$BIN_DIR:\$PATH\""
}

install() {
  require_bun
  local before=""
  [ -x "$BIN_DIR/scouter" ] && before="$("$BIN_DIR/scouter" --version 2>/dev/null || true)"
  local checkout
  checkout="$(checkout_dir)"
  if [ -n "$checkout" ]; then
    app_dir="$checkout"
    say "Installing from this checkout: $app_dir"
  else
    fetch_copy
  fi
  install_dependencies
  write_launcher
  local installed
  installed="$("$BIN_DIR/scouter" --version)" || fail "The installed command did not start."
  say ""
  if [ -z "$before" ]; then
    say "Installed $installed to $BIN_DIR/scouter"
  elif [ "$before" = "$installed" ]; then
    say "Already up to date: $installed"
  else
    say "Upgraded: ${before#scouter } → ${installed#scouter }"
  fi
  hint_path
  say ""
  say "Open any folder and run: scouter ."
}

uninstall() {
  local launcher="$BIN_DIR/scouter"
  if [ -e "$launcher" ]; then
    if grep -q "^$LAUNCHER_MARKER" "$launcher" 2>/dev/null; then
      rm -f "$launcher"
      say "Removed $launcher"
    else
      say "Left $launcher alone: it is not Scouter's."
    fi
  fi
  if [ -f "$INSTALL_DIR/$CLONE_MARKER" ]; then
    rm -rf "$INSTALL_DIR"
    say "Removed $INSTALL_DIR"
  fi
  say "Uninstalled. A checkout you installed from with ./install.sh is never deleted."
}

main() {
  case "${1:-}" in
    "") install ;;
    --uninstall) uninstall ;;
    -h | --help) usage ;;
    *)
      printf 'scouter installer: unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

# Run and exit on one line: a truncated download (curl | bash) never runs half a script, and an upgrade that
# replaces this file while it runs never has bash carry on reading from the new contents.
main "$@"; exit $?

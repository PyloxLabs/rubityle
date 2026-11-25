#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Rubityle installer / manager  (game server daemon for Pyloxdactyl)
#
# Interactive menu:
#   sudo bash <(curl -fsSL https://raw.githubusercontent.com/PyloxLabs/rubityle/main/install.sh)
#
# Direct actions:
#   sudo bash install.sh --install
#   sudo bash install.sh --update
#   sudo bash install.sh --uninstall
#
# The panel is installed separately from its own repository.
#
# Animations are enabled automatically on UTF-8 terminals. Disable them with
# PYLOX_NO_ANIM=1 (or NO_COLOR=1).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -Eeuo pipefail

INSTALLER_URL="https://raw.githubusercontent.com/PyloxLabs/rubityle/main/install.sh"

PRIMARY=$'\033[38;5;160m'
ACCENT=$'\033[38;5;209m'
GREEN=$'\033[38;5;78m'
RED=$'\033[38;5;196m'
YELLOW=$'\033[38;5;214m'
ROSE=$'\033[38;5;211m'
WHITE=$'\033[38;5;231m'
GREY=$'\033[38;5;245m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
NC=$'\033[0m'

# Crimson -> red -> coral gradient (256-colour palette indexes)
GRADIENT=(88 124 160 196 197 203 209 203 197 196 160)

log() {
  if [[ "${1:-}" == "-e" ]]; then
    shift
    printf '%b\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}
info() { printf '%b[*]%b %s\n' "$PRIMARY" "$NC" "$*"; }
ok()   { printf '%b[✓]%b %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%b[!]%b %s\n' "$YELLOW" "$NC" "$*" >&2; }
die()  { printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Rubityle installer / manager

Usage: sudo bash <(curl -fsSL https://raw.githubusercontent.com/PyloxLabs/rubityle/main/install.sh) [options]
       sudo bash install.sh [options]

With no options, an interactive menu is shown (when stdin is a terminal).

Actions:
  --install             Fresh install (default for non-interactive use)
  --update              Update from GitHub if package.json version increased
  --uninstall           Remove Rubityle
  -h, --help            Show this help

Source options:
  --repo OWNER/REPO     GitHub repository (default: PyloxLabs/rubityle)
  --ref REF             Branch, tag, or commit (default: main; alias: --branch)
  --source-dir DIR      Use a local source tree instead of downloading

Install options:
  --port PORT           Daemon HTTP/WebSocket port (default: 8080)
  --sftp-port PORT      Built-in SFTP port (default: 2022)
  --panel-url URL       Panel URL written to .env (default: http://localhost:7956)
  --token TOKEN         Daemon token to use (default: randomly generated)
  --api-key KEY         Panel API key written to .env (default: empty)
  --install-dir DIR     Install directory (default: /opt/rubityle)
  --data-dir DIR        Game server data directory (default: /var/lib/rubityle)
  --log-dir DIR         Log directory (default: /var/log/rubityle)
  --service NAME        systemd service name (default: rubityle)
  --no-docker           Skip Docker installation/network setup
  --force               Allow installing into a non-empty install directory
                        (an existing .env is kept); with --update, re-apply
                        the update even if the version did not increase
  -y, --yes             Do not ask confirmation prompts

Environment equivalents: REPO, REF, SOURCE_DIR, DAEMON_PORT, SFTP_PORT,
PANEL_URL, DAEMON_TOKEN, PANEL_API_KEY, INSTALL_DIR, DATA_DIR, LOG_DIR and
SERVICE_NAME are also accepted. Set PYLOX_NO_ANIM=1 to disable animations.
EOF
}

REPO_SLUG="${REPO_SLUG:-${REPO:-PyloxLabs/rubityle}}"
REF="${REF:-main}"
SOURCE_DIR="${SOURCE_DIR:-}"

INSTALL_DIR="${INSTALL_DIR:-/opt/rubityle}"
DATA_DIR="${DATA_DIR:-/var/lib/rubityle}"
LOG_DIR="${LOG_DIR:-/var/log/rubityle}"
SERVICE_NAME="${SERVICE_NAME:-rubityle}"
DAEMON_PORT="${DAEMON_PORT:-8080}"
SFTP_PORT="${SFTP_PORT:-2022}"
PANEL_URL="${PANEL_URL:-http://localhost:7956}"
PANEL_API_KEY="${PANEL_API_KEY:-}"
DAEMON_TOKEN="${DAEMON_TOKEN:-}"
DOCKER_NETWORK="${DOCKER_NETWORK:-pylox-servers}"
SERVER_UID="${SERVER_UID:-1001}"
SERVER_GID="${SERVER_GID:-1001}"
CLI_PATH="/usr/local/bin/rubityle"
BACKUP_ROOT="/var/backups/rubityle"
FORCE=0
NO_DOCKER=0
ACTION=""
HAD_ARGS=$(( $# > 0 ? 1 : 0 ))
ASSUME_YES=0
PKG_UPDATED=0
TMP_DIR=""
SRC_DIR=""
SOURCE_LABEL=""
LAST_BACKUP_DIR=""
UI_ANIM=0

cleanup() {
  if [[ -t 1 ]]; then
    printf '\033[?25h'
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rubityle-install.XXXXXX")" || die "Could not create a temporary directory."
trap cleanup EXIT
trap 'exit 130' INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)          ACTION="install" ;;
    --update)           ACTION="update" ;;
    --uninstall)        ACTION="uninstall" ;;
    --repo)             REPO_SLUG="${2:-}"; shift ;;
    --repo=*)           REPO_SLUG="${1#*=}" ;;
    --ref)              REF="${2:-}"; shift ;;
    --ref=*)            REF="${1#*=}" ;;
    --branch)           REF="${2:-}"; shift ;;
    --branch=*)         REF="${1#*=}" ;;
    --source-dir)       SOURCE_DIR="${2:-}"; shift ;;
    --source-dir=*)     SOURCE_DIR="${1#*=}" ;;
    --port)             DAEMON_PORT="${2:-}"; shift ;;
    --port=*)           DAEMON_PORT="${1#*=}" ;;
    --sftp-port)        SFTP_PORT="${2:-}"; shift ;;
    --sftp-port=*)      SFTP_PORT="${1#*=}" ;;
    --panel-url)        PANEL_URL="${2:-}"; shift ;;
    --panel-url=*)      PANEL_URL="${1#*=}" ;;
    --token)            DAEMON_TOKEN="${2:-}"; shift ;;
    --token=*)          DAEMON_TOKEN="${1#*=}" ;;
    --api-key)          PANEL_API_KEY="${2:-}"; shift ;;
    --api-key=*)        PANEL_API_KEY="${1#*=}" ;;
    --install-dir)      INSTALL_DIR="${2:-}"; shift ;;
    --install-dir=*)    INSTALL_DIR="${1#*=}" ;;
    --data-dir)         DATA_DIR="${2:-}"; shift ;;
    --data-dir=*)       DATA_DIR="${1#*=}" ;;
    --log-dir)          LOG_DIR="${2:-}"; shift ;;
    --log-dir=*)        LOG_DIR="${1#*=}" ;;
    --service)          SERVICE_NAME="${2:-}"; shift ;;
    --service=*)        SERVICE_NAME="${1#*=}" ;;
    --no-docker)        NO_DOCKER=1 ;;
    --force)            FORCE=1 ;;
    -y|--yes)           ASSUME_YES=1 ;;
    -h|--help)          usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
  shift
done

# Directories we will create, overwrite or delete must never be a system path.
assert_safe_dir() {
  local label="$1" dir="$2" trimmed
  [[ "$dir" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "$label must be an absolute path (letters, numbers, . _ - /): $dir"
  [[ "$dir" != *..* ]] || die "$label must not contain '..': $dir"
  trimmed="${dir%/}"
  case "$trimmed" in
    ""|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/usr/bin|/usr/lib|/var|/var/lib|/var/log|/var/backups|/var/www)
      die "$label points at a system directory ($dir); choose a dedicated directory." ;;
  esac
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

validate_settings() {
  [[ "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be OWNER/REPO."
  [[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || die "--ref contains unsupported characters."
  valid_port "$DAEMON_PORT" || die "--port must be a number between 1 and 65535."
  valid_port "$SFTP_PORT" || die "--sftp-port must be a number between 1 and 65535."
  [[ "$DAEMON_PORT" != "$SFTP_PORT" ]] || die "--port and --sftp-port must be different."
  local url_re='^https?://[A-Za-z0-9._:/@%?=~+-]+$'
  [[ "$PANEL_URL" =~ $url_re ]] || die "--panel-url must be an http(s) URL (letters, numbers and . _ : / @ % ? = ~ + - only)."
  [[ -z "$DAEMON_TOKEN" || "$DAEMON_TOKEN" =~ ^[A-Za-z0-9._-]{16,}$ ]] || die "--token must be 16+ characters of letters, numbers, . _ -"
  [[ -z "$PANEL_API_KEY" || "$PANEL_API_KEY" =~ ^[A-Za-z0-9._-]+$ ]] || die "--api-key contains unsupported characters."
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--service contains unsupported characters."
  assert_safe_dir "--install-dir" "$INSTALL_DIR"
  assert_safe_dir "--data-dir" "$DATA_DIR"
  assert_safe_dir "--log-dir" "$LOG_DIR"
}

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only."
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash <(curl -fsSL ${INSTALLER_URL})"

validate_settings

if [[ "$HAD_ARGS" -eq 1 && -n "$ACTION" ]]; then
  ASSUME_YES=1
fi
if [[ "$HAD_ARGS" -eq 0 && ! -t 0 ]]; then
  ACTION="install"
  ASSUME_YES=1
fi

PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG_MANAGER="yum"
elif command -v apk >/dev/null 2>&1; then
  PKG_MANAGER="apk"
else
  die "No supported package manager found (apt/dnf/yum/apk)."
fi

pkg_update_once() {
  if [[ $PKG_UPDATED -eq 1 ]]; then
    return
  fi
  case "$PKG_MANAGER" in
    apt) apt-get update -qq ;;
    dnf|yum) "$PKG_MANAGER" -y makecache >/dev/null ;;
    apk) apk update >/dev/null ;;
  esac
  PKG_UPDATED=1
}

pkg_install() {
  case "$PKG_MANAGER" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf|yum) "$PKG_MANAGER" -y install "$@" ;;
    apk) apk add --no-cache "$@" ;;
  esac
}

have_systemd() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}

start_service() {
  local name="$1"
  if have_systemd; then
    systemctl enable "$name" >/dev/null 2>&1 || true
    systemctl start "$name"
  elif command -v service >/dev/null 2>&1; then
    service "$name" start
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$name" start
  else
    warn "Could not start $name automatically; no supported init system found."
  fi
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# ── UI: terminal detection ───────────────────────────────────────────────────
# Animations need a real terminal and a UTF-8 locale (the banner is sliced
# character by character). Otherwise everything falls back to static output.
setup_ui() {
  UI_ANIM=0
  if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" \
        && "${PYLOX_NO_ANIM:-0}" != "1" && "${RUBITYLE_NO_ANIM:-0}" != "1" ]]; then
    local cm
    cm="$(locale charmap 2>/dev/null || true)"
    if [[ "${cm^^}" != "UTF-8" ]] && locale -a 2>/dev/null | grep -qiE '^c\.utf-?8$'; then
      export LC_ALL=C.UTF-8
      cm="$(locale charmap 2>/dev/null || true)"
    fi
    if [[ "${cm^^}" == "UTF-8" ]]; then
      UI_ANIM=1
    fi
  fi
  return 0
}
setup_ui

term_cols() {
  local sz cols=""
  sz="$(stty size 2>/dev/null || true)"
  cols="${sz##* }"
  if ! [[ "$cols" =~ ^[0-9]+$ ]] || (( cols < 20 )); then
    cols="$(tput cols 2>/dev/null || true)"
  fi
  if ! [[ "$cols" =~ ^[0-9]+$ ]] || (( cols < 20 )); then
    cols="${COLUMNS:-80}"
  fi
  printf '%s' "$cols"
}

hide_cursor() {
  if [[ $UI_ANIM -eq 1 ]]; then printf '\033[?25l'; fi
  return 0
}

show_cursor() {
  if [[ $UI_ANIM -eq 1 ]]; then printf '\033[?25h'; fi
  return 0
}

clear_screen() {
  if [[ -t 1 ]]; then printf '\033[2J\033[H'; fi
  return 0
}

type_line() {
  local color="$1"
  local text="$2"
  local i
  for (( i = 0; i < ${#text}; i++ )); do
    printf '%b%s%b' "$color" "${text:$i:1}" "$NC"
    sleep 0.006
  done
  printf '\n'
}

gradient_rule() {
  local w="${1:-72}" i n=${#GRADIENT[@]} out=""
  for (( i = 0; i < w; i++ )); do
    out+=$'\033[38;5;'"${GRADIENT[$(( i * n / w ))]}"$'m━'
  done
  printf '%s%s\n' "$out" "$NC"
}

# ── UI: banner (gradient + shimmer) ──────────────────────────────────────────
BIG_W=62
COMPACT_W=21
BIG_BANNER=(
  '██████╗ ██╗   ██╗██████╗ ██╗████████╗██╗   ██╗██╗     ███████╗'
  '██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝╚██╗ ██╔╝██║     ██╔════╝'
  '██████╔╝██║   ██║██████╔╝██║   ██║    ╚████╔╝ ██║     █████╗  '
  '██╔══██╗██║   ██║██╔══██╗██║   ██║     ╚██╔╝  ██║     ██╔══╝  '
  '██║  ██║╚██████╔╝██████╔╝██║   ██║      ██║   ███████╗███████╗'
  '╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚══════╝'
)
COMPACT_BANNER='◆  R U B I T Y L E  ◆'

BANNER_ROWS=()
BASE_COLOR=()
BANNER_W=0
BANNER_TOP=2
BANNER_COL=4
BANNER_SEEN=0
TAG_ROW=0
INFO_ROW=0
END_ROW=0
MENU_TOP=0

# Picks the big or compact banner for the current terminal width and
# precomputes the per-column gradient colours and the screen layout rows.
init_banner() {
  local cols w n c rule
  cols="$(term_cols)"
  if (( cols >= BIG_W + BANNER_COL + 2 )); then
    BANNER_ROWS=("${BIG_BANNER[@]}")
    w=$BIG_W
  else
    BANNER_ROWS=("$COMPACT_BANNER")
    w=$COMPACT_W
  fi
  BANNER_W=$w
  rule="$(printf '%*s' "$w" '')"
  BANNER_ROWS+=("${rule// /━}")

  n=${#GRADIENT[@]}
  BASE_COLOR=()
  for (( c = 0; c < w; c++ )); do
    BASE_COLOR[c]="${GRADIENT[$(( c * n / w ))]}"
  done

  TAG_ROW=$(( BANNER_TOP + ${#BANNER_ROWS[@]} + 1 ))
  INFO_ROW=$(( TAG_ROW + 1 ))
  END_ROW=$(( INFO_ROW + 2 ))
  MENU_TOP=$END_ROW
}

# draw_banner_frame SHINE [REVEAL]
#   SHINE  column of the diagonal highlight (use -100 for "no highlight")
#   REVEAL only columns <= REVEAL are drawn (used by the intro wipe)
draw_banner_frame() {
  local shine="$1" reveal="${2:-9999}"
  local nrows=${#BANNER_ROWS[@]}
  local r c d attr color key last out line ch frame=""

  for (( r = 0; r < nrows; r++ )); do
    line="${BANNER_ROWS[$r]}"
    out=""
    last=""
    for (( c = 0; c < BANNER_W; c++ )); do
      ch="${line:c:1}"
      if [[ -z "$ch" || "$ch" == " " || $c -gt $reveal ]]; then
        out+=" "
        continue
      fi

      d=$(( c - shine + r * 2 ))
      d=${d#-}
      attr=""
      if (( d <= 1 )); then
        color=231
        attr=";1"
      elif (( d <= 3 )); then
        color=224
      elif (( d <= 5 )); then
        color=217
      else
        color="${BASE_COLOR[c]}"
        case "$ch" in
          ╗|╔|╝|╚|║|═) attr=";2" ;;
        esac
      fi

      key="${attr}:${color}"
      if [[ "$key" != "$last" ]]; then
        out+=$'\033[0'"${attr};38;5;${color}m"
        last="$key"
      fi
      out+="$ch"
    done
    frame+=$'\033['"$(( BANNER_TOP + r ));${BANNER_COL}H${out}"$'\033[0m'
  done
  printf '%s' "$frame"
}

print_tagline() {
  local typed="${1:-0}"
  local text="▸ Game server daemon for Pyloxdactyl"
  local len=${#text} n=${#GRADIENT[@]} i

  printf '\033[%d;%dH' "$TAG_ROW" "$BANNER_COL"
  for (( i = 0; i < len; i++ )); do
    printf '\033[38;5;%dm%s' "${GRADIENT[$(( i * n / len ))]}" "${text:i:1}"
    if [[ $typed -eq 1 ]]; then sleep 0.012; fi
  done
  printf '%b' "$NC"
  printf '\033[%d;%dH%b%s%b' "$INFO_ROW" "$BANNER_COL" "${DIM}${GREY}" \
    "github.com/${REPO_SLUG}  ·  Docker  ·  systemd  ·  SFTP" "$NC"
}

banner() {
  local first=0 c row
  if [[ $BANNER_SEEN -eq 0 ]]; then first=1; fi
  BANNER_SEEN=1

  clear_screen
  init_banner

  if [[ $UI_ANIM -eq 1 ]]; then
    hide_cursor
    if [[ $first -eq 1 ]]; then
      # Intro: a bright edge wipes the logo in from the left
      for (( c = -2; c <= BANNER_W + 4; c += 3 )); do
        draw_banner_frame "$c" "$c"
        sleep 0.012
      done
      draw_banner_frame -100
      print_tagline 1
    else
      draw_banner_frame -100
      print_tagline 0
    fi
    printf '\033[%d;1H' "$END_ROW"
    show_cursor
  else
    printf '\n'
    for row in "${BANNER_ROWS[@]}"; do
      printf '   %b%s%b\n' "$PRIMARY" "$row" "$NC"
    done
    printf '\n'
    type_line "$ACCENT" "   Game server daemon for Pyloxdactyl"
    printf '\n'
  fi
}

# ── UI: steps, spinner, prompts ──────────────────────────────────────────────
step() {
  local text="$1" n m title bar="" i filled gn=${#GRADIENT[@]} width=20
  if [[ "$text" =~ ^([0-9]+)/([0-9]+)[[:space:]]+(.*)$ ]]; then
    n="${BASH_REMATCH[1]}"
    m="${BASH_REMATCH[2]}"
    title="${BASH_REMATCH[3]}"
    filled=$(( n * width / m ))
    for (( i = 0; i < width; i++ )); do
      if (( i < filled )); then
        bar+=$'\033[38;5;'"${GRADIENT[$(( i * gn / width ))]}"$'m█'
      else
        bar+="${DIM}${GREY}░"
      fi
    done
    bar+="$NC"
    printf '\n%b━━%b %b%s%b\n   %s %b%s/%s%b\n' \
      "$PRIMARY" "$NC" "$BOLD" "$title" "$NC" "$bar" "${DIM}${GREY}" "$n" "$m" "$NC"
  else
    printf '\n%b━━ %s%b\n' "$PRIMARY" "$text" "$NC"
  fi
}

run_with_spinner() {
  local label="$1"
  shift
  local log="$TMP_DIR/spinner.log"
  local pid status i=0 start=$SECONDS color n=${#GRADIENT[@]}
  local -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  : > "$log"

  hide_cursor
  "$@" > "$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    color="${GRADIENT[$(( i % n ))]}"
    printf '\r  \033[38;5;%dm%s%b %b%-56s%b %b%3ds%b' \
      "$color" "${frames[$(( i % ${#frames[@]} ))]}" "$NC" \
      "$ACCENT" "$label" "$NC" "${DIM}${GREY}" "$(( SECONDS - start ))" "$NC"
    i=$(( i + 1 ))
    sleep 0.08
  done

  if wait "$pid"; then status=0; else status=$?; fi
  printf '\r\033[2K'
  show_cursor

  if [[ $status -eq 0 ]]; then
    printf '  %b✓%b %s %b(%ds)%b\n' "$GREEN" "$NC" "$label" "${DIM}${GREY}" "$(( SECONDS - start ))" "$NC"
  else
    printf '  %b✗%b %s\n' "$RED" "$NC" "$label"
    cat "$log" >&2
    return "$status"
  fi
}

press_enter() {
  if [[ -t 0 ]]; then
    printf '\n%bPress Enter to return to the menu...%b' "$ACCENT" "$NC"
    read -r _ || true
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local answer=""

  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then
    [[ "$default" == "y" ]]
    return
  fi

  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " answer
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
  else
    read -r -p "$prompt [y/N]: " answer
    [[ "$answer" =~ ^[Yy] ]]
  fi
}

# ── Generic helpers ─────────────────────────────────────────────────────────
ensure_base_packages() {
  pkg_update_once
  case "$PKG_MANAGER" in
    apt)   pkg_install curl ca-certificates openssl tar gnupg ;;
    dnf|yum) pkg_install curl ca-certificates openssl tar shadow-utils ;;
    apk)   pkg_install curl ca-certificates openssl tar shadow ;;
  esac
}

ensure_node() {
  ensure_base_packages
  if command -v node >/dev/null 2>&1 && (( $(node_major) >= 18 )); then
    ok "Node.js found: $(node --version)"
  else
    warn "Node.js 18+ not found; installing Node.js 20 LTS"
    case "$PKG_MANAGER" in
      apt)
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        pkg_install nodejs
        ;;
      dnf|yum)
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        pkg_install nodejs
        ;;
      apk)
        pkg_install nodejs npm
        ;;
    esac
    command -v node >/dev/null 2>&1 || die "Node.js installation failed."
    (( $(node_major) >= 18 )) || die "Node.js 18+ is still not available (found $(node --version))."
    ok "Node.js installed: $(node --version)"
  fi

  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found; installing it"
    pkg_install npm
    command -v npm >/dev/null 2>&1 || die "npm installation failed."
  fi
}

ensure_docker() {
  if [[ $NO_DOCKER -eq 1 ]]; then
    warn "Docker setup skipped (--no-docker). Rubityle cannot run game servers without Docker."
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker not found; installing Docker Engine"
    if [[ "$PKG_MANAGER" == "apk" ]]; then
      pkg_install docker
      rc-update add docker default >/dev/null 2>&1 || true
    else
      curl -fsSL https://get.docker.com | sh
    fi
    start_service docker
    ok "Docker installed: $(docker --version)"
  else
    ok "Docker found: $(docker --version)"
  fi

  # The daemon talks to Docker through the socket, so make sure Docker is up.
  if ! docker info >/dev/null 2>&1; then
    start_service docker 2>/dev/null || true
    sleep 2
  fi

  if docker info >/dev/null 2>&1; then
    if ! docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
      docker network create "$DOCKER_NETWORK" >/dev/null
      ok "Created Docker network: $DOCKER_NETWORK"
    else
      ok "Docker network $DOCKER_NETWORK already exists"
    fi
  else
    warn "Docker daemon is not reachable; create the $DOCKER_NETWORK network later."
  fi
}

prepare_source() {
  if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$(cd "$SOURCE_DIR" 2>/dev/null && pwd)" || die "--source-dir is not a valid directory."
    [[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/daemon.js" ]] || die "--source-dir does not look like a Rubityle source tree."
    SRC_DIR="$SOURCE_DIR"
    SOURCE_LABEL="local: $SRC_DIR"
    ok "Using local source: $SRC_DIR"
    return
  fi

  SRC_DIR="$TMP_DIR/source"
  mkdir -p "$SRC_DIR"
  local archive="$TMP_DIR/source.tar.gz"
  local url="https://api.github.com/repos/${REPO_SLUG}/tarball/${REF}"
  SOURCE_LABEL="GitHub: ${REPO_SLUG}@${REF}"

  run_with_spinner "Downloading ${REPO_SLUG} (${REF})" \
    curl -fsSL "$url" -o "$archive" || die "Failed to download $url"
  run_with_spinner "Extracting Rubityle source" \
    tar -xzf "$archive" -C "$SRC_DIR" --strip-components=1 || die "Failed to extract the source archive"

  [[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/daemon.js" ]] || die "Downloaded source does not look like Rubityle."
}

read_version() {
  local file="$1"
  local version=""

  if command -v node >/dev/null 2>&1; then
    version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version || ""))' "$file" 2>/dev/null || true)"
  fi
  if [[ -z "$version" ]]; then
    version="$(grep -m1 -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" 2>/dev/null | cut -d'"' -f4 || true)"
  fi
  printf '%s' "${version#v}"
}

semver_gt() {
  local a="${1#v}" b="${2#v}"
  a="${a%%-*}"
  b="${b%%-*}"
  local IFS=.
  local -a av=($a) bv=($b)
  local i x y

  for i in 0 1 2; do
    x="${av[$i]:-0}"
    y="${bv[$i]:-0}"
    x="${x//[!0-9]/}"
    y="${y//[!0-9]/}"
    x="${x:-0}"
    y="${y:-0}"
    if (( 10#$x > 10#$y )); then return 0; fi
    if (( 10#$x < 10#$y )); then return 1; fi
  done
  return 1
}

env_value() {
  local key="$1"
  local file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

load_metadata() {
  local meta="$INSTALL_DIR/.rubityle-install"
  if [[ -f "$meta" ]]; then
    # shellcheck disable=SC1090
    source "$meta"
    # Values come from a file on disk: re-validate before using them.
    [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Invalid service name in $meta."
    assert_safe_dir "Install directory (metadata)" "$INSTALL_DIR"
    assert_safe_dir "Data directory (metadata)" "$DATA_DIR"
    assert_safe_dir "Log directory (metadata)" "$LOG_DIR"
  fi
}

write_metadata() {
  {
    printf 'SERVICE_NAME=%q\n' "$SERVICE_NAME"
    printf 'INSTALL_DIR=%q\n' "$INSTALL_DIR"
    printf 'DATA_DIR=%q\n' "$DATA_DIR"
    printf 'LOG_DIR=%q\n' "$LOG_DIR"
    printf 'DAEMON_PORT=%q\n' "$DAEMON_PORT"
  } > "$INSTALL_DIR/.rubityle-install"
}

# An existing .env is never regenerated: the daemon token is already registered
# in the panel, and replacing it would silently disconnect the node.
adopt_existing_env() {
  local env="$INSTALL_DIR/.env" v
  [[ -f "$env" ]] || return 0
  v="$(env_value DAEMON_PORT "$env")";  if [[ -n "$v" ]]; then DAEMON_PORT="$v"; fi
  v="$(env_value SFTP_PORT "$env")";    if [[ -n "$v" ]]; then SFTP_PORT="$v"; fi
  v="$(env_value DAEMON_TOKEN "$env")"; if [[ -n "$v" ]]; then DAEMON_TOKEN="$v"; fi
  v="$(env_value DATA_DIR "$env")";     if [[ -n "$v" ]]; then DATA_DIR="$v"; fi
  v="$(env_value LOG_DIR "$env")";      if [[ -n "$v" ]]; then LOG_DIR="$v"; fi
  valid_port "$DAEMON_PORT" || die "Existing .env has an invalid DAEMON_PORT."
  valid_port "$SFTP_PORT" || die "Existing .env has an invalid SFTP_PORT."
  assert_safe_dir "DATA_DIR (from .env)" "$DATA_DIR"
  assert_safe_dir "LOG_DIR (from .env)" "$LOG_DIR"
  ENV_ADOPTED=1
}
ENV_ADOPTED=0

write_systemd_unit() {
  have_systemd || return 0
  local node_path docker_deps=""
  node_path="$(command -v node)"
  if systemctl cat docker.service >/dev/null 2>&1; then
    docker_deps=$'After=docker.service\nRequires=docker.service'
  fi

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Rubityle Game Server Daemon
After=network-online.target
Wants=network-online.target
${docker_deps}

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${node_path} ${INSTALL_DIR}/daemon.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
}

# The `rubityle` control command (start/stop/restart/status/logs/token).
write_cli() {
  sed -e "s|__SERVICE__|${SERVICE_NAME}|g" -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" > "$CLI_PATH" <<'CLI_EOF'
#!/usr/bin/env bash
# Rubityle daemon control CLI (generated by the installer)
SERVICE="__SERVICE__"
INSTALL_DIR="__INSTALL_DIR__"
RUBY=$'\033[38;5;160m'
NC=$'\033[0m'

usage() {
  cat <<'EOF'
Usage: rubityle [command]

Commands:
  (none)    Start the daemon (if needed) and stream its logs.
            The daemon keeps running if you close this console.
  start     Start as a background service, enabled at boot (24/7)
  stop      Stop the background service
  restart   Restart the background service
  status    Show background service status
  logs      Tail the background service logs (Ctrl+C to exit)
  token     Print the daemon token (needed to add this node in the panel)
  help      Show this help message
EOF
}

cmd="${1:-}"
case "$cmd" in
  help|-h|--help) usage; exit 0 ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: this command must be run as root (sudo rubityle ${cmd})" >&2
  exit 1
fi

case "$cmd" in
  ""|run)
    version="$(node -p "require('${INSTALL_DIR}/package.json').version" 2>/dev/null || echo '?')"
    echo ""
    printf '%s\n' "$RUBY"
    cat <<'BANNER'
  ██████╗ ██╗   ██╗██████╗ ██╗████████╗██╗   ██╗██╗     ███████╗
  ██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝╚██╗ ██╔╝██║     ██╔════╝
  ██████╔╝██║   ██║██████╔╝██║   ██║    ╚████╔╝ ██║     █████╗
  ██╔══██╗██║   ██║██╔══██╗██║   ██║     ╚██╔╝  ██║     ██╔══╝
  ██║  ██║╚██████╔╝██████╔╝██║   ██║      ██║   ███████╗███████╗
  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚══════╝
BANNER
    printf '\n               Rubityle Daemon v%s | Game Server Daemon\n%s\n\n' "$version" "$NC"
    systemctl enable "$SERVICE" >/dev/null 2>&1
    systemctl start "$SERVICE"
    if ! systemctl is-active --quiet "$SERVICE"; then
      echo "Failed to start Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    echo " Daemon running in the background; attaching to its logs."
    echo " Closing this console keeps the daemon running. Detach with Ctrl+C."
    echo " Stop the daemon with: rubityle stop"
    echo ""
    exec journalctl -u "$SERVICE" -f
    ;;
  start)
    systemctl enable "$SERVICE" >/dev/null 2>&1
    systemctl start "$SERVICE"
    if systemctl is-active --quiet "$SERVICE"; then
      echo "Rubityle daemon started as a background service (enabled at boot)."
      echo "Follow logs with: rubityle logs"
    else
      echo "Failed to start Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    ;;
  stop)
    systemctl stop "$SERVICE"
    echo "Rubityle daemon stopped."
    ;;
  restart)
    systemctl restart "$SERVICE"
    if systemctl is-active --quiet "$SERVICE"; then
      echo "Rubityle daemon restarted."
    else
      echo "Failed to restart Rubityle daemon. Check: rubityle logs" >&2
      exit 1
    fi
    ;;
  status)
    systemctl status "$SERVICE"
    ;;
  logs)
    journalctl -u "$SERVICE" -f
    ;;
  token)
    grep -m1 '^DAEMON_TOKEN=' "${INSTALL_DIR}/.env" | cut -d= -f2-
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo ""
    usage
    exit 1
    ;;
esac
CLI_EOF
  chmod 755 "$CLI_PATH"
}

restart_daemon() {
  if have_systemd; then
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || {
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl restart "$SERVICE_NAME"
    }
    ok "Service ${SERVICE_NAME} restarted"
  else
    warn "systemd not detected; restart the daemon manually: cd $INSTALL_DIR && node daemon.js"
  fi
}

install_node_deps() {
  if [[ -f "$INSTALL_DIR/package-lock.json" ]]; then
    (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund)
  else
    (cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund)
  fi
}

daemon_port() {
  local port=""
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    port="$(env_value DAEMON_PORT "$INSTALL_DIR/.env")"
  fi
  printf '%s' "${port:-$DAEMON_PORT}"
}

# GET /health is unauthenticated and answers as soon as the HTTP server is up.
health_check() {
  local port="$1"
  local healthy=0
  local i

  for i in {1..20}; do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done

  if [[ $healthy -eq 1 ]]; then
    ok "Daemon is responding on port ${port}"
  else
    warn "Daemon did not respond on port ${port} yet. Check the service logs."
    if have_systemd; then
      log "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    fi
  fi
}

final_summary() {
  local title="$1" show_next="${2:-0}"
  log ""
  gradient_rule 72
  log -e "  ${BOLD}${GREEN}✔ ${title}${NC}"
  gradient_rule 72
  log ""
  log -e "  ${GREY}Daemon port   ${NC}${YELLOW}$(daemon_port)${NC}"
  log -e "  ${GREY}SFTP port     ${NC}${YELLOW}$(env_value SFTP_PORT "$INSTALL_DIR/.env")${NC}"
  log -e "  ${GREY}Source        ${NC}${YELLOW}${SOURCE_LABEL}${NC}"
  log -e "  ${GREY}Install dir   ${NC}${YELLOW}${INSTALL_DIR}${NC}"
  log -e "  ${GREY}Data dir      ${NC}${YELLOW}${DATA_DIR}${NC}"
  log -e "  ${GREY}Log dir       ${NC}${YELLOW}${LOG_DIR}${NC}"
  log -e "  ${GREY}Service       ${NC}${YELLOW}${SERVICE_NAME}${NC}"
  if [[ -n "$LAST_BACKUP_DIR" ]]; then
    log -e "  ${GREY}Backup        ${NC}${YELLOW}${LAST_BACKUP_DIR}${NC}"
  fi
  if [[ "$show_next" -eq 1 ]]; then
    log ""
    log -e "  ${ROSE}Add this node in the panel (Admin -> Nodes)${NC}"
    log -e "    ${GREY}Address${NC}  ${YELLOW}your-server-ip:$(daemon_port)${NC}"
    log -e "    ${GREY}Token${NC}    ${YELLOW}$(env_value DAEMON_TOKEN "$INSTALL_DIR/.env")${NC}"
    log ""
    log -e "  ${ROSE}Next steps${NC}"
    log -e "    ${PRIMARY}1.${NC} Open $(daemon_port)/tcp (panel -> daemon) and $(env_value SFTP_PORT "$INSTALL_DIR/.env")/tcp (SFTP) in your firewall,"
    log -e "       plus the allocation ports your game servers will use."
    log -e "    ${PRIMARY}2.${NC} Add allocations to the node, then create a server."
    log -e "    ${PRIMARY}3.${NC} Settings live in ${INSTALL_DIR}/.env; run 'sudo rubityle restart' after editing."
  fi
  log ""
  if have_systemd; then
    log -e "  ${ROSE}Commands${NC}"
    log -e "    sudo rubityle            ${DIM}${GREY}# start + stream logs (survives console close)${NC}"
    log -e "    sudo rubityle status | restart | logs | token"
    log ""
  fi
  gradient_rule 72
}

# ── 1. Install ───────────────────────────────────────────────────────────────
write_env() {
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    warn "Existing .env kept (daemon token and settings unchanged)"
    chmod 600 "$INSTALL_DIR/.env"
    return
  fi

  [[ -n "$DAEMON_TOKEN" ]] || DAEMON_TOKEN="$(openssl rand -hex 32)"

  umask 077
  cat > "$INSTALL_DIR/.env" <<EOF
# Rubityle Configuration (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))
DAEMON_PORT=${DAEMON_PORT}
DAEMON_TOKEN=${DAEMON_TOKEN}
PANEL_URL=${PANEL_URL}
PANEL_API_KEY=${PANEL_API_KEY}
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_NETWORK=${DOCKER_NETWORK}
DATA_DIR=${DATA_DIR}
LOG_DIR=${LOG_DIR}
SFTP_PORT=${SFTP_PORT}
# Owner applied to server files after root-run install containers finish.
SERVER_UID=${SERVER_UID}
SERVER_GID=${SERVER_GID}
# A server that sits at/above a RAM/CPU/DISK limit for this many seconds is killed.
RESOURCE_LIMIT_GRACE_SECONDS=600
# How often (seconds) running servers are checked against their limits.
RESOURCE_MONITOR_INTERVAL_SECONDS=15
EOF
  umask 022
  chown root:root "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  ok "Configuration written to $INSTALL_DIR/.env"
}

# Appends settings that exist in the new .env.example but not in the user's
# .env yet (existing values are never touched).
merge_env_defaults() {
  local example="$SRC_DIR/.env.example" env="$INSTALL_DIR/.env" line key added=0
  [[ -f "$example" && -f "$env" ]] || return 0

  if [[ -s "$env" && -n "$(tail -c1 "$env")" ]]; then
    printf '\n' >> "$env"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    if ! grep -qE "^${key}=" "$env"; then
      printf '%s\n' "$line" >> "$env"
      added=$(( added + 1 ))
    fi
  done < "$example"
  chmod 600 "$env"
  if (( added > 0 )); then
    ok "Added ${added} new default setting(s) to .env"
  fi
}

# Copies the daemon sources. Never overwrites user state (.env, config.json).
copy_source() {
  tar --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./.env' \
      --exclude='./config.json' \
      --exclude='./.rubityle-install' \
      -cf - -C "$SRC_DIR" . | tar -xf - -C "$INSTALL_DIR" || return 1
}

do_install() {
  banner
  type_line "$PRIMARY" "Fresh installation"

  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
    die "$INSTALL_DIR exists but is not a directory."
  fi
  if [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" && $FORCE -eq 0 ]]; then
    die "$INSTALL_DIR is not empty. Use --force to install over it, or set --install-dir."
  fi
  adopt_existing_env

  step "1/9  Installing base packages"
  ensure_base_packages
  ok "Base packages ready"

  step "2/9  Fetching Rubityle source"
  prepare_source

  step "3/9  Checking Node.js"
  ensure_node

  step "4/9  Docker and game server network"
  ensure_docker

  step "5/9  Creating directories"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
  chmod 755 "$DATA_DIR"
  chmod 750 "$LOG_DIR"
  ok "Directories ready"

  step "6/9  Copying daemon files"
  run_with_spinner "Installing daemon files" copy_source || die "Failed to copy daemon files"
  ok "Daemon files installed in $INSTALL_DIR"

  step "7/9  Writing configuration"
  write_env
  write_metadata

  step "8/9  Installing dependencies"
  run_with_spinner "Installing Node dependencies" install_node_deps || die "Dependency installation failed"

  step "9/9  Registering the service and rubityle command"
  write_cli
  ok "Installed ${CLI_PATH}"
  write_systemd_unit
  if have_systemd; then
    systemctl restart "$SERVICE_NAME"
    ok "Service ${SERVICE_NAME} enabled and started"
  else
    warn "systemd not detected; start the daemon manually:"
    log "  cd $INSTALL_DIR && node daemon.js"
  fi

  health_check "$(daemon_port)"
  final_summary "Rubityle ready" 1
}

# ── 2. Update ────────────────────────────────────────────────────────────────
# LAST_BACKUP_DIR must be set by the caller: this runs inside the spinner's
# background subshell, so assignments made here would not reach the caller.
backup_for_update() {
  mkdir -p "$LAST_BACKUP_DIR" || return 1
  chmod 700 "$BACKUP_ROOT" "$LAST_BACKUP_DIR" || return 1

  local f
  for f in .env config.json .rubityle-install; do
    if [[ -f "$INSTALL_DIR/$f" ]]; then
      cp -a "$INSTALL_DIR/$f" "$LAST_BACKUP_DIR/$f" || return 1
    fi
  done
  # SFTP identity: losing the host key makes every SFTP client warn about a
  # changed server, and sftp_users.json holds the panel-issued SFTP accounts.
  for f in sftp_host_key.pem sftp_users.json; do
    if [[ -f "$DATA_DIR/$f" ]]; then
      cp -a "$DATA_DIR/$f" "$LAST_BACKUP_DIR/$f" || return 1
    fi
  done
}

do_update() {
  banner
  type_line "$PRIMARY" "Checking for updates"

  [[ -f "$INSTALL_DIR/package.json" ]] || die "Rubityle does not appear to be installed in $INSTALL_DIR."
  load_metadata
  adopt_existing_env

  step "1/6  Preparing"
  ensure_base_packages
  ensure_node

  local local_version remote_version
  local_version="$(read_version "$INSTALL_DIR/package.json")"
  [[ -n "$local_version" ]] || local_version="0.0.0"

  step "2/6  Fetching ${REPO_SLUG} (${REF})"
  prepare_source
  remote_version="$(read_version "$SRC_DIR/package.json")"
  [[ -n "$remote_version" ]] || die "Could not read the remote package version."

  if ! semver_gt "$remote_version" "$local_version"; then
    if [[ $FORCE -eq 1 ]]; then
      warn "Version did not increase (local ${local_version}, remote ${remote_version}); re-applying because of --force."
    else
      ok "Already up to date (local ${local_version}, remote ${remote_version})."
      return
    fi
  else
    info "Update available: ${local_version} -> ${remote_version}"
  fi

  if [[ $ASSUME_YES -eq 0 ]] && ! ask_yes_no "Apply this update? Game servers keep running; the daemon restarts briefly." y; then
    warn "Update cancelled."
    return
  fi

  step "3/6  Backing up .env, config and SFTP identity"
  LAST_BACKUP_DIR="${BACKUP_ROOT}/$(date +%Y%m%d-%H%M%S)"
  run_with_spinner "Creating update backup" backup_for_update || die "Backup failed; update cancelled."
  ok "Backup saved to ${LAST_BACKUP_DIR}"

  step "4/6  Installing updated files"
  run_with_spinner "Replacing daemon files" copy_source || die "Failed to install updated files."

  step "5/6  Refreshing dependencies, settings and service"
  run_with_spinner "Installing Node dependencies" install_node_deps || die "Dependency installation failed"
  merge_env_defaults
  write_metadata
  write_cli
  write_systemd_unit

  step "6/6  Restarting daemon"
  restart_daemon
  health_check "$(daemon_port)"

  final_summary "Rubityle updated to ${remote_version}" 0
}

# ── 3. Uninstall ─────────────────────────────────────────────────────────────
do_uninstall() {
  banner
  type_line "$PRIMARY" "Uninstalling Rubityle"

  load_metadata
  [[ -e "$INSTALL_DIR" ]] || die "Nothing to uninstall in $INSTALL_DIR."
  [[ -f "$INSTALL_DIR/daemon.js" || -f "$INSTALL_DIR/.rubityle-install" ]] \
    || die "$INSTALL_DIR does not look like a Rubityle install; refusing to delete it."

  # Read before the install directory (and its .env) is removed.
  local prefix=""
  prefix="$(env_value CONTAINER_PREFIX "$INSTALL_DIR/.env")"
  [[ "$prefix" =~ ^[A-Za-z0-9_.-]+$ ]] || prefix="pylox-"

  step "1/5  Stopping the daemon"
  if have_systemd; then
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
  fi
  ok "Daemon stopped (game server containers were not touched)"

  step "2/5  Removing the systemd unit and rubityle command"
  if have_systemd; then
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$CLI_PATH"
  ok "Service unit and command removed"

  step "3/5  Removing daemon files"
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"

  step "4/5  Game server containers"
  local -a containers=()
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    mapfile -t containers < <(docker ps -a --filter "name=^${prefix}" --format '{{.Names}}' 2>/dev/null || true)
  fi
  if (( ${#containers[@]} > 0 )); then
    info "Found ${#containers[@]} container(s) named ${prefix}*: ${containers[*]}"
    if ask_yes_no "Stop and remove these game server containers?" n; then
      docker rm -f "${containers[@]}" >/dev/null 2>&1 || warn "Some containers could not be removed."
      ok "Containers removed"
    else
      warn "Containers kept; they will keep running without the daemon."
    fi
  else
    ok "No game server containers found"
  fi

  step "5/5  Data cleanup"
  if ask_yes_no "Also PERMANENTLY delete ${DATA_DIR} (all game server files, SFTP keys/users) and ${LOG_DIR}?" n; then
    rm -rf "$DATA_DIR" "$LOG_DIR"
    ok "Removed ${DATA_DIR} and ${LOG_DIR}"
  else
    warn "Kept ${DATA_DIR} and ${LOG_DIR}."
  fi
  if [[ -d "$BACKUP_ROOT" ]]; then
    warn "Update backups are still in ${BACKUP_ROOT} (they contain your daemon token); delete them if no longer needed."
  fi

  log ""
  log -e "${ACCENT}Rubityle has been uninstalled.${NC}"
  log -e "${DIM}${GREY}The Docker network ${DOCKER_NETWORK} and Docker itself were left in place.${NC}"
}

# ── Menu ─────────────────────────────────────────────────────────────────────
MENU_KEYS=(1 2 3 4)
MENU_LABELS=("Install Rubityle" "Update Rubityle" "Uninstall Rubityle" "Exit")
MENU_DESCS=(
  "Fresh install of the game daemon"
  "Pull the latest version from GitHub"
  "Remove the daemon from this server"
  "Leave the installer"
)
MENU_INNER=66

# Draws the boxed menu with the selected row highlighted.
draw_menu() {
  local sel="$1"
  local n=${#MENU_LABELS[@]} i row hline out="" line ptr kc lc dc

  hline="$(printf '%*s' "$MENU_INNER" '')"
  hline="${hline// /─}"

  out+=$'\033['"${MENU_TOP};${BANNER_COL}H${PRIMARY}╭${hline}╮${NC}"
  for (( i = 0; i < n; i++ )); do
    row=$(( MENU_TOP + 1 + i ))
    if (( i == sel )); then
      ptr="${ROSE}❯${NC}"
      kc="${ROSE}${BOLD}"
      lc="${BOLD}${WHITE}"
      dc="$ACCENT"
    else
      ptr=" "
      kc="$PRIMARY"
      lc="$GREY"
      dc="${DIM}${GREY}"
    fi
    printf -v line '\033[%d;%dH%b│%b %b %b%s%b  %b%-22s%b %b%-36s%b %b│%b' \
      "$row" "$BANNER_COL" "$PRIMARY" "$NC" "$ptr" "$kc" "${MENU_KEYS[$i]}" "$NC" \
      "$lc" "${MENU_LABELS[$i]}" "$NC" "$dc" "${MENU_DESCS[$i]}" "$NC" "$PRIMARY" "$NC"
    out+="$line"
  done
  out+=$'\033['"$(( MENU_TOP + n + 1 ));${BANNER_COL}H${PRIMARY}╰${hline}╯${NC}"
  printf '%s' "$out"
}

draw_hint() {
  local n=${#MENU_LABELS[@]}
  printf '\033[%d;%dH%b%s%b' "$(( MENU_TOP + n + 3 ))" "$BANNER_COL" "${DIM}${GREY}" \
    "↑/↓ navigate   enter select   1-4 jump   q quit" "$NC"
}

# Animated menu: arrow keys / number keys, plus a light sweep across the logo
# every few seconds while it waits for input.
main_menu_anim() {
  local sel=0 n=${#MENU_LABELS[@]} key seq rc act i
  local idle sweeping shine sweep_end t
  local idle_ticks=14   # 14 * 0.25s ≈ 3.5s between sweeps

  while true; do
    banner
    hide_cursor
    draw_menu "$sel"
    draw_hint
    printf '\033[%d;1H' "$(( MENU_TOP + n + 5 ))"

    sweep_end=$(( BANNER_W + 2 * ${#BANNER_ROWS[@]} + 8 ))
    act=""
    idle=0
    sweeping=0
    shine=0

    while [[ -z "$act" ]]; do
      t="0.25"
      if (( sweeping )); then t="0.03"; fi

      if IFS= read -rsn1 -t "$t" key; then
        case "$key" in
          $'\033')
            seq=""
            IFS= read -rsn2 -t 0.05 seq || true
            case "$seq" in
              '[A') sel=$(( (sel + n - 1) % n )); draw_menu "$sel" ;;
              '[B') sel=$(( (sel + 1) % n )); draw_menu "$sel" ;;
            esac
            ;;
          k) sel=$(( (sel + n - 1) % n )); draw_menu "$sel" ;;
          j) sel=$(( (sel + 1) % n )); draw_menu "$sel" ;;
          "") act="${MENU_KEYS[$sel]}" ;;
          [1-4])
            for (( i = 0; i < n; i++ )); do
              if [[ "${MENU_KEYS[$i]}" == "$key" ]]; then sel=$i; fi
            done
            draw_menu "$sel"
            act="$key"
            ;;
          q|Q) act=4 ;;
        esac
      else
        rc=$?
        if (( rc <= 128 )); then
          act=4   # stdin closed
        elif (( sweeping )); then
          draw_banner_frame "$shine"
          shine=$(( shine + 5 ))
          if (( shine > sweep_end )); then
            draw_banner_frame -100
            sweeping=0
            idle=0
          fi
        else
          idle=$(( idle + 1 ))
          if (( idle >= idle_ticks )); then
            sweeping=1
            shine=-6
          fi
        fi
      fi
    done

    show_cursor
    printf '\033[%d;1H\n' "$(( MENU_TOP + n + 5 ))"
    case "$act" in
      1) do_install ;;
      2) do_update ;;
      3) do_uninstall ;;
      4) printf '\n'; exit 0 ;;
    esac
    press_enter
  done
}

# Plain numbered menu (no animation): used when the terminal can't animate.
main_menu_plain() {
  local choice=""
  while true; do
    banner
    printf '%b  %s%b\n' "$ACCENT" "Main menu" "$NC"
    printf '\n'
    printf '  %b[1]%b %bInstall Rubityle%b\n' "$PRIMARY" "$NC" "$ACCENT" "$NC"
    printf '  %b[2]%b %bUpdate Rubityle%b\n' "$PRIMARY" "$NC" "$ACCENT" "$NC"
    printf '  %b[3]%b %bUninstall Rubityle%b\n' "$PRIMARY" "$NC" "$ACCENT" "$NC"
    printf '  %b[4]%b %bExit%b\n' "$PRIMARY" "$NC" "$ACCENT" "$NC"
    printf '\n'
    printf '%bSelect an option:%b ' "$PRIMARY" "$NC"
    read -r choice || exit 0
    case "$choice" in
      1) do_install ;;
      2) do_update ;;
      3) do_uninstall ;;
      4) exit 0 ;;
      *) warn "Invalid option: $choice" ;;
    esac
    press_enter
  done
}

main_menu() {
  if [[ $UI_ANIM -eq 1 && -t 0 ]]; then
    main_menu_anim
  else
    main_menu_plain
  fi
}

case "$ACTION" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
  *)         main_menu ;;
esac
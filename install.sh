#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="ai-host-bridge"
APP_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
LOGROTATE_FILE="/etc/logrotate.d/${APP_NAME}"
REPO_ARCHIVE_URL="https://github.com/Rick-953/ai-host-bridge/archive/refs/heads/main.tar.gz"
DEFAULT_PORT="3333"
DEFAULT_BASE_URL="https://000339.xyz"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '\n==> %s\n' "$*"; }
die() { red "ERROR: $*"; exit 1; }

need_root() {
  [[ "${EUID}" -eq 0 ]] || die "Please run as root, for example: sudo bash install.sh"
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local value
  if [[ -n "$default_value" ]]; then
    read -r -p "${label} [${default_value}]: " value
    value="${value:-$default_value}"
  else
    read -r -p "${label}: " value
  fi
  printf -v "$var_name" '%s' "$value"
}

random_api_key() {
  node -e "console.log('abh_' + require('crypto').randomBytes(24).toString('base64url'))"
}

random_access_code() {
  node -e "console.log('gpt_' + require('crypto').randomBytes(12).toString('base64url'))"
}

ensure_packages() {
  info "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl rsync tar nodejs npm
  node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 18) process.exit(1)" \
    || die "Node.js 18+ is required. Install Node.js 22 and rerun this installer."
}

source_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${script_dir}/server.js" && -f "${script_dir}/package.json" ]]; then
    printf '%s\n' "$script_dir"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$REPO_ARCHIVE_URL" -o "${tmp}/source.tar.gz"
  tar -xzf "${tmp}/source.tar.gz" -C "$tmp"
  find "$tmp" -maxdepth 1 -type d -name 'ai-host-bridge-*' | head -n 1
}

write_env() {
  local public_base_url="$1"
  local port="$2"
  local api_key="$3"
  local access_code="$4"
  install -m 0600 /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
PORT=${port}
HOST=127.0.0.1
WORKSPACE_DIR=${APP_DIR}/workspace
ALLOWED_HOSTS=localhost,127.0.0.1,${public_base_url#https://},${public_base_url#http://}
MCP_API_KEYS=${api_key}
FULL_MACHINE_ACCESS=1
PUBLIC_BASE_URL=${public_base_url%/}
OAUTH_ISSUER=${public_base_url%/}
OAUTH_RESOURCE=${public_base_url%/}/mcp
OAUTH_SCOPE=mcp:root
OAUTH_STATIC_CLIENT_ID=chatgpt
OAUTH_STORE_PATH=${APP_DIR}/oauth-store.json
OAUTH_LOGIN_CODE=${access_code}
LOG_DIR=/var/log/ai-host-bridge
LOG_RAW_AI_REQUESTS=1
LOG_MAX_BODY_BYTES=200000
EOF
}

install_app() {
  need_root
  ensure_packages

  local public_base_url port api_key access_code src
  prompt public_base_url "Public base URL" "$DEFAULT_BASE_URL"
  prompt port "Local listen port" "$DEFAULT_PORT"
  prompt api_key "MCP API key" "$(random_api_key)"
  prompt access_code "OAuth access code" "$(random_access_code)"

  src="$(source_dir)"

  info "Installing ${APP_NAME} from ${src}"
  install -d -m 0755 "$APP_DIR"
  install -d -m 0750 "${APP_DIR}/workspace"
  install -d -m 0700 /var/log/ai-host-bridge
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'oauth-store.json' \
    --exclude 'workspace' \
    "${src}/" "$APP_DIR/"

  cd "$APP_DIR"
  npm ci --omit=dev
  install -m 0755 "${APP_DIR}/bin/ai-host-bridgectl" /usr/local/bin/ai-host-bridgectl
  install -m 0644 "${APP_DIR}/systemd/ai-host-bridge.service" "$SERVICE_FILE"
  install -m 0644 "${APP_DIR}/deploy/ai-host-bridge.logrotate" "$LOGROTATE_FILE"
  write_env "$public_base_url" "$port" "$api_key" "$access_code"

  systemctl daemon-reload
  systemctl enable --now "$APP_NAME"

  green "AI Host Bridge installed."
  echo "MCP URL: ${public_base_url%/}/mcp"
  echo "Admin UI: ${public_base_url%/}/admin"
  echo "Access code: ${access_code}"
}

uninstall_app() {
  need_root
  systemctl disable --now "$APP_NAME" 2>/dev/null || true
  rm -f "$SERVICE_FILE" "$LOGROTATE_FILE" /usr/local/bin/ai-host-bridgectl
  systemctl daemon-reload
  yellow "Removed systemd/logrotate/CLI. Kept ${APP_DIR}, ${ENV_FILE}, and /var/log/ai-host-bridge."
}

case "${1:-install}" in
  install) install_app ;;
  --uninstall|uninstall) uninstall_app ;;
  *) die "Usage: bash install.sh [install|--uninstall]" ;;
esac

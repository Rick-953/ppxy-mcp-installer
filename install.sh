#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="ppxy-mcp"
APP_DIR="/opt/${APP_NAME}"
ENV_DIR="/etc/${APP_NAME}"
ENV_FILE="${ENV_DIR}/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
CERTBOT_DIR="${APP_DIR}/certbot-venv"
WEBROOT="/var/www/${APP_NAME}"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}.conf"
SERVICE_USER="${APP_NAME}"
DEFAULT_PORT="3333"
DEFAULT_WORKSPACE="${APP_DIR}/workspace"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '\n==> %s\n' "$*"; }
die() { red "ERROR: $*"; exit 1; }

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Please run as root, for example: sudo bash install.sh"
  fi
}

is_debian_like() {
  [[ -r /etc/os-release ]] || return 1
  . /etc/os-release
  [[ "${ID:-}" == "debian" || "${ID_LIKE:-}" == *"debian"* ]]
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local value
  if [[ -n "${default_value}" ]]; then
    read -r -p "${label} [${default_value}]: " value
    value="${value:-$default_value}"
  else
    read -r -p "${label}: " value
  fi
  printf -v "${var_name}" '%s' "${value}"
}

prompt_choice() {
  local var_name="$1"
  local label="$2"
  local default_value="$3"
  local value
  while true; do
    read -r -p "${label} [${default_value}]: " value
    value="${value:-$default_value}"
    case "${value}" in
      domain|ip|none)
        printf -v "${var_name}" '%s' "${value}"
        return 0
        ;;
      *)
        yellow "Please enter one of: domain, ip, none, y, n"
        ;;
    esac
  done
}

random_api_key() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'ppxy_%s' "$(openssl rand -hex 24)"
  else
    printf 'ppxy_%s' "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  fi
}

public_ipv4() {
  curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true
}

major_version() {
  local raw="${1#v}"
  printf '%s' "${raw%%.*}"
}

ensure_apt() {
  info "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg lsb-release openssl python3 python3-venv
}

ensure_node() {
  local current_major="0"
  if command -v node >/dev/null 2>&1; then
    current_major="$(major_version "$(node -v)")"
  fi

  if [[ "${current_major}" =~ ^[0-9]+$ && "${current_major}" -ge 18 ]] && command -v npm >/dev/null 2>&1; then
    info "Using existing Node.js $(node -v)"
    return 0
  fi

  info "Installing Node.js"
  apt-get install -y nodejs npm || true

  current_major="0"
  if command -v node >/dev/null 2>&1; then
    current_major="$(major_version "$(node -v)")"
  fi
  if [[ "${current_major}" =~ ^[0-9]+$ && "${current_major}" -ge 18 ]] && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  info "Installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs

  current_major="$(major_version "$(node -v)")"
  [[ "${current_major}" -ge 18 ]] || die "Node.js 18+ is required"
}

install_certbot_venv() {
  info "Installing latest Certbot into ${CERTBOT_DIR}"
  python3 -m venv "${CERTBOT_DIR}"
  "${CERTBOT_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
  "${CERTBOT_DIR}/bin/python" -m pip install --upgrade "certbot>=5.4.0"
}

write_server_files() {
  info "Writing MCP server files"
  install -d -m 0755 "${APP_DIR}"
  install -d -m 0755 "${ENV_DIR}"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${WORKSPACE_DIR}"

  cat > "${APP_DIR}/package.json" <<'JSON'
{
  "name": "ppxy-remote-coding-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node /opt/ppxy-mcp/server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "express": "5.2.1",
    "zod": "4.2.0"
  }
}
JSON

  cat > "${APP_DIR}/server.js" <<'NODE'
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

const NAME = 'ppxy-remote-coding-mcp';
const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || '/opt/ppxy-mcp/workspace');
const RAW_KEYS = process.env.MCP_API_KEYS || process.env.MCP_API_KEY || '';
const API_KEYS = RAW_KEYS.split(',').map((key) => key.trim()).filter(Boolean);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

if (API_KEYS.length === 0) {
  console.error('MCP_API_KEY or MCP_API_KEYS must be set.');
  process.exit(1);
}

function text(content) {
  return { content: [{ type: 'text', text: String(content) }] };
}

function jsonText(value) {
  return text(JSON.stringify(value, null, 2));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requestApiKey(req) {
  const auth = req.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const apiKey = auth.match(/^ApiKey\s+(.+)$/i);
  if (apiKey) return apiKey[1].trim();
  return req.get('x-api-key') || req.get('api-key') || req.query.api_key || req.query.key || '';
}

function requireAuth(req, res, next) {
  const key = requestApiKey(req);
  if (key && API_KEYS.some((candidate) => safeEqual(key, candidate))) return next();
  res.set('WWW-Authenticate', 'Bearer realm="ppxy-mcp"');
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
}

function resolveWorkspacePath(input = '.') {
  const requested = String(input || '.').replaceAll('\0', '');
  const target = path.resolve(path.isAbsolute(requested) ? requested : path.join(WORKSPACE, requested));
  if (target !== WORKSPACE && !target.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return target;
}

function relativePath(target) {
  const rel = path.relative(WORKSPACE, target);
  return rel || '.';
}

function limitText(value, maxBytes) {
  const source = Buffer.from(String(value), 'utf8');
  if (source.length <= maxBytes) return { value: source.toString('utf8'), truncated: false };
  const clipped = source.subarray(0, maxBytes).toString('utf8');
  return { value: `${clipped}\n[truncated to ${maxBytes} bytes]`, truncated: true };
}

async function walkDirectory(root, maxDepth, maxEntries) {
  const lines = [];
  async function visit(dir, depth) {
    if (lines.length >= maxEntries) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= maxEntries) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const rel = relativePath(full);
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch {
        continue;
      }
      const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other';
      lines.push(`${rel}${entry.isDirectory() ? '/' : ''}\t${type}\t${stat.size}`);
      if (entry.isDirectory() && depth < maxDepth) await visit(full, depth + 1);
    }
  }
  await visit(root, 0);
  if (lines.length >= maxEntries) lines.push(`[truncated at ${maxEntries} entries]`);
  return lines.join('\n') || '(empty)';
}

function assertAllowedCommand(command) {
  const compact = String(command).replace(/\s+/g, ' ').trim();
  const blocked = [
    { re: /\b(sudo|su|doas)\b/i, reason: 'privilege escalation is disabled' },
    { re: /\b(systemctl|service|reboot|shutdown|halt|poweroff|init)\b/i, reason: 'system control commands are disabled' },
    { re: /\b(docker|podman|kubectl|iptables|nft|ufw|firewall-cmd)\b/i, reason: 'host administration commands are disabled' },
    { re: /\b(mkfs|mount|umount|swapon|swapoff)\b/i, reason: 'device and mount commands are disabled' }
  ];
  const hit = blocked.find((item) => item.re.test(compact));
  if (hit) throw new Error(hit.reason);
}

async function runShell({ command, cwd = '.', timeoutMs = 30000, maxOutputBytes = 60000 }) {
  assertAllowedCommand(command);
  const workingDirectory = resolveWorkspacePath(cwd);
  const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
  const maxBytes = Math.min(Math.max(Number(maxOutputBytes) || 60000, 1000), 200000);
  await fs.mkdir(workingDirectory, { recursive: true });

  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: WORKSPACE,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: workingDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const append = (current, chunk) => limitText(current + chunk.toString('utf8'), maxBytes).value;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message, stdout, stderr, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, cwd: relativePath(workingDirectory) });
    });
  });
}

function createServer() {
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { logging: {} } });

  server.registerTool('workspace_info', {
    title: 'Workspace Info',
    description: 'Show the sandboxed workspace and available MCP tools.'
  }, async () => jsonText({
    workspace: WORKSPACE,
    policy: 'File tools and shell commands are restricted to this workspace and run as an unprivileged system user.',
    tools: ['workspace_info', 'list_files', 'read_file', 'write_file', 'run_shell']
  }));

  server.registerTool('list_files', {
    title: 'List Files',
    description: 'List files under a workspace-relative directory.',
    inputSchema: {
      path: z.string().default('.').describe('Workspace-relative directory path.'),
      maxDepth: z.number().int().min(0).max(5).default(2).describe('Directory recursion depth.'),
      maxEntries: z.number().int().min(1).max(1000).default(200).describe('Maximum entries to return.')
    }
  }, async ({ path: inputPath, maxDepth, maxEntries }) => {
    const target = resolveWorkspacePath(inputPath);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${inputPath}`);
    return text(await walkDirectory(target, maxDepth, maxEntries));
  });

  server.registerTool('read_file', {
    title: 'Read File',
    description: 'Read a UTF-8 text file from the workspace.',
    inputSchema: {
      path: z.string().min(1).describe('Workspace-relative file path.'),
      maxBytes: z.number().int().min(1).max(200000).default(40000).describe('Maximum bytes to return.')
    }
  }, async ({ path: inputPath, maxBytes }) => {
    const target = resolveWorkspacePath(inputPath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Not a file: ${inputPath}`);
    const data = await fs.readFile(target);
    return text(limitText(data.toString('utf8'), maxBytes).value);
  });

  server.registerTool('write_file', {
    title: 'Write File',
    description: 'Write or append UTF-8 text to a workspace file.',
    inputSchema: {
      path: z.string().min(1).describe('Workspace-relative file path.'),
      content: z.string().max(1000000).describe('Text content to write.'),
      mode: z.enum(['overwrite', 'append']).default('overwrite').describe('Write mode.'),
      createDirs: z.boolean().default(true).describe('Create parent directories when needed.')
    }
  }, async ({ path: inputPath, content, mode, createDirs }) => {
    const target = resolveWorkspacePath(inputPath);
    if (createDirs) await fs.mkdir(path.dirname(target), { recursive: true });
    if (mode === 'append') await fs.appendFile(target, content, 'utf8');
    else await fs.writeFile(target, content, 'utf8');
    return jsonText({ path: relativePath(target), bytes: Buffer.byteLength(content, 'utf8'), mode });
  });

  server.registerTool('run_shell', {
    title: 'Run Shell',
    description: 'Run a bash command inside the workspace as the unprivileged MCP service user.',
    inputSchema: {
      command: z.string().min(1).max(4000).describe('Bash command to run.'),
      cwd: z.string().default('.').describe('Workspace-relative working directory.'),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Timeout in milliseconds.'),
      maxOutputBytes: z.number().int().min(1000).max(200000).default(60000).describe('Maximum stdout/stderr bytes each.')
    }
  }, async (args) => jsonText(await runShell(args)));

  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(hostHeaderValidation(ALLOWED_HOSTS));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, name: NAME, version: VERSION, workspace: WORKSPACE });
});

app.use(['/mcp', '/sse', '/messages'], requireAuth);

const sessions = new Map();

async function cleanupSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  try { await entry.transport.close(); } catch {}
  try { await entry.server.close(); } catch {}
}

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && sessions.has(sessionId)) {
      const existing = sessions.get(sessionId);
      if (existing.type !== 'streamable') {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session uses a different transport' }, id: null });
      }
      transport = existing.transport;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { type: 'streamable', transport, server });
        },
        onsessionclosed: (closedSessionId) => cleanupSession(closedSessionId)
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) cleanupSession(sid);
      };
      await server.connect(transport);
    } else {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: initialize first or provide Mcp-Session-Id' }, id: null });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    const server = createServer();
    sessions.set(transport.sessionId, { type: 'sse', transport, server });
    transport.onclose = () => cleanupSession(transport.sessionId);
    res.on('close', () => cleanupSession(transport.sessionId));
    await server.connect(transport);
  } catch (error) {
    console.error('SSE connection failed:', error);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

app.post('/messages', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    const existing = sessions.get(sessionId);
    if (!existing || existing.type !== 'sse') return res.status(400).send('No SSE transport found for sessionId');
    await existing.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('SSE message failed:', error);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

const listener = app.listen(PORT, HOST, () => {
  console.log(`${NAME} listening on http://${HOST}:${PORT}`);
});

async function shutdown() {
  listener.close();
  await Promise.all([...sessions.keys()].map((sessionId) => cleanupSession(sessionId)));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
NODE

  chown -R root:root "${APP_DIR}"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${WORKSPACE_DIR}"
  chmod 0755 "${APP_DIR}"
  chmod 0644 "${APP_DIR}/package.json" "${APP_DIR}/server.js"
}

write_env_file() {
  info "Writing environment file"
  local service_host="127.0.0.1"
  if [[ "${PUBLIC_MODE}" == "none" ]]; then
    service_host="0.0.0.0"
  fi

  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=${service_host}
WORKSPACE_DIR=${WORKSPACE_DIR}
ALLOWED_HOSTS=localhost,127.0.0.1,${PUBLIC_HOST}
MCP_API_KEYS=${API_KEY}
EOF
  chmod 0600 "${ENV_FILE}"
}

write_systemd_service() {
  info "Writing systemd service"
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=PPXY Remote Coding MCP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${WORKSPACE_DIR}
CapabilityBoundingSet=
LockPersonality=true
RestrictSUIDSGID=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
}

install_node_dependencies() {
  info "Installing MCP server dependencies"
  (cd "${APP_DIR}" && npm install --omit=dev)
  node --check "${APP_DIR}/server.js"
}

start_service() {
  info "Starting ${APP_NAME}"
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}"
  systemctl restart "${APP_NAME}"
  sleep 1
  systemctl is-active --quiet "${APP_NAME}" || {
    journalctl -u "${APP_NAME}" --no-pager -n 60 >&2 || true
    die "${APP_NAME} failed to start"
  }
}

write_http_nginx_site() {
  info "Writing temporary HTTP Nginx site"
  install -d -m 0755 "${WEBROOT}/.well-known/acme-challenge"
  cat > "${NGINX_SITE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${PUBLIC_HOST};
    root ${WEBROOT};

    location ^~ /.well-known/acme-challenge/ {
        try_files \$uri =404;
    }

    location / {
        return 200 "ppxy-mcp ACME bootstrap\\n";
        add_header Content-Type text/plain;
    }
}
EOF
  ln -sf "${NGINX_SITE}" "${NGINX_LINK}"
  nginx -t
  systemctl reload nginx || systemctl restart nginx
}

issue_certificate() {
  info "Requesting TLS certificate"
  local email_args=()
  if [[ -n "${EMAIL}" ]]; then
    email_args=(--email "${EMAIL}")
  else
    email_args=(--register-unsafely-without-email)
  fi

  if [[ "${PUBLIC_MODE}" == "domain" ]]; then
    "${CERTBOT_DIR}/bin/certbot" certonly \
      --webroot \
      --webroot-path "${WEBROOT}" \
      --cert-name "${PUBLIC_HOST}" \
      -d "${PUBLIC_HOST}" \
      --non-interactive \
      --agree-tos \
      "${email_args[@]}"
  elif [[ "${PUBLIC_MODE}" == "ip" ]]; then
    "${CERTBOT_DIR}/bin/certbot" certonly \
      --webroot \
      --webroot-path "${WEBROOT}" \
      --cert-name "${PUBLIC_HOST}" \
      --ip-address "${PUBLIC_HOST}" \
      --preferred-profile shortlived \
      --non-interactive \
      --agree-tos \
      "${email_args[@]}"
  fi
}

write_https_nginx_site() {
  info "Writing HTTPS Nginx site"
  cat > "${NGINX_SITE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${PUBLIC_HOST};
    root ${WEBROOT};

    location ^~ /.well-known/acme-challenge/ {
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${PUBLIC_HOST};

    ssl_certificate /etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_HOST}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 4m;

    location = /mcp-health {
        proxy_pass http://127.0.0.1:${PORT}/healthz;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location ^~ /mcp {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location ^~ /sse {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location ^~ /messages {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  nginx -t
  systemctl reload nginx || systemctl restart nginx
}

write_certbot_timer() {
  info "Writing Certbot renewal timer"
  cat > /etc/systemd/system/ppxy-mcp-certbot-renew.service <<EOF
[Unit]
Description=Renew PPXY MCP TLS certificates

[Service]
Type=oneshot
ExecStart=${CERTBOT_DIR}/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF

  cat > /etc/systemd/system/ppxy-mcp-certbot-renew.timer <<'EOF'
[Unit]
Description=Run PPXY MCP certificate renewal twice daily

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now ppxy-mcp-certbot-renew.timer
}

configure_nginx_https() {
  info "Installing and configuring Nginx"
  apt-get install -y nginx
  systemctl enable --now nginx
  write_http_nginx_site
  install_certbot_venv
  issue_certificate
  write_https_nginx_site
  write_certbot_timer

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi "Status: active"; then
    ufw allow 'Nginx Full' || true
  fi
}

smoke_test() {
  info "Running local smoke test"
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null
  if [[ "${PUBLIC_MODE}" != "none" ]]; then
    curl -kfsS "https://${PUBLIC_HOST}/mcp-health" >/dev/null || yellow "HTTPS health check failed from this host; check DNS, firewall, or Cloudflare settings."
  fi
}

print_result() {
  local url
  if [[ "${PUBLIC_MODE}" == "none" ]]; then
    url="http://${PUBLIC_HOST}:${PORT}/mcp"
  else
    url="https://${PUBLIC_HOST}/mcp"
  fi

  cat <<EOF

============================================================
PPXY MCP installed.

Perplexity custom connector:
  MCP Server URL : ${url}
  Authentication : API Key
  API Key        : ${API_KEY}
  Transport      : Streamable HTTP

SSE fallback:
  ${url%/mcp}/sse

Service:
  systemctl status ${APP_NAME}
  journalctl -u ${APP_NAME} -f

Workspace:
  ${WORKSPACE_DIR}
============================================================
EOF

  if [[ "${PUBLIC_MODE}" == "none" ]]; then
    yellow "Perplexity remote MCP requires HTTPS. Direct HTTP mode is only for local testing or for use behind your own external HTTPS proxy."
  elif [[ "${PUBLIC_MODE}" == "ip" ]]; then
    yellow "IP certificates from Let's Encrypt are short-lived. Keep the ppxy-mcp-certbot-renew.timer active."
  fi
}

uninstall() {
  need_root
  info "Uninstalling ${APP_NAME}"
  systemctl disable --now "${APP_NAME}" 2>/dev/null || true
  systemctl disable --now ppxy-mcp-certbot-renew.timer 2>/dev/null || true
  rm -f "${SERVICE_FILE}" /etc/systemd/system/ppxy-mcp-certbot-renew.service /etc/systemd/system/ppxy-mcp-certbot-renew.timer
  rm -f "${NGINX_LINK}" "${NGINX_SITE}"
  systemctl daemon-reload
  systemctl reload nginx 2>/dev/null || true
  yellow "Left ${APP_DIR}, ${ENV_DIR}, ${WEBROOT}, and any Let's Encrypt certs in place. Remove them manually if you no longer need them."
}

main() {
  if [[ "${1:-}" == "--uninstall" ]]; then
    uninstall
    exit 0
  fi

  need_root
  is_debian_like || die "This installer supports Debian-like Linux systems."

  cat <<'BANNER'
PPXY Remote MCP Installer

This installs a remote MCP server with:
  - Streamable HTTP endpoint: /mcp
  - SSE fallback endpoint: /sse
  - API key authentication
  - sandboxed workspace tools
BANNER

  local detected_ip
  detected_ip="$(public_ipv4)"

  prompt_choice PUBLIC_MODE "Public access mode: domain, ip, or none" "domain"
  case "${PUBLIC_MODE}" in
    domain)
      prompt PUBLIC_HOST "Domain name, for example mcp.example.com" "${PPXY_MCP_PUBLIC_HOST:-}"
      [[ -n "${PUBLIC_HOST}" ]] || die "Domain name is required"
      ;;
    ip)
      prompt PUBLIC_HOST "Public IP address" "${PPXY_MCP_PUBLIC_HOST:-${detected_ip}}"
      [[ -n "${PUBLIC_HOST}" ]] || die "Public IP address is required"
      yellow "Perplexity still needs HTTPS. This installer will request a short-lived Let's Encrypt IP certificate."
      ;;
    none)
      prompt PUBLIC_HOST "Public host or IP for display only" "${PPXY_MCP_PUBLIC_HOST:-${detected_ip:-127.0.0.1}}"
      yellow "Direct mode exposes HTTP on the selected port. Perplexity remote MCP usually rejects HTTP URLs."
      ;;
    *)
      die "Invalid mode"
      ;;
  esac

  prompt PORT "Local MCP port" "${PPXY_MCP_PORT:-${DEFAULT_PORT}}"
  prompt WORKSPACE_DIR "Sandbox workspace directory" "${PPXY_MCP_WORKSPACE:-${DEFAULT_WORKSPACE}}"

  local generated_key
  generated_key="$(random_api_key)"
  prompt API_KEY "API key, leave default to use generated key" "${PPXY_MCP_API_KEY:-${generated_key}}"
  [[ -n "${API_KEY}" ]] || die "API key is required"

  EMAIL=""
  if [[ "${PUBLIC_MODE}" != "none" ]]; then
    prompt EMAIL "Email for Let's Encrypt notices, empty to skip" "${PPXY_MCP_EMAIL:-}"
  fi

  ensure_apt

  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home "${WORKSPACE_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  ensure_node
  write_server_files
  write_env_file
  write_systemd_service
  install_node_dependencies
  start_service

  if [[ "${PUBLIC_MODE}" != "none" ]]; then
    configure_nginx_https
  fi

  smoke_test
  print_result
}

main "$@"

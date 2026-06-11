import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import express from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

const NAME = 'ai-host-bridge';
const DISPLAY_NAME = 'AI Host Bridge';
const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || '/opt/ai-host-bridge/workspace');
const RAW_KEYS = process.env.MCP_API_KEYS || process.env.MCP_API_KEY || '';
const API_KEYS = RAW_KEYS.split(',').map((key) => key.trim()).filter(Boolean);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,000339.xyz,000993.xyz')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const FULL_MACHINE_ACCESS = process.env.FULL_MACHINE_ACCESS === '1';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://000339.xyz').replace(/\/+$/, '');
const OAUTH_ISSUER = process.env.OAUTH_ISSUER || PUBLIC_BASE_URL;
const OAUTH_RESOURCE = process.env.OAUTH_RESOURCE || `${PUBLIC_BASE_URL}/mcp`;
const OAUTH_SCOPE = process.env.OAUTH_SCOPE || 'mcp:root';
const OAUTH_SCOPES = OAUTH_SCOPE.split(/[\s,]+/).filter(Boolean);
const OAUTH_LOGIN_CODE = process.env.OAUTH_LOGIN_CODE || '';
const OAUTH_STORE_PATH = process.env.OAUTH_STORE_PATH || '/opt/ai-host-bridge/oauth-store.json';
const OAUTH_STATIC_CLIENT_ID = process.env.OAUTH_STATIC_CLIENT_ID || 'chatgpt';

const LOG_DIR = process.env.LOG_DIR || '/var/log/ai-host-bridge';
const LOG_RAW_AI_REQUESTS = process.env.LOG_RAW_AI_REQUESTS !== '0';
const LOG_MAX_BODY_BYTES = Math.min(Math.max(Number(process.env.LOG_MAX_BODY_BYTES) || 200000, 1000), 1000000);


if (API_KEYS.length === 0) {
  console.error('MCP_API_KEY or MCP_API_KEYS must be set.');
  process.exit(1);
}

try {
  fsSync.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
} catch (error) {
  console.error('Failed to create log directory:', error);
}

const LOG_SECRET_KEY_RE = /(?:password|passwd|pwd|secret|token|authorization|api[_-]?key|access[_-]?code|code[_-]?verifier|code[_-]?challenge)/i;

function redactForLog(value, depth = 0) {
  if (depth > 8) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = LOG_SECRET_KEY_RE.test(key) ? '[redacted]' : redactForLog(item, depth + 1);
    }
    return output;
  }
  return value;
}

function clampForLog(value, maxBytes = LOG_MAX_BODY_BYTES) {
  const redacted = redactForLog(value);
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return redacted;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    preview: Buffer.from(json, 'utf8').subarray(0, maxBytes).toString('utf8')
  };
}

function writeJsonl(fileName, payload) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload }) + '\n';
  try {
    fsSync.appendFileSync(path.join(LOG_DIR, fileName), line, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error(`Failed to write ${fileName}:`, error);
  }
}

function logAudit(payload) {
  writeJsonl('audit.jsonl', payload);
}

function logAiRequest(payload) {
  if (!LOG_RAW_AI_REQUESTS) return;
  writeJsonl('ai-requests.jsonl', payload);
}

function logError(payload) {
  writeJsonl('errors.jsonl', {
    ...payload,
    error: payload.error ? {
      name: payload.error.name,
      message: payload.error.message,
      stack: payload.error.stack
    } : undefined
  });
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

function loadOAuthStore() {
  try {
    const raw = fsSync.readFileSync(OAUTH_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
      codes: parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : {},
      tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {}
    };
  } catch {
    return { clients: {}, codes: {}, tokens: {} };
  }
}

function saveOAuthStore() {
  try {
    fsSync.writeFileSync(OAUTH_STORE_PATH, JSON.stringify(oauthStore, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('Failed to persist OAuth store:', error);
  }
}

function pruneOAuthStore() {
  const now = Date.now();
  for (const [code, entry] of Object.entries(oauthStore.codes)) {
    if (!entry || entry.expiresAt <= now || entry.used) delete oauthStore.codes[code];
  }
  for (const [token, entry] of Object.entries(oauthStore.tokens)) {
    if (!entry || entry.expiresAt <= now) delete oauthStore.tokens[token];
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomToken(byteLength = 32) {
  return base64url(randomBytes(byteLength));
}

function pkceS256(verifier) {
  return base64url(createHash('sha256').update(String(verifier)).digest());
}

function requestBearer(req) {
  const auth = req.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
}

function requestApiKey(req) {
  const auth = req.get('authorization') || '';
  const apiKey = auth.match(/^ApiKey\s+(.+)$/i);
  if (apiKey) return apiKey[1].trim();
  return req.get('x-api-key') || req.get('api-key') || req.query.api_key || req.query.key || '';
}

function isApiKey(value) {
  return Boolean(value && API_KEYS.some((candidate) => safeEqual(value, candidate)));
}

function oauthTokenEntry(value) {
  if (!value) return null;
  pruneOAuthStore();
  const entry = oauthStore.tokens[value];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) return null;
  if (entry.resource !== OAUTH_RESOURCE) return null;
  return entry;
}

function isOAuthToken(value) {
  return Boolean(oauthTokenEntry(value));
}

function requestMeta(req, extra = {}) {
  return {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    clientIp: String(req.get('x-forwarded-for') || req.ip || req.socket?.remoteAddress || '').split(',')[0].trim(),
    userAgent: req.get('user-agent') || '',
    sessionId: req.headers['mcp-session-id'] || req.query?.sessionId || '',
    ...extra
  };
}

function authContext(req) {
  const bearer = requestBearer(req);
  const apiKey = requestApiKey(req);
  if (isApiKey(bearer) || isApiKey(apiKey)) {
    return { ok: true, authType: 'api_key', oauthClientId: '' };
  }
  const entry = oauthTokenEntry(bearer);
  if (entry) {
    return { ok: true, authType: 'oauth', oauthClientId: entry.client_id || '' };
  }
  return { ok: false, authType: 'none', oauthClientId: '' };
}

function oauthChallengeHeader() {
  return `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`;
}

function requireAuth(req, res, next) {
  const auth = authContext(req);
  if (auth.ok) {
    req.authContext = auth;
    return next();
  }
  logAudit({ event: 'auth.failed', ...requestMeta(req), authType: auth.authType });
  res.set('WWW-Authenticate', oauthChallengeHeader());
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oauthError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

function isChatGptRedirect(uri) {
  return uri === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
    uri.startsWith('https://chatgpt.com/connector/oauth/');
}

function getOAuthClient(clientId) {
  if (!clientId) return null;
  if (clientId === OAUTH_STATIC_CLIENT_ID) {
    return {
      client_id: OAUTH_STATIC_CLIENT_ID,
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
      client_name: 'ChatGPT'
    };
  }
  return oauthStore.clients[clientId] || null;
}

function isRedirectUriAllowed(client, redirectUri) {
  if (!client || !redirectUri) return false;
  if (client.client_id === OAUTH_STATIC_CLIENT_ID) return isChatGptRedirect(redirectUri);
  if (Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri)) return true;
  return isChatGptRedirect(redirectUri);
}

function protectedResourceMetadata() {
  return {
    resource: OAUTH_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${PUBLIC_BASE_URL}/mcp-health`
  };
}

function authorizationServerMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${PUBLIC_BASE_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_BASE_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: OAUTH_SCOPES
  };
}

function renderAuthorizePage(res, params, message = '') {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params[name])}">`)
    .join('\n');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${DISPLAY_NAME} OAuth</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#111;color:#f5f5f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{width:min(420px,calc(100vw - 32px));border:1px solid #333;padding:24px;background:#1b1b1b;border-radius:8px}
label{display:block;margin:16px 0 8px;color:#ddd}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #555;background:#111;color:#fff;border-radius:6px}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:6px;background:#fff;color:#111;font-weight:650;cursor:pointer}.msg{color:#ffb4b4;margin-top:12px}.meta{color:#aaa;font-size:13px;line-height:1.45}</style>
</head>
<body><main>
	<h1>${DISPLAY_NAME}</h1>
	<p class="meta">Authorize a web AI client to access this MCP server.</p>
${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${hidden}
<label for="access_code">Access code</label>
<input id="access_code" name="access_code" type="password" autocomplete="one-time-code" autofocus required>
<button type="submit">Authorize</button>
</form>
</main></body></html>`);
}

function handleAuthorize(req, res) {
  const params = req.method === 'POST' ? req.body : req.query;
  const client = getOAuthClient(params.client_id);
  if (params.response_type !== 'code') return oauthError(res, 400, 'unsupported_response_type', 'Only authorization code flow is supported.');
  if (!client) return oauthError(res, 400, 'invalid_client', 'Unknown OAuth client.');
  if (!isRedirectUriAllowed(client, String(params.redirect_uri || ''))) return oauthError(res, 400, 'invalid_request', 'Redirect URI is not allowed.');
  if (params.resource && params.resource !== OAUTH_RESOURCE) return oauthError(res, 400, 'invalid_target', 'Invalid resource parameter.');
  if (params.code_challenge_method !== 'S256' || !params.code_challenge) return oauthError(res, 400, 'invalid_request', 'PKCE S256 is required.');

  if (req.method !== 'POST' || params.access_code !== OAUTH_LOGIN_CODE) {
    return renderAuthorizePage(res, params, req.method === 'POST' ? 'Invalid access code.' : '');
  }

  const code = randomToken(32);
  const scope = String(params.scope || OAUTH_SCOPE).trim() || OAUTH_SCOPE;
  oauthStore.codes[code] = {
    client_id: String(params.client_id),
    redirect_uri: String(params.redirect_uri),
    code_challenge: String(params.code_challenge),
    scope,
    resource: String(params.resource || OAUTH_RESOURCE),
    expiresAt: Date.now() + 10 * 60 * 1000,
    used: false
  };
  saveOAuthStore();

  const redirect = new URL(String(params.redirect_uri));
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', String(params.state));
  return res.redirect(302, redirect.toString());
}

function handleToken(req, res) {
  const body = req.body || {};
  if (body.grant_type !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
  const codeEntry = oauthStore.codes[String(body.code || '')];
  if (!codeEntry || codeEntry.used || codeEntry.expiresAt <= Date.now()) return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
  if (body.client_id !== codeEntry.client_id) return oauthError(res, 400, 'invalid_client', 'Client ID does not match authorization code.');
  if (body.redirect_uri !== codeEntry.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'Redirect URI does not match authorization code.');
  if (body.resource && body.resource !== codeEntry.resource) return oauthError(res, 400, 'invalid_target', 'Resource does not match authorization code.');
  if (!body.code_verifier || pkceS256(body.code_verifier) !== codeEntry.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');

  codeEntry.used = true;
  const accessToken = randomToken(32);
  const expiresIn = 7 * 24 * 60 * 60;
  oauthStore.tokens[accessToken] = {
    client_id: codeEntry.client_id,
    scope: codeEntry.scope || OAUTH_SCOPE,
    resource: codeEntry.resource,
    expiresAt: Date.now() + expiresIn * 1000
  };
  pruneOAuthStore();
  saveOAuthStore();

  return res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: codeEntry.scope || OAUTH_SCOPE,
    resource: codeEntry.resource
  });
}

function maskSecret(value) {
  const input = String(value || '');
  if (!input) return '';
  if (input.length <= 8) return '********';
  return `${input.slice(0, 4)}...${input.slice(-4)}`;
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f3ee;--ink:#171614;--muted:#615d55;--line:#d9d1c5;--panel:#fffaf1;--accent:#1f6f5b;--danger:#9d2525}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#f6f3ee,#e6f0ea);color:var(--ink)}
main{width:min(920px,calc(100vw - 32px));margin:40px auto;padding-bottom:40px}.hero{margin-bottom:24px}h1{margin:0 0 8px;font-size:40px;line-height:1.05}h2{margin:0 0 12px;font-size:20px}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.panel{border:1px solid var(--line);background:rgba(255,250,241,.86);border-radius:8px;padding:18px;box-shadow:0 12px 32px rgba(34,29,20,.08)}
code,.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:10px 0}.row:first-child{border-top:0}
a.button,button{display:inline-block;border:0;border-radius:6px;background:var(--accent);color:#fff;padding:10px 14px;text-decoration:none;font-weight:650;cursor:pointer}input{width:100%;padding:11px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#171614}.error{color:var(--danger);font-weight:650}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--ink:#f7f1e7;--muted:#bdb4a6;--line:#3d372f;--panel:#201d18;--accent:#37a483}body{background:linear-gradient(135deg,#171614,#16231f)}input{background:#171614;color:#f7f1e7}.panel{background:rgba(32,29,24,.9)}}
</style>
</head>
<body><main>${body}</main></body></html>`;
}

function renderHomePage(res) {
  res.type('html').send(pageShell(DISPLAY_NAME, `
<section class="hero">
  <h1>${DISPLAY_NAME}</h1>
  <p class="muted">Remote MCP bridge for connecting web AI clients to this server or PC.</p>
</section>
<section class="grid">
  <div class="panel">
    <h2>Connector</h2>
    <div class="row"><span>MCP URL</span><code>${escapeHtml(`${PUBLIC_BASE_URL}/mcp`)}</code></div>
    <div class="row"><span>OAuth</span><code>${escapeHtml(`${PUBLIC_BASE_URL}/oauth/authorize`)}</code></div>
    <div class="row"><span>Health</span><code>${escapeHtml(`${PUBLIC_BASE_URL}/mcp-health`)}</code></div>
    <p><a class="button" href="/admin">Open Admin</a></p>
  </div>
  <div class="panel">
    <h2>Transports</h2>
    <div class="row"><span>Streamable HTTP</span><code>/mcp</code></div>
    <div class="row"><span>SSE</span><code>/sse</code></div>
    <div class="row"><span>SSE messages</span><code>/messages</code></div>
  </div>
</section>`));
}

function renderAdminLogin(res, message = '') {
  res.type('html').send(pageShell(`${DISPLAY_NAME} Admin`, `
<section class="hero">
  <h1>${DISPLAY_NAME} Admin</h1>
  <p class="muted">Enter the access code to view connector details and operations.</p>
</section>
<section class="panel">
  ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
  <form method="post" action="/admin">
    <label for="admin_code">Access code</label>
    <input id="admin_code" name="admin_code" type="password" autocomplete="one-time-code" autofocus required>
    <button type="submit">Open</button>
  </form>
</section>`));
}

function renderAdminPage(res) {
  res.type('html').send(pageShell(`${DISPLAY_NAME} Admin`, `
<section class="hero">
  <h1>${DISPLAY_NAME} Admin</h1>
  <p class="muted">Human console for connector setup and service operations.</p>
</section>
<section class="grid">
  <div class="panel">
    <h2>Access</h2>
    <div class="row"><span>Access code</span><code>${escapeHtml(OAUTH_LOGIN_CODE)}</code></div>
    <div class="row"><span>API key</span><code>${escapeHtml(maskSecret(API_KEYS[0] || ''))}</code></div>
    <div class="row"><span>OAuth client</span><code>${escapeHtml(OAUTH_STATIC_CLIENT_ID)}</code></div>
  </div>
  <div class="panel">
    <h2>Endpoints</h2>
    <div class="row"><span>MCP</span><code>${escapeHtml(`${PUBLIC_BASE_URL}/mcp`)}</code></div>
    <div class="row"><span>OAuth resource</span><code>${escapeHtml(OAUTH_RESOURCE)}</code></div>
    <div class="row"><span>Health</span><code>${escapeHtml(`${PUBLIC_BASE_URL}/mcp-health`)}</code></div>
  </div>
  <div class="panel">
    <h2>Logging</h2>
    <div class="row"><span>Raw AI requests</span><code>${LOG_RAW_AI_REQUESTS ? 'on' : 'off'}</code></div>
    <div class="row"><span>Audit log</span><code>${escapeHtml(path.join(LOG_DIR, 'audit.jsonl'))}</code></div>
    <div class="row"><span>AI request log</span><code>${escapeHtml(path.join(LOG_DIR, 'ai-requests.jsonl'))}</code></div>
  </div>
  <div class="panel">
    <h2>CLI</h2>
    <p><code>ai-host-bridgectl status</code></p>
    <p><code>ai-host-bridgectl show-code</code></p>
    <p><code>ai-host-bridgectl rotate-code</code></p>
    <p><code>ai-host-bridgectl logs ai</code></p>
  </div>
</section>`));
}

const oauthStore = loadOAuthStore();
pruneOAuthStore();
saveOAuthStore();

function resolveWorkspacePath(input = '.') {
  const requested = String(input || '.').replaceAll('\0', '');
  const target = path.resolve(path.isAbsolute(requested) ? requested : path.join(WORKSPACE, requested));
  if (FULL_MACHINE_ACCESS) return target;
  if (target !== WORKSPACE && !target.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return target;
}

function relativePath(target) {
  if (FULL_MACHINE_ACCESS && (target === '/' || !target.startsWith(WORKSPACE + path.sep))) {
    return target;
  }
  const rel = path.relative(WORKSPACE, target);
  return rel || '.';
}

function limitText(value, maxBytes) {
  const source = Buffer.from(String(value), 'utf8');
  if (source.length <= maxBytes) {
    return { value: source.toString('utf8'), truncated: false };
  }
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
      if (entry.isDirectory() && depth < maxDepth) {
        await visit(full, depth + 1);
      }
    }
  }
  await visit(root, 0);
  if (lines.length >= maxEntries) {
    lines.push(`[truncated at ${maxEntries} entries]`);
  }
  return lines.join('\n') || '(empty)';
}

function shellWords(source) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(source)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || [';', '&', '|'].includes(char)) {
      if (current) words.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function isRmCommand(word) {
  return word === 'rm' || word.endsWith('/rm');
}

function isCriticalDeleteTarget(word) {
  const target = String(word).replace(/^--one-file-system$/, '');
  if (!target) return false;
  const normalized = target.replace(/\/+$/g, '') || '/';
  const criticalRoots = new Set([
    '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media',
    '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp',
    '/usr', '/var'
  ]);
  if (criticalRoots.has(normalized)) return true;
  if (/^\/\*+$/.test(target) || /^\/\.\*+$/.test(target)) return true;
  if (/^\/(bin|boot|dev|etc|home|lib|lib64|media|mnt|opt|root|run|sbin|srv|tmp|usr|var)\/\*+$/.test(target)) return true;
  return false;
}

function hasRecursiveRmOptions(words, startIndex) {
  let recursive = false;
  let force = false;
  for (let i = startIndex + 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--') break;
    if (!word.startsWith('-') || word === '-') continue;
    if (word === '--recursive' || word === '-r' || word === '-R') recursive = true;
    if (word === '--force' || word === '-f') force = true;
    if (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(word)) recursive = true;
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(word)) force = true;
    if (word === '--no-preserve-root') return { recursive: true, force: true, noPreserveRoot: true };
  }
  return { recursive, force, noPreserveRoot: false };
}

function assertNoCatastrophicCommand(command) {
  const compact = String(command).replace(/\s+/g, ' ').trim();
  const words = shellWords(command);
  const catastrophic = [
    { re: /(^|[;&|])\s*cd\s+\/\s*([;&|]{1,2})\s*rm\s+-[^;&|]*[rR][^;&|]*\s+(\*|\.\*|--no-preserve-root)(\s|$)/i, reason: 'refusing recursive deletion from filesystem root' },
    { re: /\bfind\s+\/\s+.*\s-delete(\s|$)/i, reason: 'refusing find / -delete' },
    { re: /\bfind\s+\/\s+.*\s-exec\s+rm\b/i, reason: 'refusing find / -exec rm' },
    { re: /\b(mkfs(?:\.[A-Za-z0-9_+-]+)?|wipefs)\b/i, reason: 'refusing filesystem formatting or signature wipe command' },
    { re: /\bdd\b.*\bof=\/dev\/(sd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+)\b/i, reason: 'refusing raw write to disk device' },
    { re: /\b(shred|truncate)\b.*\s\/dev\/(sd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+)\b/i, reason: 'refusing destructive operation on disk device' },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;/, reason: 'refusing fork bomb pattern' }
  ];
  const hit = catastrophic.find((item) => item.re.test(compact));
  if (hit) throw new Error(hit.reason);

  for (let i = 0; i < words.length; i++) {
    if (!isRmCommand(words[i])) continue;
    const options = hasRecursiveRmOptions(words, i);
    for (let j = i + 1; j < words.length; j++) {
      const word = words[j];
      if (word === '--') continue;
      if (word.startsWith('-') && word !== '-') continue;
      if ((options.recursive || options.noPreserveRoot) && isCriticalDeleteTarget(word)) {
        throw new Error(`refusing recursive deletion of critical path: ${word}`);
      }
      if (options.noPreserveRoot) {
        throw new Error('refusing rm --no-preserve-root');
      }
    }
  }
}

function assertAllowedCommand(command) {
  assertNoCatastrophicCommand(command);
  if (FULL_MACHINE_ACCESS) return;
  const compact = String(command).replace(/\s+/g, ' ').trim();
  const blocked = [
    { re: /\b(sudo|su|doas)\b/i, reason: 'privilege escalation is disabled' },
    { re: /\b(systemctl|service|reboot|shutdown|halt|poweroff|init)\b/i, reason: 'system control commands are disabled' },
    { re: /\b(docker|podman|kubectl|iptables|nft|ufw|firewall-cmd)\b/i, reason: 'host administration commands are disabled' },
    { re: /\brm\s+(-[^\s]*[rR][^\s]*[fF]|-[^\s]*[fF][^\s]*[rR])\s+(\/|\$HOME|~)(\s|$)/i, reason: 'dangerous recursive deletion is disabled' },
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

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      const limited = limitText(next, maxBytes);
      return limited.value;
    };

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

  const registerTool = (toolName, definition, handler) => {
    server.registerTool(toolName, definition, async (args, extra) => {
      const startedAt = Date.now();
      logAudit({
        event: 'tool.call.started',
        toolName,
        args: clampForLog(args)
      });
      try {
        const result = await handler(args, extra);
        logAudit({
          event: 'tool.call.finished',
          toolName,
          status: 'ok',
          durationMs: Date.now() - startedAt
        });
        return result;
      } catch (error) {
        logAudit({
          event: 'tool.call.finished',
          toolName,
          status: 'error',
          durationMs: Date.now() - startedAt,
          error: error.message
        });
        logError({ event: 'tool.call.error', toolName, error });
        throw error;
      }
    });
  };

  registerTool('workspace_info', {
    title: 'Workspace Info',
    description: 'Show the sandboxed workspace and available MCP tools.'
  }, async () => jsonText({
    serviceName: DISPLAY_NAME,
    workspace: WORKSPACE,
    fullMachineAccess: FULL_MACHINE_ACCESS,
    policy: FULL_MACHINE_ACCESS ? 'Full machine root access is enabled. Tools can read, write, and run commands across the host.' : 'File tools and shell commands are restricted to this workspace and run as an unprivileged system user.',
    tools: ['workspace_info', 'list_files', 'read_file', 'write_file', 'run_shell'],
    logging: {
      rawAiRequests: LOG_RAW_AI_REQUESTS,
      auditPath: path.join(LOG_DIR, 'audit.jsonl'),
      rawRequestPath: path.join(LOG_DIR, 'ai-requests.jsonl'),
      errorPath: path.join(LOG_DIR, 'errors.jsonl')
    }
  }));

  registerTool('list_files', {
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

  registerTool('read_file', {
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
    const limited = limitText(data.toString('utf8'), maxBytes);
    return text(limited.value);
  });

  registerTool('write_file', {
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
    if (mode === 'append') {
      await fs.appendFile(target, content, 'utf8');
    } else {
      await fs.writeFile(target, content, 'utf8');
    }
    return jsonText({ path: relativePath(target), bytes: Buffer.byteLength(content, 'utf8'), mode });
  });

  registerTool('run_shell', {
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
app.use((req, res, next) => {
  req.requestId = randomUUID();
  const startedAt = Date.now();
  res.on('finish', () => {
    logAudit({
      event: 'http.request',
      ...requestMeta(req, {
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      })
    });
  });
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(hostHeaderValidation(ALLOWED_HOSTS));

app.get('/', (req, res) => renderHomePage(res));

app.get('/admin', (req, res) => renderAdminLogin(res));

app.post('/admin', (req, res) => {
  if ((req.body?.admin_code || '') !== OAUTH_LOGIN_CODE) {
    logAudit({ event: 'admin.login.failed', ...requestMeta(req) });
    return renderAdminLogin(res, 'Invalid access code.');
  }
  logAudit({ event: 'admin.login.ok', ...requestMeta(req) });
  return renderAdminPage(res);
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    name: NAME,
    displayName: DISPLAY_NAME,
    version: VERSION,
    workspace: WORKSPACE,
    logging: {
      enabled: true,
      rawAiRequests: LOG_RAW_AI_REQUESTS,
      logDir: LOG_DIR
    }
  });
});

app.get('/mcp-health', (req, res) => {
  res.json({
    ok: true,
    name: NAME,
    displayName: DISPLAY_NAME,
    version: VERSION,
    workspace: WORKSPACE
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(protectedResourceMetadata());
});

app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json(protectedResourceMetadata());
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(authorizationServerMetadata());
});

app.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    ...authorizationServerMetadata(),
    userinfo_endpoint: `${PUBLIC_BASE_URL}/oauth/userinfo`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: []
  });
});

app.post('/oauth/register', (req, res) => {
  const body = req.body || {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  const clientId = `chatgpt_${randomToken(18)}`;
  oauthStore.clients[clientId] = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: String(body.client_name || 'ChatGPT MCP Connector'),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: String(body.scope || OAUTH_SCOPE)
  };
  saveOAuthStore();
  res.status(201).json(oauthStore.clients[clientId]);
});

app.get('/oauth/authorize', handleAuthorize);
app.post('/oauth/authorize', handleAuthorize);
app.post('/oauth/token', handleToken);

app.get('/oauth/userinfo', (req, res) => {
  const token = requestBearer(req);
  if (!isOAuthToken(token)) {
    res.set('WWW-Authenticate', oauthChallengeHeader());
    return oauthError(res, 401, 'invalid_token', 'Access token is invalid or expired.');
  }
  const entry = oauthTokenEntry(token);
  res.json({ sub: 'ai-host-bridge-root', name: DISPLAY_NAME, client_id: entry?.client_id || '' });
});

app.use(['/mcp', '/sse', '/messages'], requireAuth);

const sessions = new Map();

async function cleanupSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  try { await entry.transport.close(); } catch {}
  try { await entry.server.close(); } catch {}
  logAudit({ event: 'mcp.session.closed', sessionId, transport: entry.type });
}

app.all('/mcp', async (req, res) => {
  const startedAt = Date.now();
  const sessionId = req.headers['mcp-session-id'];
  logAiRequest({
    event: 'ai.request',
    ...requestMeta(req, {
      transport: 'streamable-http',
      authType: req.authContext?.authType || '',
      oauthClientId: req.authContext?.oauthClientId || '',
      jsonrpcMethod: req.body?.method || '',
      jsonrpcId: req.body?.id ?? '',
      body: clampForLog(req.body)
    })
  });
  try {
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
          logAudit({ event: 'mcp.session.opened', ...requestMeta(req, { sessionId: newSessionId, transport: 'streamable-http' }) });
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
    logAudit({
      event: 'mcp.request.finished',
      ...requestMeta(req, {
        transport: 'streamable-http',
        authType: req.authContext?.authType || '',
        oauthClientId: req.authContext?.oauthClientId || '',
        jsonrpcMethod: req.body?.method || '',
        jsonrpcId: req.body?.id ?? '',
        status: res.statusCode >= 400 ? 'error' : 'ok',
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      })
    });
  } catch (error) {
    console.error('MCP request failed:', error);
    logError({ event: 'mcp.request.error', ...requestMeta(req, { transport: 'streamable-http' }), error });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    const server = createServer();
    sessions.set(transport.sessionId, { type: 'sse', transport, server });
    logAudit({ event: 'mcp.session.opened', ...requestMeta(req, { sessionId: transport.sessionId, transport: 'sse' }) });
    transport.onclose = () => cleanupSession(transport.sessionId);
    res.on('close', () => cleanupSession(transport.sessionId));
    await server.connect(transport);
  } catch (error) {
    console.error('SSE connection failed:', error);
    logError({ event: 'sse.connection.error', ...requestMeta(req, { transport: 'sse' }), error });
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

app.post('/messages', async (req, res) => {
  const startedAt = Date.now();
  const sessionId = String(req.query.sessionId || '');
  logAiRequest({
    event: 'ai.request',
    ...requestMeta(req, {
      sessionId,
      transport: 'sse',
      authType: req.authContext?.authType || '',
      oauthClientId: req.authContext?.oauthClientId || '',
      jsonrpcMethod: req.body?.method || '',
      jsonrpcId: req.body?.id ?? '',
      body: clampForLog(req.body)
    })
  });
  try {
    const existing = sessions.get(sessionId);
    if (!existing || existing.type !== 'sse') {
      return res.status(400).send('No SSE transport found for sessionId');
    }
    await existing.transport.handlePostMessage(req, res, req.body);
    logAudit({
      event: 'mcp.request.finished',
      ...requestMeta(req, {
        sessionId,
        transport: 'sse',
        authType: req.authContext?.authType || '',
        oauthClientId: req.authContext?.oauthClientId || '',
        jsonrpcMethod: req.body?.method || '',
        jsonrpcId: req.body?.id ?? '',
        status: res.statusCode >= 400 ? 'error' : 'ok',
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      })
    });
  } catch (error) {
    console.error('SSE message failed:', error);
    logError({ event: 'sse.message.error', ...requestMeta(req, { sessionId, transport: 'sse' }), error });
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

const listener = app.listen(PORT, HOST, () => {
  console.log(`${DISPLAY_NAME} listening on http://${HOST}:${PORT}`);
  logAudit({ event: 'service.started', name: NAME, displayName: DISPLAY_NAME, port: PORT, host: HOST, workspace: WORKSPACE });
});

async function shutdown() {
  listener.close();
  await Promise.all([...sessions.keys()].map((sessionId) => cleanupSession(sessionId)));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

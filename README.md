# AI Host Bridge

AI Host Bridge is a remote MCP server for connecting web AI clients to a server or PC.

## Runtime URLs

- MCP: `https://000339.xyz/mcp`
- SSE: `https://000339.xyz/sse`
- Messages: `https://000339.xyz/messages`
- Admin UI: `https://000339.xyz/admin`
- Health: `https://000339.xyz/mcp-health`

## Quick Install

```bash
tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/Rick-953/ai-host-bridge/main/install.sh -o "$tmp" && sudo bash "$tmp"
```

The installer asks for the public base URL, local port, MCP API key, and OAuth access code.

## Human Operations

Install the CLI on the host as `/usr/local/bin/ai-host-bridgectl`.

```bash
ai-host-bridgectl status
ai-host-bridgectl endpoints
ai-host-bridgectl show-code
ai-host-bridgectl rotate-code
ai-host-bridgectl logs ai
```

The Admin UI uses the current OAuth access code and shows connector URLs, logging status, and common CLI commands.

## Logs

Logs are JSONL files under `/var/log/ai-host-bridge`.

- `audit.jsonl`: HTTP, auth, session, and tool-call audit events.
- `ai-requests.jsonl`: full MCP JSON-RPC request bodies sent by the AI client, with obvious secret fields redacted.
- `errors.jsonl`: service and tool errors.

Set `LOG_RAW_AI_REQUESTS=0` to stop recording full AI request bodies. Set `LOG_MAX_BODY_BYTES` to control body truncation.

## Deployment Notes

The production systemd unit is `ai-host-bridge.service`.

```bash
install -d -m 0755 /opt/ai-host-bridge
cp -a server.js package.json package-lock.json bin systemd deploy /opt/ai-host-bridge/
cp systemd/ai-host-bridge.service /etc/systemd/system/ai-host-bridge.service
cp deploy/ai-host-bridge.logrotate /etc/logrotate.d/ai-host-bridge
cp deploy/ai-host-bridge.env.example /etc/ai-host-bridge.env
systemctl daemon-reload
systemctl enable --now ai-host-bridge
```

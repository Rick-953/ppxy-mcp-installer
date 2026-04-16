# PPXY MCP Installer

One-command Debian installer for a remote MCP server that can be added to Perplexity as a custom connector.

It installs:

- MCP Streamable HTTP endpoint at `/mcp`
- SSE fallback endpoint at `/sse`
- API key authentication
- A sandboxed workspace under `/opt/ppxy-mcp/workspace`
- A `ppxy-mcp` systemd service running as an unprivileged user
- Optional Nginx HTTPS reverse proxy

## Quick Start

Run this on a fresh Debian server:

```bash
tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/Rick-953/ppxy-mcp-installer/main/install.sh -o "$tmp" && sudo bash "$tmp"
```

The installer will ask:

- whether to use a domain, an IP address, or direct HTTP mode
- the domain or public IP
- the local MCP port
- the sandbox workspace path
- the API key, or it can generate one
- the email address for Let's Encrypt notices

## Perplexity Settings

Use the values printed at the end of the installer:

- MCP Server URL: `https://your-domain/mcp`
- Authentication: `API Key`
- API Key: the key printed by the installer
- Transport: `Streamable HTTP`

If Streamable HTTP does not work in your client, use the SSE fallback URL:

- MCP Server URL: `https://your-domain/sse`
- Authentication: `API Key`
- Transport: `SSE`

## Can I Use Only an IP?

Yes, but it still needs HTTPS for Perplexity remote MCP.

The installer supports IP mode by requesting a short-lived Let's Encrypt IP address certificate. Requirements:

- the IP is public
- ports 80 and 443 are reachable from the internet
- no other service blocks Nginx from serving the ACME challenge
- certificate renewal timer remains enabled

IP certificates are short-lived, so the installer creates a systemd timer:

```bash
systemctl status ppxy-mcp-certbot-renew.timer
```

Direct HTTP mode is available for testing or for servers behind another HTTPS proxy, but Perplexity usually rejects plain HTTP remote MCP URLs.

## Manage The Service

```bash
systemctl status ppxy-mcp
journalctl -u ppxy-mcp -f
```

The environment file is:

```bash
/etc/ppxy-mcp/ppxy-mcp.env
```

After changing the API key, port, or workspace:

```bash
sudo systemctl restart ppxy-mcp
```

## Uninstall

```bash
tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/Rick-953/ppxy-mcp-installer/main/install.sh -o "$tmp" && sudo bash "$tmp" --uninstall
```

The uninstall command removes the systemd units and Nginx site link. It leaves `/opt/ppxy-mcp`, `/etc/ppxy-mcp`, `/var/www/ppxy-mcp`, and existing Let's Encrypt certificates in place so data and keys are not destroyed accidentally.

## Security Notes

This MCP server exposes file and shell tools to the AI client. It is intentionally restricted:

- file access is limited to the workspace
- commands run as the `ppxy-mcp` system user
- system administration commands such as `systemctl`, `docker`, `iptables`, and `sudo` are blocked by the tool layer
- the service uses systemd hardening options

Use a strong API key and only add the connector in clients you trust.

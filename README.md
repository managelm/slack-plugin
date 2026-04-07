<p align="center">
  <a href="https://www.managelm.com">
    <img src="https://www.managelm.com/assets/ManageLM.png" alt="ManageLM" height="50">
  </a>
</p>

<h3 align="center">Slack Plugin</h3>

<p align="center">
  Manage Linux &amp; Windows servers and get real-time alerts directly in Slack.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <a href="https://www.managelm.com"><img src="https://img.shields.io/badge/website-managelm.com-cyan" alt="Website"></a>
  <a href="https://www.managelm.com/plugins/slack.html"><img src="https://img.shields.io/badge/docs-full%20documentation-green" alt="Docs"></a>
  <a href="https://github.com/managelm/slack-plugin/releases"><img src="https://img.shields.io/github/v/release/managelm/slack-plugin" alt="Release"></a>
</p>

<p align="center">
  <img src="assets/portal.png" alt="ManageLM Portal — server management, health monitoring, command history" width="700">
</p>

---

Get real-time alerts when agents come online or go offline, when tasks complete or fail, and approve new servers — all without leaving Slack. Run tasks on any managed host with `/managelm` slash commands.

## Features

- **Real-time notifications** — agent enrollment, online/offline, task completed/failed
- **Slash commands** — `/managelm status`, `approve`, `run`, `help`
- **Run task modal** — `/managelm run` opens a form to pick server, skill, and instruction
- **Interactive buttons** — approve agents and view task details inline
- **Channel routing** — send critical alerts to `#ops-alerts`, info to `#ops-general`
- **HMAC verification** — cryptographic signature on every webhook delivery
- **Socket Mode or HTTP** — develop locally with Socket Mode, deploy with HTTP
- **Single port** — Slack events, webhooks, and health check on one HTTP server

## Quick Start

### 1. Create a Slack App

Use the included manifest for quick setup:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App > From an app manifest**
2. Paste the contents of [`manifest.yaml`](manifest.yaml)
3. Replace `<YOUR_HOST>` with your plugin's public URL
4. Install the app to your workspace

### 2. Configure

```bash
cp .env.example .env
```

```bash
# Slack credentials
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret

# ManageLM
MANAGELM_PORTAL_URL=https://app.managelm.com
MANAGELM_API_KEY=mlm_ak_your-key

# Webhook
MANAGELM_WEBHOOK_SECRET=your-webhook-secret
```

### 3. Register webhook

In the ManageLM portal, go to **Settings > Webhooks** and create a webhook pointing to `https://<your-host>:3100/webhook` with the same secret.

### 4. Run

```bash
npm install && npm run build && npm start
```

Or with Docker:

```bash
docker build -t managelm-slack .
docker run --env-file .env -p 3100:3100 managelm-slack
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/managelm status` | List all agents with online/offline status |
| `/managelm approve <hostname>` | Approve a pending agent |
| `/managelm run` | Open a modal to pick server, skill, and instruction |
| `/managelm run <host> <skill> <text>` | Run a task inline |
| `/managelm help` | Show available commands |

## Event Notifications

| Event | Notification |
|-------|--------------|
| `agent.enrolled` | Enrollment request with **Approve** button |
| `agent.approved` | Confirmation that the agent is managed |
| `agent.online` | Agent connected to the portal |
| `agent.offline` | Agent disconnected (routed to alerts channel) |
| `task.completed` | Task summary with **View Details** button |
| `task.failed` | Error with **View Details** button (routed to alerts) |

## Channel Routing

Route critical events to a dedicated alerts channel:

```bash
SLACK_CHANNEL_ALERTS=C0123456789    # agent.offline, task.failed
SLACK_CHANNEL_INFO=C9876543210      # all other events
```

## Security Audits

<p align="center">
  <img src="assets/security-audit.png" alt="ManageLM Security Audit — vulnerability findings with severity levels" width="700">
</p>

Run security audits from Slack and get findings delivered to your channel with severity levels and remediation steps.

## Requirements

- **Node.js 20+**
- **ManageLM account** — [sign up free](https://app.managelm.com/register) (up to 10 agents)
- **Slack workspace** with permission to install apps

## Other Integrations

- [Claude Code Extension](https://github.com/managelm/claude-extension) — MCP integration for Claude
- [VS Code Extension](https://github.com/managelm/vscode-extension) — `@managelm` in Copilot Chat
- [ChatGPT Plugin](https://github.com/managelm/openai-gpt) — manage servers from ChatGPT
- [n8n Plugin](https://github.com/managelm/n8n-plugin) — infrastructure automation workflows
- [OpenClaw Plugin](https://github.com/managelm/openclaw-plugin) — OpenClaw integration

## Links

- [Website](https://www.managelm.com)
- [Full Documentation](https://www.managelm.com/plugins/slack.html)
- [Portal](https://app.managelm.com)

## License

[Apache 2.0](LICENSE)

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

Get real-time alerts for everything that happens in ManageLM (agents, tasks, scans, monitors, backups, certificates, credentials, keystore, pentests, admin sessions) and run tasks, scans and searches on your servers with `/managelm` slash commands, without leaving Slack.

## Features

- **Real-time notifications** — every ManageLM event, with a **View in Portal** link on all but agent approved / online
- **Slash commands** — `status`, `run`, `task`, `answer`, `scan`, `search`, `help`
- **Run task modal** — `/managelm run` opens a form to pick server, skill (or Auto), and instruction
- **Answer from Slack** — reply to a task waiting for input with `/managelm answer`, privately
- **Channel routing** — send warnings and critical events to `#ops-alerts`, the rest to `#ops-general`
- **Access control** — limit the bot to chosen Slack users and channels
- **HMAC verification** — cryptographic signature and freshness check on every webhook delivery
- **Socket Mode or HTTP** — develop locally with Socket Mode, deploy with HTTP
- **Single port** — Slack events, webhooks, and health check share `PORT` (in Socket Mode, Slack events use the socket)

## Quick Start

### 1. Create a Slack App

Use the included manifest for quick setup:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App > From an app manifest**
2. Paste the contents of [`manifest.yaml`](manifest.yaml)
3. Replace `<YOUR_HOST>` with your plugin's public URL
4. Install the app to your workspace

### 2. Create an API key

In the ManageLM portal, go to **Settings > MCP & API > API Keys** and create a key for the bot. The key acts as the user who creates it, limited to the authorizations ticked: add **Reports** to start scans, **Credentials** to search credentials.

> **Warning:** everyone who can use the bot acts with that key's access. Slash commands work in every channel and direct message of the workspace, so unless you set `SLACK_ALLOWED_USERS` or `SLACK_ALLOWED_CHANNELS` (see [Access Control](#access-control)), anyone in the workspace can run tasks on your servers with the rights of the key's owner. Pick the user and the authorizations accordingly.

### 3. Configure

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
# Base of the "View in Portal" links (default: MANAGELM_PORTAL_URL)
MANAGELM_PORTAL_PUBLIC_URL=https://app.managelm.com

# Webhook
MANAGELM_WEBHOOK_SECRET=your-webhook-secret

# HTTP port for /slack/events, /webhook and /health (default: 3100)
PORT=3100

# Who may use the bot (strongly recommended)
SLACK_ALLOWED_USERS=U0123456789,U0987654321
SLACK_ALLOWED_CHANNELS=C0123456789
```

Keep every comment on its own line: `docker run --env-file` keeps an inline comment as part of the value. Leave `SLACK_APP_TOKEN` commented out unless you use Socket Mode, since setting it switches the app to Socket Mode.

### 4. Register webhook

An admin, in the ManageLM portal, goes to **Settings > MCP & API > Webhooks** and creates a webhook pointing to the plugin's `/webhook`, with the event categories to post and the same secret. The plugin serves plain HTTP on `PORT`: use the HTTPS URL of the TLS reverse proxy in front of it (for example `https://slack-bot.example.com/webhook`), or `http://<your-host>:3100/webhook` only when the portal reaches the plugin over a private network. A private address works with a self-hosted portal only (the SaaS portal refuses it), and `localhost` or any other loopback address is always refused.

### 5. Run

From a clone of this repository:

```bash
npm install && npm run build
node --env-file=.env dist/app.js
```

`npm start` does not read `.env`: use the command above (Node.js 20.6+), or export the variables yourself.

Or with Docker, also from a clone:

```bash
docker build -t managelm-slack .
docker run --env-file .env -p 3100:3100 managelm-slack
```

The release tarball holds the compiled app and its dependencies but not the sources, so `npm run build` and `docker build` do not work from it: run `node --env-file=.env dist/app.js` there directly.

In Socket Mode (`SLACK_APP_TOKEN` set, Socket Mode enabled in the Slack app), Slack events arrive over the socket; `/webhook` and `/health` still listen on `PORT`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/managelm status` | List all agents with their status |
| `/managelm run` | Open a modal to pick server, skill, and instruction |
| `/managelm run <host> <skill> <text>` | Run a task inline (`auto` lets the agent pick the skill) |
| `/managelm task <task_id>` | Show a task's status and result |
| `/managelm answer <task_id> <answer>` | Answer a task waiting for input (replies are private) |
| `/managelm scan <host> <security\|inventory\|access\|certificates\|activity>` | Start a scan |
| `/managelm search <kind> [text]` | Search agents, inventory, security, activity, monitors, backups, certificates, pki, credentials |
| `/managelm help` | Show available commands |

Hosts are named by their exact hostname or display name (not case-sensitive). A partial name is never used as a target; the bot lists the hosts it could mean instead. A name with spaces, or one shared by several servers, is picked in the run form.

A task still running after 100 seconds is reported as such, with the command to check it later. Results of the run form go to the info channel (or the alerts channel), or to you as a direct message from the app when neither is set or the app cannot post there. When the bot gets no confirmation for an answer (timeout, portal or proxy error), it may still have been delivered: check with `/managelm task <task_id>`. Approving agents and other portal settings are done in the portal.

## Event Notifications

| Category | Events |
|----------|--------|
| Agent | `agent.enrolled` (with a **Review in Portal** link), `agent.approved`, `agent.online`, `agent.offline` |
| Task | `task.completed`, `task.failed`, `task.needs_input`, each with **View Details** |
| Report | `report.completed`, `report.failed`, `report.stalled` |
| Monitor | `monitor.down`, `monitor.up`, `monitor.stalled`, `monitor.created`, `monitor.deleted` |
| Backup | `backup.completed`, `backup.failed` |
| Certificate | `cert.issued`, `cert.renewed`, `cert.renewal_failed`, `cert.revoked`, `cert.reactivated`, `cert.deleted` |
| Credential | `credential.rotated`, `credential.rotation_failed` |
| Keystore | `keystore.access_denied`, `keystore.key_deleted` |
| Pentest | `pentest.completed`, `pentest.failed` |
| Sessions | `console.opened`, `console.closed`, `desktop.opened`, `desktop.closed`, `files.opened` |
| Schedule | `schedule.report` (what each agent reported), `schedule.failed` |

## Channel Routing

Route warnings and critical events (the ones the portal itself flags: agent offline, task failed, monitor down, backup or rotation failed, certificate renewal failed, keystore refusals, admin sessions opened, schedule reports and failures, ...) to a dedicated alerts channel:

```bash
# Warnings and critical events
SLACK_CHANNEL_ALERTS=C0123456789
# All other events
SLACK_CHANNEL_INFO=C9876543210
```

With only one set, every event goes there. Invite the app to these channels so it can post.

## Access Control

The bot runs everything with the API key's access. Without the two settings below, anyone in the Slack workspace can use `/managelm` — run tasks, answer them, start scans, search — with the rights of the key's owner.

```bash
# Slack user IDs allowed to use the bot
SLACK_ALLOWED_USERS=U0123456789,U0987654321
# Channel IDs where commands, the run form and buttons are accepted
SLACK_ALLOWED_CHANNELS=C0123456789,C9876543210
```

When a list is set, slash commands, run form submissions and buttons from a user or channel outside it are refused. With both set, both must match.

The **View Details** button on task notifications is checked like a command, against both lists: add the channels that receive notifications to `SLACK_ALLOWED_CHANNELS` for it to work there. Allowing a channel lets everyone in it use `/managelm` too, unless `SLACK_ALLOWED_USERS` narrows who.

## Troubleshooting

**Deliveries refused, then the webhook disabled.** Each delivery carries its send time, and the plugin refuses one more than 5 minutes away from its own clock (the webhook shows **Last: 401** in the portal, and the plugin answers `Missing or expired timestamp`). The portal counts every refusal as a failed delivery and disables the webhook after repeated failures, so keep this host's clock synchronized (NTP), then re-enable the webhook in the portal. A delivery received twice is answered but posted once.

## Security Audits

<p align="center">
  <img src="assets/security-audit.png" alt="ManageLM Security Audit — vulnerability findings with severity levels" width="700">
</p>

Start security audits with `/managelm scan <host> security`, get the report event in your channel, and list findings with `/managelm search security`.

## Requirements

- **Node.js 20.6+**
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

# ManageLM — Slack Plugin

Manage your Linux servers directly from Slack. Get real-time alerts when
agents come online or go offline, when tasks complete or fail, and approve
new servers — all without leaving your workspace.

ManageLM connects Slack to your infrastructure through the same portal API
used by the Claude extension and n8n integration. Ask ManageLM to check
agent status, approve pending servers, or run tasks on any managed host.

## Features

- **Real-time notifications** — agent enrollment, online/offline, task completed/failed
- **Slash commands** — `/managelm status`, `approve`, `run`, `help`
- **Interactive buttons** — approve agents and view task details inline
- **Channel routing** — send alerts to `#ops-alerts` and info to `#ops-general`
- **HMAC verification** — cryptographic signature on every webhook delivery
- **Socket Mode or HTTP** — develop locally with Socket Mode, deploy with HTTP

## Architecture

```
ManageLM Portal ── webhook (HMAC) ──> Slack Plugin ──> Slack API
                                       :3101/webhook    (notifications)

Slack Users ── /managelm ──> Slack Plugin ──> ManageLM Portal API
                              :3100           (status, approve, run tasks)
```

The plugin runs two lightweight HTTP servers:

| Port | Purpose |
|------|---------|
| 3100 | Slack Bolt app — slash commands, interactive buttons |
| 3101 | ManageLM webhook receiver — event notifications |

## Setup

### 1. Create a Slack App

**Quick method — use the manifest:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App > From an app manifest**
2. Select your workspace
3. Paste the contents of [`manifest.yaml`](manifest.yaml) from this repo
4. Replace `<YOUR_HOST>` with your plugin's public URL
5. Click **Create**

**Manual method** (if you prefer):

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App > From scratch**
2. Name it **ManageLM** and select your workspace
3. Under **OAuth & Permissions**, add bot scopes: `chat:write`, `commands`
4. Under **Slash Commands**, create `/managelm` with Request URL `https://<your-host>:3100/slack/events`
5. Under **Interactivity**, enable and set Request URL to `https://<your-host>:3100/slack/events`

**After creating the app:**

1. **Install** the app to your workspace
2. Copy the **Bot User OAuth Token** (`xoxb-...`) from OAuth & Permissions
3. Copy the **Signing Secret** from Basic Information

**Socket Mode** (optional, easier for development):

- Enable Socket Mode in the app settings
- Generate an **App-Level Token** with the `connections:write` scope (`xapp-...`)

### 2. Create a ManageLM API Key

1. In the ManageLM portal, go to **Settings > API Keys**
2. Create a new key with the **agents** permission
3. Copy the key (`mlm_ak_...`)

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Slack credentials
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token          # only for Socket Mode

# ManageLM
MANAGELM_PORTAL_URL=https://app.managelm.com
MANAGELM_API_KEY=mlm_ak_your-key

# Webhook
MANAGELM_WEBHOOK_SECRET=your-webhook-secret  # must match portal webhook config
PORT=3100

# Channel routing (optional)
SLACK_CHANNEL_ALERTS=C0123456789             # agent.offline, task.failed
SLACK_CHANNEL_INFO=C9876543210               # all other events
```

### 4. Register the Webhook in ManageLM

In the ManageLM portal, go to **Settings > Webhooks** and create a webhook:

| Field | Value |
|-------|-------|
| URL | `https://<your-host>:3101/webhook` |
| Events | Select all events you want notifications for |
| Secret | Same value as `MANAGELM_WEBHOOK_SECRET` in your `.env` |

The portal signs every delivery with HMAC-SHA256 using this secret.
The plugin verifies the `X-Webhook-Signature` header before processing.

### 5. Run

**Local development:**

```bash
npm install
npm run build
npm start
```

**Docker:**

```bash
docker build -t managelm-slack .
docker run --env-file .env -p 3100:3100 -p 3101:3101 managelm-slack
```

**Docker Compose:**

```yaml
services:
  managelm-slack:
    build: .
    env_file: .env
    ports:
      - "3100:3100"
      - "3101:3101"
    restart: unless-stopped
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/managelm status` | List all agents with online/offline status |
| `/managelm approve <hostname>` | Approve a pending agent |
| `/managelm run <hostname> <skill> <instruction>` | Run a task on an agent |
| `/managelm help` | Show available commands |

### Examples

```
/managelm status
/managelm approve web-prod-03
/managelm run web-prod-01 packages List outdated packages
/managelm run db-master security Run a full security audit
/managelm run lb-01 services Restart nginx
```

The `run` command works exactly like submitting a task from Claude or the
portal UI — it sends the instruction to the agent, waits for the result,
and posts it back to the channel.

## Event Notifications

When a ManageLM webhook event fires, the plugin posts a rich Block Kit
message to the configured Slack channel:

| Event | Notification |
|-------|--------------|
| `agent.enrolled` | Enrollment request with an **Approve** button |
| `agent.approved` | Confirmation that the agent is now managed |
| `agent.online` | Agent connected to the portal |
| `agent.offline` | Agent disconnected (routed to alerts channel) |
| `task.completed` | Task summary with a **View Details** button |
| `task.failed` | Error message with a **View Details** button (routed to alerts channel) |

### Interactive Buttons

- **Approve** — directly approve a pending agent from the Slack message
- **View Details** — fetch full task output and display it in an ephemeral message
- **View in Portal** — open the ManageLM portal in your browser

## Channel Routing

Route critical events to a dedicated alerts channel:

```bash
SLACK_CHANNEL_ALERTS=C0123456789    # receives: agent.offline, task.failed
SLACK_CHANNEL_INFO=C9876543210      # receives: all other events
```

If neither variable is set, events are posted to the bot's default
conversation channel. You can also invite the bot to specific channels and
events will be posted there.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app signing secret |
| `SLACK_APP_TOKEN` | No | App-level token for Socket Mode (`xapp-...`) |
| `MANAGELM_PORTAL_URL` | Yes | ManageLM portal URL |
| `MANAGELM_API_KEY` | Yes | ManageLM API key (`mlm_ak_...`) |
| `MANAGELM_WEBHOOK_SECRET` | No | HMAC secret for webhook verification |
| `MANAGELM_PORTAL_PUBLIC_URL` | No | Public URL for "View in Portal" links (defaults to `MANAGELM_PORTAL_URL`) |
| `PORT` | No | Bolt app port (default: `3100`, webhook runs on `PORT+1`) |
| `SLACK_CHANNEL_ALERTS` | No | Channel ID for alert events |
| `SLACK_CHANNEL_INFO` | No | Channel ID for informational events |

## Project Structure

```
src/
  app.ts          — entry point: Bolt app + webhook HTTP server
  config.ts       — environment variable loading and validation
  managelm.ts     — typed HTTP client for the ManageLM portal API
  formatters.ts   — Block Kit message builders for each event type
  handlers.ts     — slash command and button action handlers
```

## Requirements

- **Node.js 20+**
- **ManageLM Portal** with API keys enabled ([managelm.com](https://www.managelm.com))
- **Slack workspace** with permission to install apps

## Distribution

To let other people install ManageLM into their own Slack workspaces:

### Enable public distribution

1. Go to your app at [api.slack.com/apps](https://api.slack.com/apps)
2. Navigate to **Settings > Manage Distribution**
3. Complete the checklist (app icon, description, etc.)
4. Click **Activate Public Distribution**

### Share the install link

Once activated, Slack gives you a **Sharable URL** like:

```
https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&scope=chat:write,commands
```

You can also use Slack's official **"Add to Slack"** button. Add this HTML
to your website or documentation:

```html
<a href="https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&scope=chat:write,commands&user_scope=">
  <img alt="Add to Slack" height="40" width="139"
       src="https://platform.slack-edge.com/img/add_to_slack.png"
       srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x,
               https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" />
</a>
```

Replace `YOUR_CLIENT_ID` with your app's Client ID from Basic Information.

### What the user does after clicking

1. Clicks "Add to Slack" and authorizes the app for their workspace
2. Copies the **Bot Token** and **Signing Secret** from their new app
3. Creates a ManageLM API key in their portal
4. Runs the plugin with their credentials (Docker or Node.js)
5. Registers the webhook URL in their ManageLM portal

### Tip: include in ManageLM docs

Add the "Add to Slack" button to your documentation page alongside the
existing n8n and Claude plugin install instructions. Self-hosted users
follow the same setup — they just point `MANAGELM_PORTAL_URL` at their
own instance.

## Links

- [ManageLM Website](https://www.managelm.com)
- [Documentation](https://www.managelm.com/doc/)
- [GitHub](https://github.com/managelm/slack-plugin)

## License

[MIT](LICENSE)

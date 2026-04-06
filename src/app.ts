/**
 * ManageLM Slack Plugin — main entry point.
 *
 * Runs a Slack Bolt app that:
 * 1. Receives ManageLM webhook events and posts rich notifications to Slack.
 * 2. Provides /managelm slash commands for status, approve, run, help.
 * 3. Handles interactive buttons (approve agent, view task details).
 *
 * Supports two modes:
 * - Socket Mode (recommended for development): set SLACK_APP_TOKEN
 * - HTTP Mode (production): receives Slack events + ManageLM webhooks on PORT
 *
 * ManageLM webhook receiver runs on the same HTTP server at /webhook.
 */

import { App, LogLevel } from '@slack/bolt';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import { config, useSocketMode } from './config.js';
import { registerCommands, registerActions } from './handlers.js';
import { formatWebhookEvent, routeEventToChannel, type WebhookPayload } from './formatters.js';

// ─── Slack Bolt app ──────────────────────────────────────────────────

const app = new App({
  token: config.slackBotToken,
  signingSecret: config.slackSigningSecret,
  ...(useSocketMode
    ? { socketMode: true, appToken: config.slackAppToken }
    : {}),
  logLevel: LogLevel.INFO,
});

// Register slash commands and button actions
registerCommands(app);
registerActions(app);

// ─── ManageLM webhook receiver ───────────────────────────────────────

/** Slack Block Kit text limit — truncate before sending. */
const SLACK_TEXT_LIMIT = 2900;

/**
 * Verify HMAC-SHA256 signature from ManageLM webhook.
 * The portal signs the JSON body with the webhook secret.
 */
function verifyHmac(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Maximum retries for Slack API rate limits. */
const MAX_RETRIES = 3;

/**
 * Post a ManageLM event to the appropriate Slack channel.
 * Retries on Slack rate limits (429) with Retry-After header.
 */
async function postEventToSlack(payload: WebhookPayload, fallbackChannel?: string): Promise<void> {
  const message = formatWebhookEvent(payload);
  if (!message) {
    console.warn(`[webhook] Unknown event type: ${payload.event}`);
    return;
  }

  const channel = routeEventToChannel(payload.event) || fallbackChannel;
  if (!channel) {
    console.warn(`[webhook] No channel configured for event: ${payload.event}`);
    return;
  }

  // Truncate text blocks to stay within Slack limits
  const blocks = message.blocks.map(block => {
    if (block.type === 'section' && 'text' in block && block.text && 'text' in block.text) {
      const txt = block.text.text;
      if (txt.length > SLACK_TEXT_LIMIT) {
        return { ...block, text: { ...block.text, text: txt.slice(0, SLACK_TEXT_LIMIT) + '\n…_(truncated)_' } };
      }
    }
    return block;
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await app.client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: message.text,
        blocks,
      });
      return; // Success
    } catch (err: unknown) {
      const slackErr = err as { data?: { error?: string }; retryAfter?: number };
      if (slackErr.data?.error === 'ratelimited' && attempt < MAX_RETRIES) {
        const delay = (slackErr.retryAfter ?? 1) * 1000;
        console.warn(`[webhook] Slack rate limited — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Log but don't throw — webhook should still return 200
      console.error(`[webhook] Failed to post to Slack (channel=${channel}, event=${payload.event}):`, err);
      return;
    }
  }
}

// ─── HTTP webhook server (handles ManageLM POST /webhook) ────────────

// Webhook secret — REQUIRED for security. Rejects unsigned requests.
const webhookSecret = process.env.MANAGELM_WEBHOOK_SECRET || '';
if (!webhookSecret) {
  console.warn('[webhook] WARNING: MANAGELM_WEBHOOK_SECRET is not set — webhook endpoint will reject all requests.');
  console.warn('[webhook] Set MANAGELM_WEBHOOK_SECRET to the secret from your ManageLM webhook configuration.');
}

function startWebhookServer(): void {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'managelm-slack' }));
      return;
    }

    // ManageLM webhook endpoint
    if (req.method === 'POST' && req.url === '/webhook') {
      // Reject early if no secret configured
      if (!webhookSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let oversized = false;
      const MAX_BODY = 512 * 1024;  // 512 KB
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) { oversized = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (oversized) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          // Always verify HMAC signature
          const signature = req.headers['x-webhook-signature'] as string | undefined;
          if (!verifyHmac(body, signature, webhookSecret)) {
            console.warn('[webhook] Invalid HMAC signature');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid signature' }));
            return;
          }

          const payload = JSON.parse(body) as WebhookPayload;
          if (!payload.event || !payload.data) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing event or data fields' }));
            return;
          }
          console.log(`[webhook] Received event: ${payload.event}`);

          // Determine fallback channel from env
          const fallbackChannel = config.channelAlerts || config.channelInfo || '';

          await postEventToSlack(payload, fallbackChannel);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('[webhook] Error processing webhook:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal error' }));
        }
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const webhookPort = config.port + 1;  // Webhook listener on port+1
  server.listen(webhookPort, () => {
    console.log(`[webhook] ManageLM webhook receiver listening on port ${webhookPort}`);
    console.log(`[webhook] Register this URL in ManageLM: http://<this-host>:${webhookPort}/webhook`);
  });
}

// ─── Startup ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start the Bolt app
  await app.start(config.port);
  console.log(`[slack] ManageLM Slack plugin running on port ${config.port}`);
  console.log(`[slack] Mode: ${useSocketMode ? 'Socket Mode' : 'HTTP'}`);
  console.log(`[slack] Portal: ${config.portalUrl}`);

  // Start the webhook receiver alongside the Bolt app
  startWebhookServer();
}

main().catch((err) => {
  console.error('Failed to start ManageLM Slack plugin:', err);
  process.exit(1);
});

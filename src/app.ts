/**
 * ManageLM Slack Plugin — main entry point.
 *
 * Single-port architecture: Bolt handles Slack events, slash commands,
 * interactive actions, and ManageLM webhook delivery on one HTTP server.
 *
 * Routes:
 *   /slack/events   — Slack events + commands + interactivity (Bolt)
 *   /webhook        — ManageLM webhook receiver (HMAC-verified)
 *   /health         — Health check
 *
 * Supports two modes:
 * - Socket Mode (development): set SLACK_APP_TOKEN — webhooks still need HTTP
 * - HTTP Mode (production): everything on PORT
 */

import { App, LogLevel } from '@slack/bolt';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { config, useSocketMode } from './config.js';
import { registerCommands, registerActions, registerModals } from './handlers.js';
import { formatWebhookEvent, routeEventToChannel, type WebhookPayload } from './formatters.js';

// ─── Webhook secret (required) ──────────────────────────────────────

const webhookSecret = process.env.MANAGELM_WEBHOOK_SECRET || '';
if (!webhookSecret) {
  console.warn('[webhook] WARNING: MANAGELM_WEBHOOK_SECRET is not set — /webhook will reject all requests.');
}

// ─── HMAC verification ──────────────────────────────────────────────

function verifyHmac(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Slack posting with retry ───────────────────────────────────────

/** Slack Block Kit text limit — truncate before sending. */
const SLACK_TEXT_LIMIT = 2900;
const MAX_RETRIES = 3;

/** Reference to the Bolt app — set after creation. */
let appRef: App;

/**
 * Post a ManageLM event to the appropriate Slack channel.
 * Retries on Slack rate limits (429) with Retry-After header.
 */
export async function postEventToSlack(payload: WebhookPayload, fallbackChannel?: string): Promise<void> {
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
      await appRef.client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: message.text,
        blocks,
      });
      return;
    } catch (err: unknown) {
      const slackErr = err as { data?: { error?: string }; retryAfter?: number };
      if (slackErr.data?.error === 'ratelimited' && attempt < MAX_RETRIES) {
        const delay = (slackErr.retryAfter ?? 1) * 1000;
        console.warn(`[webhook] Slack rate limited — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error(`[webhook] Failed to post to Slack (channel=${channel}, event=${payload.event}):`, err);
      return;
    }
  }
}

// ─── Custom route handlers (mounted on Bolt's HTTP server) ──────────

/** POST /webhook — ManageLM webhook receiver. */
function webhookHandler(req: IncomingMessage, res: ServerResponse): void {
  if (!webhookSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = 512 * 1024;

  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(chunk);
  });

  // Wrap async processing to catch unhandled rejections
  req.on('end', () => {
    processWebhookBody(req, res, chunks, size > MAX_BODY).catch((err) => {
      console.error('[webhook] Unhandled error in webhook processing:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });
}

/** Process the collected webhook body chunks. Extracted to an async function
 *  so unhandled rejections are properly caught by the caller. */
async function processWebhookBody(
  req: IncomingMessage, res: ServerResponse, chunks: Buffer[], oversized: boolean,
): Promise<void> {
  if (oversized) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload too large' }));
    return;
  }
  const body = Buffer.concat(chunks).toString('utf-8');

  const signature = req.headers['x-webhook-signature'] as string | undefined;
  if (!verifyHmac(body, signature, webhookSecret)) {
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

  const fallbackChannel = config.channelAlerts || config.channelInfo || '';
  await postEventToSlack(payload, fallbackChannel);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/** GET /health — Health check. */
function healthHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'managelm-slack' }));
}

// ─── Bolt app with custom routes ────────────────────────────────────

const app = new App({
  token: config.slackBotToken,
  signingSecret: config.slackSigningSecret,
  ...(useSocketMode
    ? { socketMode: true, appToken: config.slackAppToken }
    : {}),
  logLevel: LogLevel.INFO,
  customRoutes: [
    { path: '/webhook', method: 'POST', handler: webhookHandler },
    { path: '/health', method: 'GET', handler: healthHandler },
  ],
});
appRef = app;

// Register slash commands, button actions, and modal handlers
registerCommands(app);
registerActions(app);
registerModals(app);

// ─── Startup ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await app.start(config.port);
  console.log(`[slack] ManageLM Slack plugin running on port ${config.port}`);
  console.log(`[slack] Mode: ${useSocketMode ? 'Socket Mode' : 'HTTP'}`);
  console.log(`[slack] Portal: ${config.portalUrl}`);
  console.log(`[slack] Webhook: http://<this-host>:${config.port}/webhook`);
}

main().catch((err) => {
  console.error('Failed to start ManageLM Slack plugin:', err);
  process.exit(1);
});

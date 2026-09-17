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
 * - Socket Mode (development): set SLACK_APP_TOKEN — Slack events arrive over
 *   the socket; /webhook and /health still listen on PORT
 * - HTTP Mode (production): everything on PORT
 */

import { App, LogLevel } from '@slack/bolt';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { config, useSocketMode } from './config.js';
import { registerCommands, registerActions, registerModals } from './handlers.js';
import { formatWebhookEvent, routeEventToChannel, truncate, type WebhookPayload } from './formatters.js';

// ─── Webhook secret (required) ──────────────────────────────────────

const webhookSecret = process.env.MANAGELM_WEBHOOK_SECRET || '';
if (!webhookSecret) {
  console.warn('[webhook] WARNING: MANAGELM_WEBHOOK_SECRET is not set — /webhook will reject all requests.');
}

if (config.allowedUsers.length === 0 && config.allowedChannels.length === 0) {
  console.warn('[slack] WARNING: SLACK_ALLOWED_USERS and SLACK_ALLOWED_CHANNELS are not set — anyone in the '
    + 'Slack workspace can use /managelm with the rights of the API key owner.');
}

// ─── Webhook verification ───────────────────────────────────────────

/** Largest webhook body accepted. Portal events are a few KB. */
const MAX_BODY = 512 * 1024;

/**
 * How far a delivery's `timestamp` may sit from this clock, either way. The
 * portal resends the same body within ~15 s when a delivery fails; a body
 * older than this is a replay, not a retry.
 */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Check X-Webhook-Signature: hex HMAC-SHA256 of the raw body. Compared as
 * bytes with a length check first, so a header of the right character count
 * but a different byte length (non-ASCII) is a mismatch, never an exception.
 */
function verifyHmac(body: Buffer, signature: string, secret: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'utf-8');
  const given = Buffer.from(signature, 'utf-8');
  if (given.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(given, expected);
}

/** True when an ISO timestamp is within REPLAY_WINDOW_MS of now. */
function isFresh(timestamp: unknown): boolean {
  if (typeof timestamp !== 'string') return false;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && Math.abs(Date.now() - time) <= REPLAY_WINDOW_MS;
}

// ─── Slack posting ──────────────────────────────────────────────────

/**
 * Post a ManageLM event to the appropriate Slack channel.
 * Slack rate limits (429) need no handling here: the Web API client waits out
 * Retry-After and resends by itself.
 * The Bolt app is passed in explicitly (no mutable module global).
 */
export async function postEventToSlack(app: App, payload: WebhookPayload, fallbackChannel?: string): Promise<void> {
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
  const blocks = message.blocks.map(block =>
    block.type === 'section' && block.text
      ? { ...block, text: { ...block.text, text: truncate(block.text.text) } }
      : block,
  );

  try {
    await app.client.chat.postMessage({
      token: config.slackBotToken,
      channel,
      text: message.text,
      blocks,
    });
  } catch (err: unknown) {
    console.error(`[webhook] Failed to post to Slack (channel=${channel}, event=${payload.event}):`, err);
  }
}

// ─── Custom route handlers (mounted on Bolt's HTTP server) ──────────

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** POST /webhook — ManageLM webhook receiver. */
function webhookHandler(req: IncomingMessage, res: ServerResponse): void {
  if (!webhookSecret) {
    reply(res, 503, { error: 'Webhook secret not configured' });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  req.on('data', (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      // Answer now rather than on 'end', which would mean reading the rest of
      // an arbitrarily large body; close the connection once the 413 is out.
      tooLarge = true;
      chunks.length = 0;
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Payload too large' }), () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (!tooLarge) handleWebhookBody(req, res, Buffer.concat(chunks));
  });
}

/** Verify a complete webhook body, answer the portal, then post to Slack. */
function handleWebhookBody(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const signature = req.headers['x-webhook-signature'];
  if (typeof signature !== 'string' || !verifyHmac(body, signature, webhookSecret)) {
    reply(res, 401, { error: 'Invalid signature' });
    return;
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body.toString('utf-8')) as WebhookPayload;
  } catch {
    reply(res, 400, { error: 'Invalid JSON' });
    return;
  }
  if (!payload || typeof payload.event !== 'string' || !payload.data || typeof payload.data !== 'object') {
    reply(res, 400, { error: 'Missing event or data fields' });
    return;
  }

  // The timestamp is inside the signed body, so it cannot be refreshed
  // without the secret.
  if (!isFresh(payload.timestamp)) {
    reply(res, 401, { error: 'Missing or expired timestamp' });
    return;
  }

  console.log(`[webhook] Received event: ${payload.event}`);

  // Answer before posting. Posting can take long — the Slack client waits out
  // rate limits — and the portal gives up on a delivery after 10 s and sends
  // it again, which would duplicate the message and count as a failure toward
  // disabling the webhook.
  reply(res, 200, { ok: true });

  const fallbackChannel = config.channelAlerts || config.channelInfo || '';
  postEventToSlack(app, payload, fallbackChannel).catch((err) => {
    console.error('[webhook] Unhandled error while posting to Slack:', err);
  });
}

/** GET /health — Health check. */
function healthHandler(_req: IncomingMessage, res: ServerResponse): void {
  reply(res, 200, { status: 'ok', service: 'managelm-slack' });
}

// ─── Bolt app with custom routes ────────────────────────────────────

const app = new App({
  token: config.slackBotToken,
  signingSecret: config.slackSigningSecret,
  ...(useSocketMode
    ? { socketMode: true, appToken: config.slackAppToken }
    : {}),
  // In Socket Mode, Bolt serves the custom routes on their own HTTP server and
  // takes its port from here (app.start's argument is ignored there); without
  // it they would listen on 3000 whatever PORT says.
  port: config.port,
  logLevel: LogLevel.INFO,
  customRoutes: [
    { path: '/webhook', method: 'POST', handler: webhookHandler },
    { path: '/health', method: 'GET', handler: healthHandler },
  ],
});

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

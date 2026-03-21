/**
 * Centralized configuration — loaded from environment variables.
 * All required vars are validated at startup.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  // Slack
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackSigningSecret: required('SLACK_SIGNING_SECRET'),
  slackAppToken: process.env.SLACK_APP_TOKEN || '',  // Only needed for socket mode

  // ManageLM
  portalUrl: (process.env.MANAGELM_PORTAL_URL || 'https://app.managelm.com').replace(/\/+$/, ''),
  apiKey: required('MANAGELM_API_KEY'),
  portalPublicUrl: (process.env.MANAGELM_PORTAL_PUBLIC_URL || process.env.MANAGELM_PORTAL_URL || 'https://app.managelm.com').replace(/\/+$/, ''),

  // Server
  port: parseInt(process.env.PORT || '3100', 10),

  // Channel routing (optional)
  channelAlerts: process.env.SLACK_CHANNEL_ALERTS || '',
  channelInfo: process.env.SLACK_CHANNEL_INFO || '',
};

/** True if socket mode is available (has app-level token). */
export const useSocketMode = !!config.slackAppToken;

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

/** A comma-separated list of Slack IDs; empty when unset. */
function idList(name: string): string[] {
  return (process.env[name] || '').split(',').map(id => id.trim()).filter(Boolean);
}

export const config = {
  // Slack
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackSigningSecret: required('SLACK_SIGNING_SECRET'),
  slackAppToken: process.env.SLACK_APP_TOKEN || '',  // Only needed for socket mode

  // Access control (optional). The API key acts with its owner's rights for
  // whoever uses the bot; these narrow who that is. An empty list allows all.
  allowedUsers: idList('SLACK_ALLOWED_USERS'),
  allowedChannels: idList('SLACK_ALLOWED_CHANNELS'),

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

/**
 * Whether a Slack user, in a channel, may use the bot: slash commands, the run
 * modal and message buttons all ask. Each list is checked only when it is set.
 */
export function isAllowed(userId: string | undefined, channelId: string | undefined): boolean {
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId ?? '')) return false;
  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(channelId ?? '')) return false;
  return true;
}

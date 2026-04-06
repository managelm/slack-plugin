/**
 * Slack Block Kit message formatters for ManageLM webhook events.
 * Each event type produces a rich, actionable Slack message.
 */

import type { KnownBlock } from '@slack/types';
import type { Button } from '@slack/types/dist/block-kit/block-elements';
import { config } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface FormattedMessage {
  text: string;            // Fallback for notifications
  blocks: KnownBlock[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case 'online':    return ':large_green_circle:';
    case 'offline':   return ':red_circle:';
    case 'pending':   return ':yellow_circle:';
    case 'completed':   return ':white_check_mark:';
    case 'failed':      return ':x:';
    case 'needs_input': return ':question:';
    case 'answered':    return ':speech_balloon:';
    default:            return ':grey_question:';
  }
}

function agentLabel(data: Record<string, unknown>): string {
  const name = (data.display_name || data.hostname || data.agent_id || 'unknown') as string;
  return `\`${name}\``;
}

function timestamp(iso: string): string {
  const epoch = Math.floor(new Date(iso).getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${iso}>`;
}

function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): Button {
  const btn: Button = {
    type: 'button',
    text: { type: 'plain_text', text },
    action_id: actionId,
    value,
  };
  if (style) btn.style = style;
  return btn;
}

function linkButton(text: string, url: string): Button {
  return {
    type: 'button',
    text: { type: 'plain_text', text },
    url,
    action_id: `link_${Date.now()}`,
  };
}

// ─── Event formatters ────────────────────────────────────────────────

function agentEnrolled(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const agentId = data.agent_id as string;
  return {
    text: `New server ${label} is requesting enrollment`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:new: *Agent Enrollment Request*\nServer ${label} is requesting to join your infrastructure.\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          button('Approve', 'approve_agent', agentId, 'primary'),
          linkButton('View in Portal', `${config.portalPublicUrl}/agents`),
        ],
      },
    ],
  };
}

function agentApproved(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  return {
    text: `Server ${label} has been approved`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *Agent Approved*\nServer ${label} is now managed and ready to receive tasks.\n${timestamp(ts)}`,
        },
      },
    ],
  };
}

function agentOnline(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  return {
    text: `Server ${label} is online`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('online')} *Agent Online*\nServer ${label} connected.\n${timestamp(ts)}`,
        },
      },
    ],
  };
}

function agentOffline(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  return {
    text: `Server ${label} went OFFLINE`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('offline')} *Agent Offline*\nServer ${label} has disconnected.\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          linkButton('View in Portal', `${config.portalPublicUrl}/agents`),
        ],
      },
    ],
  };
}

function taskCompleted(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const taskId = data.task_id as string;
  const skill = (data.skill_slug || 'unknown') as string;
  const summary = (data.summary || '') as string;
  const mutating = data.mutating as boolean;

  let detail = `*Skill:* ${skill}`;
  if (summary) detail += `\n*Summary:* ${summary}`;
  if (mutating) detail += '\n:warning: _This task made changes to the server._';

  return {
    text: `Task completed on ${label}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('completed')} *Task Completed* on ${label}\n${detail}\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          button('View Details', 'view_task', taskId),
          linkButton('View in Portal', `${config.portalPublicUrl}/logs`),
        ],
      },
    ],
  };
}

function taskFailed(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const taskId = data.task_id as string;
  const skill = (data.skill_slug || 'unknown') as string;
  const error = (data.error_message || 'Unknown error') as string;

  return {
    text: `Task FAILED on ${label}: ${error}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('failed')} *Task Failed* on ${label}\n*Skill:* ${skill}\n*Error:* ${error}\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          button('View Details', 'view_task', taskId),
          linkButton('View in Portal', `${config.portalPublicUrl}/logs`),
        ],
      },
    ],
  };
}

function taskNeedsInput(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const taskId = data.task_id as string;
  const skill = (data.skill_slug || 'unknown') as string;
  const question = (data.question || 'The agent needs more information.') as string;

  return {
    text: `Task on ${label} needs input: ${question}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('needs_input')} *Task Needs Input* on ${label}\n*Skill:* ${skill}\n*Question:* ${question}\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          button('View Details', 'view_task', taskId),
          linkButton('Answer in Portal', `${config.portalPublicUrl}/logs`),
        ],
      },
    ],
  };
}

function reportCompleted(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const reportType = (data.report_type || 'report') as string;
  const score = data.score as number | null;
  const findingsCount = (data.findings_count || 0) as number;

  let detail = '';
  if (score != null) detail += `*Score:* ${score}/100\n`;
  if (findingsCount > 0) detail += `*Findings:* ${findingsCount} issue${findingsCount !== 1 ? 's' : ''}`;
  else detail += '*Findings:* No issues found';

  return {
    text: `${reportType} completed on ${label} — score ${score ?? '?'}/100`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Completed* on ${label}\n${detail}\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          linkButton('View in Portal', `${config.portalPublicUrl}/pentests`),
        ],
      },
    ],
  };
}

function reportFailed(data: Record<string, unknown>, ts: string): FormattedMessage {
  const label = agentLabel(data);
  const reportType = (data.report_type || 'report') as string;

  return {
    text: `${reportType} FAILED on ${label}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji('failed')} *${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Failed* on ${label}\n${timestamp(ts)}`,
        },
      },
      {
        type: 'actions',
        elements: [
          linkButton('View in Portal', `${config.portalPublicUrl}/pentests`),
        ],
      },
    ],
  };
}

// ─── Router ──────────────────────────────────────────────────────────

const formatters: Record<string, (data: Record<string, unknown>, ts: string) => FormattedMessage> = {
  'agent.enrolled':    agentEnrolled,
  'agent.approved':    agentApproved,
  'agent.online':      agentOnline,
  'agent.offline':     agentOffline,
  'task.completed':    taskCompleted,
  'task.failed':       taskFailed,
  'task.needs_input':  taskNeedsInput,
  'report.completed':  reportCompleted,
  'report.failed':     reportFailed,
};

/**
 * Format a ManageLM webhook payload into a Slack message.
 * Returns null for unknown event types.
 */
export function formatWebhookEvent(payload: WebhookPayload): FormattedMessage | null {
  const fn = formatters[payload.event];
  if (!fn) return null;
  return fn(payload.data, payload.timestamp);
}

/**
 * Determine which channel to post to based on event type.
 * Alert events (offline, failed) go to SLACK_CHANNEL_ALERTS.
 * Info events go to SLACK_CHANNEL_INFO.
 * Returns empty string if no routing is configured (caller should use default).
 */
export function routeEventToChannel(event: string): string {
  const alertEvents = ['agent.offline', 'task.failed', 'report.failed'];
  if (alertEvents.includes(event) && config.channelAlerts) {
    return config.channelAlerts;
  }
  if (config.channelInfo) {
    return config.channelInfo;
  }
  return '';
}

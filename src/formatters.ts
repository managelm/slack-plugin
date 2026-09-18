/**
 * Slack Block Kit message formatters for ManageLM webhook events.
 *
 * Agent and task events have their own formatters (buttons to act on them).
 * Every other event — reports, monitors, backups, certificates, credentials,
 * keystore, pentests, admin sessions, schedules — goes through one table-driven formatter:
 * EVENTS says what the event is called, how urgent it is and which portal page
 * it links to, and the payload's known fields are listed below the title.
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

// ─── Shared status icons (used by formatters + handlers) ────────────

export const STATUS_ICONS: Record<string, string> = {
  online:           ':large_green_circle:',
  offline:          ':red_circle:',
  approved:         ':white_circle:',
  pending_approval: ':yellow_circle:',
  revoked:          ':no_entry:',
  sent:             ':hourglass_flowing_sand:',
  completed:        ':white_check_mark:',
  failed:           ':x:',
  timeout:          ':hourglass:',
  needs_input:      ':question:',
  answered:         ':speech_balloon:',
};

// ─── Text safety (used by formatters + handlers + app) ──────────────

/**
 * Escape text for Slack mrkdwn. Slack reads &, < and > as control characters:
 * `<!channel>` pings a whole channel and `<https://x|label>` disguises a link.
 * Everything that comes from an agent, the LLM, the portal or a typed command
 * goes through here before it lands in a message; the formatting this plugin
 * adds itself (*bold*, `code`, <!date^…>) stays outside it. A literal < or >
 * the plugin writes (a placeholder like &lt;host&gt;) is written escaped.
 */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The reverse of esc(), for text Slack sends: it escapes &, < and > in slash
 * command text. One pass, so a typed "&amp;lt;" comes back as "&lt;", not "<".
 * Decode before using the text (instruction, answer, host name, search), then
 * esc() again only where it is displayed.
 */
export function unesc(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) => (name === 'amp' ? '&' : name === 'lt' ? '<' : '>'));
}

/** A copy of `row` with its top-level string values escaped (see esc). */
export function escapeStrings<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? esc(v) : v]),
  ) as T;
}

/** Slack refuses a section block over 3000 characters; stay under it. */
const SECTION_TEXT_LIMIT = 2900;

/** Agents' reports shown in a schedule.report message, and how much of each —
 *  together they fit the section limit above. */
const REPORTS_SHOWN = 3;
const REPORT_CHARS = 800;

/**
 * Cut mrkdwn text to fit a section block. The cut falls on a line break when
 * one is reasonably close, so it does not split an escape (&amp;) or a list line.
 */
export function truncate(text: string): string {
  if (text.length <= SECTION_TEXT_LIMIT) return text;
  const lineEnd = text.lastIndexOf('\n', SECTION_TEXT_LIMIT);
  const cut = lineEnd > SECTION_TEXT_LIMIT / 2 ? lineEnd : SECTION_TEXT_LIMIT;
  return `${text.slice(0, cut)}\n…_(truncated)_`;
}

// ─── Event catalog ───────────────────────────────────────────────────

/**
 * Every event the portal delivers. `alert` mirrors the portal's own
 * notification severity (warn or critical) and routes the event to
 * SLACK_CHANNEL_ALERTS; `page` is the portal page "View in Portal" opens.
 */
const EVENTS: Record<string, { title: string; icon: string; alert?: boolean; page: string }> = {
  'agent.enrolled':             { title: 'Agent Enrollment Request',   icon: ':new:',                   page: '/agents' },
  'agent.approved':             { title: 'Agent Approved',             icon: ':white_check_mark:',      page: '/agents' },
  'agent.online':               { title: 'Agent Online',               icon: ':large_green_circle:',    page: '/agents' },
  'agent.offline':              { title: 'Agent Offline',              icon: ':red_circle:',            page: '/agents', alert: true },
  'task.completed':             { title: 'Task Completed',             icon: ':white_check_mark:',      page: '/audit-log#agent' },
  'task.failed':                { title: 'Task Failed',                icon: ':x:',                     page: '/audit-log#agent', alert: true },
  'task.needs_input':           { title: 'Task Needs Input',           icon: ':question:',              page: '/audit-log#agent' },
  'report.completed':           { title: 'Report Completed',           icon: ':bar_chart:',             page: '/assets' },
  'report.failed':              { title: 'Report Failed',              icon: ':warning:',               page: '/assets', alert: true },
  'report.stalled':             { title: 'Report Stalled',             icon: ':warning:',               page: '/assets', alert: true },
  'monitor.down':               { title: 'Monitor Down',               icon: ':rotating_light:',        page: '/monitors', alert: true },
  'monitor.up':                 { title: 'Monitor Up',                 icon: ':large_green_circle:',    page: '/monitors' },
  'monitor.stalled':            { title: 'Monitoring Stopped',         icon: ':warning:',               page: '/monitors', alert: true },
  'monitor.created':            { title: 'Monitor Created',            icon: ':heavy_plus_sign:',       page: '/monitors' },
  'monitor.deleted':            { title: 'Monitor Deleted',            icon: ':wastebasket:',           page: '/monitors' },
  'backup.completed':           { title: 'Backup Completed',           icon: ':floppy_disk:',           page: '/backups' },
  'backup.failed':              { title: 'Backup Failed',              icon: ':rotating_light:',        page: '/backups', alert: true },
  'cert.issued':                { title: 'Certificate Issued',         icon: ':lock:',                  page: '/certificates' },
  'cert.renewed':               { title: 'Certificate Renewed',        icon: ':lock:',                  page: '/certificates' },
  'cert.renewal_failed':        { title: 'Certificate Renewal Failed', icon: ':rotating_light:',        page: '/certificates', alert: true },
  'cert.revoked':               { title: 'Certificate Revoked',        icon: ':no_entry:',              page: '/certificates', alert: true },
  'cert.reactivated':           { title: 'Certificate Reactivated',    icon: ':lock:',                  page: '/certificates' },
  'cert.deleted':               { title: 'Certificate Deleted',        icon: ':wastebasket:',           page: '/certificates' },
  'credential.rotated':         { title: 'Credential Rotated',         icon: ':key:',                   page: '/credentials' },
  'credential.rotation_failed': { title: 'Credential Rotation Failed', icon: ':rotating_light:',        page: '/credentials', alert: true },
  'keystore.access_denied':     { title: 'Keystore Access Denied',     icon: ':no_entry:',              page: '/keystore', alert: true },
  'keystore.key_deleted':       { title: 'Keystore Key Deleted',       icon: ':wastebasket:',           page: '/keystore', alert: true },
  'pentest.completed':          { title: 'Pentest Completed',          icon: ':shield:',                page: '/pentests' },
  'pentest.failed':             { title: 'Pentest Failed',             icon: ':warning:',               page: '/pentests', alert: true },
  'console.opened':             { title: 'Console Opened',             icon: ':computer:',              page: '/audit-log', alert: true },
  'console.closed':             { title: 'Console Closed',             icon: ':computer:',              page: '/audit-log' },
  'desktop.opened':             { title: 'Desktop Session Opened',     icon: ':desktop_computer:',      page: '/audit-log', alert: true },
  'desktop.closed':             { title: 'Desktop Session Closed',     icon: ':desktop_computer:',      page: '/audit-log' },
  'files.opened':               { title: 'File Browser Opened',        icon: ':open_file_folder:',      page: '/audit-log', alert: true },
  // A scheduled task's run: an agent found what the prompt asked it to report,
  // or tasks failed. Both are 'warn' in the portal's notify defaults.
  'schedule.report':            { title: 'Schedule Report',            icon: ':memo:',                  page: '/schedules', alert: true },
  'schedule.failed':            { title: 'Schedule Failed',            icon: ':warning:',               page: '/schedules', alert: true },
};

/**
 * Payload fields worth showing, in display order. A field absent from the
 * payload is skipped, so one list serves every event.
 */
const FIELDS: Array<[key: string, label: string, format?: (v: unknown, d: Record<string, unknown>) => string]> = [
  ['monitor_name', 'Monitor'],
  ['backup_name', 'Backup'],
  ['common_name', 'Certificate'],
  ['credential_name', 'Credential'],
  ['schedule_name', 'Schedule'],
  // schedule.report: how many of the run's agents had something to report.
  ['hosts_total', 'Reported', (v, d) => `${Array.isArray(d.reports) ? d.reports.length : 0} of ${v} agents`],
  ['username', 'Account'],
  // console / desktop / files sessions: who opened them.
  ['user_email', 'User'],
  ['handle', 'Key'],
  // Monitor events repeat the monitor's name as `name`; only a keystore key
  // carries `name` alone.
  ['name', 'Name', (v, d) => (d.monitor_name ? '' : String(v))],
  // monitor.down / monitor.up: latency in ms, a percentage or a count.
  ['value', 'Value', (v, d) => (d.unit === '%' ? `${v}%` : `${v}${d.unit ? ` ${d.unit}` : ''}`)],
  ['report_type', 'Report', (v) => String(v).replace(/_/g, ' ')],
  ['issue_count', 'Issues'],
  ['item_count', 'Items'],
  ['cert_count', 'Certificates'],
  ['expiring_count', 'Expiring'],
  ['user_count', 'Users'],
  ['key_count', 'SSH keys'],
  ['logins', 'Logins'],
  ['failed_auth', 'Failed logins'],
  ['sudo_commands', 'Privileged commands'],
  ['score', 'Score'],
  ['findings_count', 'Findings'],
  ['monitor_count', 'Monitors affected'],
  ['backup_count', 'Backups affected'],
  ['days_since', 'Days since last run'],
  ['sinks_total', 'Delivered', (v, d) => `${d.sinks_ok ?? 0}/${v}`],
  ['size_bytes', 'Size', (v) => formatBytes(Number(v))],
  ['duration_seconds', 'Duration', (v) => formatDuration(Number(v))],
  ['caller_user', 'Caller'],
  ['reason', 'Reason'],
  ['error_message', 'Error'],
  ['error', 'Error'],
];

// ─── Helpers ─────────────────────────────────────────────────────────

/** The host an event is about, when it names one. */
function agentName(data: Record<string, unknown>): string | null {
  const name = data.display_name || data.hostname || data.agent_name;
  return name ? String(name) : null;
}

function agentLabel(data: Record<string, unknown>): string {
  return `\`${agentName(data) || data.agent_id || 'unknown'}\``;
}

function timestamp(iso: string): string {
  const epoch = Math.floor(new Date(iso).getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${esc(iso)}>`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return String(s);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
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

function linkButton(text: string, path: string): Button {
  return {
    type: 'button',
    text: { type: 'plain_text', text },
    url: `${config.portalPublicUrl}${path}`,
    action_id: `link_${Date.now()}`,
  };
}

// ─── Event formatters ────────────────────────────────────────────────

function agentEvent(event: string, data: Record<string, unknown>, ts: string): FormattedMessage {
  const meta = EVENTS[event];
  const label = agentLabel(data);
  const lines: Record<string, string> = {
    'agent.enrolled': `Server ${label} is requesting to join your infrastructure. Review and approve it in the portal.`,
    'agent.approved': `Server ${label} is now managed and ready to receive tasks.`,
    'agent.online': `Server ${label} connected.`,
    'agent.offline': `Server ${label} has disconnected.`,
  };
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${meta.icon} *${meta.title}*\n${lines[event]}\n${timestamp(ts)}` } },
  ];
  if (event === 'agent.enrolled' || event === 'agent.offline') {
    blocks.push({ type: 'actions', elements: [linkButton(event === 'agent.enrolled' ? 'Review in Portal' : 'View in Portal', meta.page)] });
  }
  return { text: `${meta.title}: ${agentName(data) || 'unknown'}`, blocks };
}

function taskEvent(event: string, data: Record<string, unknown>, ts: string): FormattedMessage {
  const meta = EVENTS[event];
  const label = agentLabel(data);
  const taskId = data.task_id as string;

  let detail = `*Skill:* ${(data.skill_slug || 'unknown') as string}`;
  if (event === 'task.completed') {
    if (data.summary) detail += `\n*Summary:* ${data.summary as string}`;
    if (data.mutating) detail += '\n:warning: _This task made changes to the server._';
  } else if (event === 'task.failed') {
    detail += `\n*Error:* ${(data.error_message || 'Unknown error') as string}`;
  } else {
    detail += `\n*Question:* ${(data.question || 'The agent needs more information.') as string}`;
    // The placeholder is escaped too: Slack would read <your answer> as a link.
    detail += `\n_Answer with_ \`/managelm answer ${taskId} &lt;your answer&gt;\``;
  }

  return {
    text: `${meta.title} on ${label}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${meta.icon} *${meta.title}* on ${label}\n${detail}\n${timestamp(ts)}` } },
      { type: 'actions', elements: [button('View Details', 'view_task', taskId), linkButton('View in Portal', meta.page)] },
    ],
  };
}

/** Everything else: title, host, and the payload's known fields. */
function genericEvent(event: string, data: Record<string, unknown>, ts: string): FormattedMessage {
  const meta = EVENTS[event];
  const host = agentName(data);
  const lines: string[] = [];
  for (const [key, label, format] of FIELDS) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    const text = format ? format(value, data) : String(value);
    if (text) lines.push(`*${label}:* ${text}`);
  }
  // A monitor or backup "stalled" payload lists what stopped. The list is
  // nested, so escapeStrings() did not reach its names.
  const names = (data.monitors || data.backups) as Array<{ name?: string }> | undefined;
  if (Array.isArray(names) && names.length > 0) {
    const shown = names.slice(0, 5).map(n => n.name).filter(Boolean).map(esc).join(', ');
    lines.push(`*Affected:* ${shown}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`);
  }
  // A schedule run names its agents in nested lists, which escapeStrings() did
  // not reach either: what each one reported (schedule.report), or why each
  // failed (schedule.failed). Reports are the LLM's Markdown write-ups and can
  // be long, so a few are shown, each cut before escaping (never mid-entity);
  // the button opens the rest.
  const reports = data.reports as Array<{ hostname?: string; report?: string }> | undefined;
  if (Array.isArray(reports) && reports.length > 0) {
    for (const r of reports.slice(0, REPORTS_SHOWN)) {
      const text = String(r.report ?? '');
      lines.push(`*${esc(r.hostname)}:*\n${esc(text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS)}…` : text)}`);
    }
    if (reports.length > REPORTS_SHOWN) lines.push(`_…and ${reports.length - REPORTS_SHOWN} more in the portal_`);
  }
  const failed = data.failed as Array<{ hostname?: string; status?: string; error?: string | null }> | undefined;
  if (Array.isArray(failed) && failed.length > 0) {
    const shown = failed.slice(0, 5).map(f => `${esc(f.hostname)} (${esc(f.error || f.status)})`).join(', ');
    lines.push(`*Failed:* ${shown}${failed.length > 5 ? `, and ${failed.length - 5} more` : ''}`);
  }

  const heading = `${meta.icon} *${meta.title}*${host ? ` on \`${host}\`` : ''}`;
  return {
    text: `${meta.title}${host ? ` on ${host}` : ''}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: [heading, ...lines, timestamp(ts)].join('\n') } },
      { type: 'actions', elements: [linkButton('View in Portal', meta.page)] },
    ],
  };
}

// ─── Router ──────────────────────────────────────────────────────────

/**
 * Format a ManageLM webhook payload into a Slack message.
 * Returns null for event types this plugin does not know.
 *
 * The payload's string values are escaped once here (hostnames, summaries,
 * questions, errors all come from agents or the LLM), so the formatters below
 * interpolate `data` as is and must not escape it again.
 */
export function formatWebhookEvent(payload: WebhookPayload): FormattedMessage | null {
  // Own keys only: "constructor" is not an event.
  if (!Object.hasOwn(EVENTS, payload.event)) return null;
  const data = escapeStrings(payload.data);
  if (payload.event.startsWith('agent.')) return agentEvent(payload.event, data, payload.timestamp);
  if (payload.event.startsWith('task.')) return taskEvent(payload.event, data, payload.timestamp);
  return genericEvent(payload.event, data, payload.timestamp);
}

/**
 * Determine which channel to post to based on event type.
 * Alert events (the portal's warn / critical ones) go to SLACK_CHANNEL_ALERTS,
 * everything else to SLACK_CHANNEL_INFO.
 * Returns empty string if no routing is configured (caller should use default).
 */
export function routeEventToChannel(event: string): string {
  if (EVENTS[event]?.alert && config.channelAlerts) {
    return config.channelAlerts;
  }
  if (config.channelInfo) {
    return config.channelInfo;
  }
  return '';
}

/**
 * Slack command handlers, interactive actions, and modal views.
 *
 * Slash command: /managelm <subcommand> [args]
 *   status                         — list agents with their state
 *   run [hostname skill ...]       — open modal (no args) or submit inline
 *   task <task_id>                 — show a task's status and result
 *   answer <task_id> <answer...>   — answer a task waiting for input
 *   scan <hostname> <type>         — start a security/inventory/access/certificates/activity scan
 *   search <kind> [text]           — search the fleet (agents, inventory, security, ...)
 *   help                           — show available commands
 *
 * Approving agents, users, webhooks and other portal management are not
 * available to API keys: they are done in the portal.
 *
 * Modal: run_task_modal
 *   Opened by `/managelm run` (no args) — pick agent, skill, and instruction.
 *
 * Actions (buttons in messages):
 *   view_task — fetch and display task details
 *
 * Every entry point first asks isAllowed() (SLACK_ALLOWED_USERS /
 * SLACK_ALLOWED_CHANNELS): the API key acts with its owner's rights for
 * whoever reaches the bot.
 *
 * Text from agents, the LLM, the portal or the typed command is escaped with
 * esc() where it is placed in a message; the caller passes raw values. Slack
 * sends command text with &, < and > already escaped, so the command handler
 * decodes it (unesc) once, before anything reads it. Placeholders the plugin
 * writes itself (&lt;host&gt;) are written escaped.
 */

import type { App, SlackCommandMiddlewareArgs, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import * as mlm from './managelm.js';
import { config, isAllowed } from './config.js';
import { STATUS_ICONS, esc, escapeStrings, truncate, unesc } from './formatters.js';

/** Reply to someone outside SLACK_ALLOWED_USERS / SLACK_ALLOWED_CHANNELS. */
const NOT_ALLOWED = 'You are not allowed to use ManageLM here.';

/** Portal task IDs are UUIDs; anything else is a typo, not a lookup. */
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a host is named in messages: its display name, else its hostname. */
const hostLabel = (a: { hostname: string; display_name: string | null }) => a.display_name || a.hostname;

/** A section block, cut to Slack's text limit. */
const section = (text: string) => ({ type: 'section' as const, text: { type: 'mrkdwn' as const, text: truncate(text) } });

// ─── Slash command ───────────────────────────────────────────────────

export function registerCommands(app: App): void {
  app.command('/managelm', async ({ command, ack, respond, client }) => {
    await ack();

    if (!isAllowed(command.user_id, command.channel_id)) {
      await respond({ response_type: 'ephemeral', text: `:no_entry: ${NOT_ALLOWED}` });
      return;
    }

    // Decoded once here: every handler reads the text as the user typed it.
    const text = unesc(command.text);
    const args = text.trim().split(/\s+/).filter(Boolean);
    const subcommand = (args[0] || 'help').toLowerCase();

    try {
      switch (subcommand) {
        case 'status':
          await handleStatus(respond);
          break;
        case 'run':
          // No args → open modal; with args → inline execution
          if (args.length < 4) {
            await openRunModal(client, command.trigger_id, command.channel_id, respond);
          } else {
            await handleRun(args.slice(1), textAfterWords(text, 3).trim(), respond);
          }
          break;
        case 'task':
          await handleTask(args.slice(1), respond);
          break;
        case 'answer':
          await handleAnswer(args[1], textAfterWords(text, 2), respond);
          break;
        case 'scan':
          await handleScan(args.slice(1), respond);
          break;
        case 'search':
          await handleSearch(args[1], textAfterWords(text, 2).trim(), respond);
          break;
        case 'help':
        default:
          await handleHelp(respond);
          break;
      }
    } catch (err: unknown) {
      await respond({ response_type: 'ephemeral', text: `:x: Error: ${esc(errorMessage(err, 'Unknown error'))}` });
    }
  });
}

type Respond = SlackCommandMiddlewareArgs['respond'];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** The Web API error code of a failed Slack call (not_in_channel, expired_trigger_id, ...). */
function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | null)?.data?.error;
}

/**
 * The raw text after the first `count` words of a command, without the
 * whitespace that separates it from them. Inner spaces, tabs and line breaks
 * are kept: an answer can be a password, an instruction several lines.
 * Empty when nothing follows those words.
 */
function textAfterWords(text: string, count: number): string {
  const words = new RegExp(`^\\s*(?:\\S+\\s+){${count}}`).exec(text);
  return words ? text.slice(words[0].length) : '';
}

/** Result text for a task that finished, paused, or is still running. */
function outcomeText(outcome: mlm.TaskOutcome, agentName: string, skill: string): string {
  const where = `on \`${esc(agentName)}\`\n*Skill:* ${esc(skill)}`;
  if ('still_running' in outcome) {
    return `:hourglass_flowing_sand: *Task still running* ${where}\n`
      + `_Check it later with_ \`/managelm task ${esc(outcome.task_id)}\``;
  }
  const task = outcome.task;
  if (task.status === 'needs_input') {
    return `:question: *Input needed* ${where}\n*Question:* ${esc(task.question || 'The agent needs more information.')}\n`
      + `_Answer with_ \`/managelm answer ${esc(task.id)} &lt;your answer&gt;\``;
  }
  const icon = STATUS_ICONS[task.status] || ':grey_question:';
  const summary = task.summary || task.error_message || 'No output';
  return `${icon} *Task ${esc(task.status)}* ${where}\n*Result:* ${esc(summary)}`;
}

/**
 * How each candidate host reads in a "did you mean": its hostname first (what
 * can be typed; a display name may hold spaces), the display name beside it
 * when it differs, and the short agent ID when two hosts would still read the
 * same — otherwise the list shows one name twice with no way to tell them apart.
 */
function hostChoices(agents: mlm.AgentSummary[]): string[] {
  const label = (a: mlm.AgentSummary) => `\`${esc(a.hostname)}\``
    + (a.display_name && a.display_name.toLowerCase() !== a.hostname.toLowerCase() ? ` (${esc(a.display_name)})` : '');
  const count = new Map<string, number>();
  for (const a of agents) count.set(label(a).toLowerCase(), (count.get(label(a).toLowerCase()) ?? 0) + 1);
  return agents.map(a => ((count.get(label(a).toLowerCase()) ?? 0) > 1 ? `${label(a)} · ID ${esc(a.id.slice(0, 8))}` : label(a)));
}

/**
 * Resolve the host a command names (see mlm.findAgentByHostname), or reply why
 * it cannot and return null. When several hosts answer to the name exactly,
 * the reply points to the exact hostname, or to the run form, which lists
 * servers to pick from (the only way when the hostnames are the same too).
 */
async function resolveHost(name: string, respond: Respond): Promise<mlm.AgentSummary | null> {
  const { agent, candidates } = await mlm.findAgentByHostname(name);
  if (agent) return agent;

  if (candidates.length === 0) {
    await respond({ response_type: 'ephemeral', text: `:x: No agent found matching \`${esc(name)}\`` });
    return null;
  }
  const choices = hostChoices(candidates);
  const more = choices.length > 5 ? `, and ${choices.length - 5} more` : '';
  // Candidates are the exact matches when there are several (see findAgentByHostname).
  const wanted = name.toLowerCase();
  const shared = candidates.some(a => a.hostname.toLowerCase() === wanted || a.display_name?.toLowerCase() === wanted);
  const hint = shared
    ? '\n_Several servers answer to that name: use the exact hostname, or pick the server in the run form (`/managelm run`)._'
    : '';
  await respond({
    response_type: 'ephemeral',
    text: `:x: \`${esc(name)}\` does not name a single agent. Did you mean ${choices.slice(0, 5).join(', ')}${more}?${hint}`,
  });
  return null;
}

/** /managelm status — list all agents with their state. */
async function handleStatus(respond: Respond): Promise<void> {
  const agents = await mlm.listAgents();

  if (agents.length === 0) {
    await respond({ response_type: 'ephemeral', text: 'No agents found.' });
    return;
  }

  // Sort: online first, then offline, then the rest
  const order: Record<string, number> = { online: 0, offline: 1, approved: 2, pending_approval: 3 };
  agents.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));

  const lines = agents.map(a => {
    const icon = STATUS_ICONS[a.status] || ':grey_question:';
    const ip = a.ip_address ? ` (${esc(a.ip_address)})` : '';
    return `${icon} \`${esc(hostLabel(a))}\`${ip} — ${esc(a.status.replace('_', ' '))}`;
  });

  const online = agents.filter(a => a.status === 'online').length;
  const summary = `*${agents.length} agents* (${online} online)\n\n${lines.join('\n')}`;

  await respond({ response_type: 'in_channel', blocks: [section(summary)] });
}

/** /managelm run <hostname> <skill> <instruction...> — inline task submit; `instruction` is the text as typed. */
async function handleRun(args: string[], instruction: string, respond: Respond): Promise<void> {
  const [hostname, skill] = args;

  const agent = await resolveHost(hostname, respond);
  if (!agent) return;
  const name = hostLabel(agent);

  if (agent.status !== 'online') {
    await respond({ response_type: 'ephemeral', text: `:x: Agent \`${esc(name)}\` is ${esc(agent.status)}. It must be online to run tasks.` });
    return;
  }

  await respond({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: Running task on \`${esc(name)}\`...\n*Skill:* ${esc(skill)}\n*Instruction:* ${esc(instruction)}`,
  });

  try {
    const outcome = await mlm.runTask(agent.id, skill, instruction);
    await respond({ response_type: 'in_channel', replace_original: false, text: outcomeText(outcome, name, skill) });
  } catch (err: unknown) {
    await respond({
      response_type: 'in_channel',
      replace_original: false,
      text: `:x: Task failed on \`${esc(name)}\`: ${esc(errorMessage(err, 'Task failed'))}`,
    });
  }
}

/** /managelm task <task_id> — show a task's status and result. */
async function handleTask(args: string[], respond: Respond): Promise<void> {
  const taskId = args[0];
  if (!taskId || !TASK_ID.test(taskId)) {
    await respond({ response_type: 'ephemeral', text: 'Usage: `/managelm task &lt;task_id&gt;` (the task ID is a UUID)' });
    return;
  }
  await respond({ response_type: 'ephemeral', blocks: await taskDetailBlocks(taskId) });
}

/**
 * /managelm answer <task_id> <answer...> — answer a task waiting for input.
 * `answer` is the raw text after the task ID: inner spaces and tabs are part
 * of it (it can be a password).
 */
async function handleAnswer(taskId: string | undefined, answer: string, respond: Respond): Promise<void> {
  if (!taskId || !TASK_ID.test(taskId) || !answer) {
    await respond({ response_type: 'ephemeral', text: 'Usage: `/managelm answer &lt;task_id&gt; &lt;your answer&gt;` (the task ID is a UUID)' });
    return;
  }

  // The answer can be a secret the agent asked for (a password, a license
  // key). Every reply stays ephemeral: an in_channel response makes Slack show
  // the typed command — answer included — to the whole channel.
  await respond({ response_type: 'ephemeral', text: ':hourglass_flowing_sand: Sending the answer...' });

  // Look the task up first. Nothing has been sent yet, so any failure here —
  // whatever its kind — means the answer was not sent.
  let original: mlm.Task;
  let agentName: string;
  try {
    original = await mlm.getTask(taskId);
    agentName = hostLabel(await mlm.getAgent(original.agent_id));
  } catch (err: unknown) {
    await respond({ response_type: 'ephemeral', replace_original: false, text: `:x: Answer not sent: ${esc(errorMessage(err, 'Unknown error'))}` });
    return;
  }

  // The portal waits for the resumed task before it replies (up to 100 s), so
  // "Answer sent" is only said once that reply is in. A 4xx — not waiting for
  // input, session expired, no access — is a refusal checked before anything
  // is delivered. Anything else (timeout, network error, 5xx from the portal
  // or a proxy) can come after the portal took the answer and resumed the
  // task, so the reply must not claim it was not sent: the task's status tells.
  let text: string;
  try {
    const outcome = await mlm.answerTask(taskId, answer);
    text = `:white_check_mark: Answer sent.\n${outcomeText(outcome, agentName, original.skill_slug)}`;
  } catch (err: unknown) {
    const message = esc(errorMessage(err, 'Unknown error'));
    text = mlm.isRefusal(err)
      ? `:x: Answer not sent: ${message}`
      : `:warning: No confirmation from ManageLM (${message}). The answer may have been delivered: `
        + `check with \`/managelm task ${esc(taskId)}\`.`;
  }
  await respond({ response_type: 'ephemeral', replace_original: false, text });
}

/** /managelm scan <hostname> <type> — start a scan; the result arrives as a report event. */
async function handleScan(args: string[], respond: Respond): Promise<void> {
  const [hostname, type] = args;
  const types = Object.keys(mlm.SCAN_ROUTES);
  if (!hostname || !type || !types.includes(type.toLowerCase())) {
    await respond({ response_type: 'ephemeral', text: `Usage: \`/managelm scan &lt;hostname&gt; &lt;${types.join('|')}&gt;\`` });
    return;
  }

  const agent = await resolveHost(hostname, respond);
  if (!agent) return;

  await mlm.startScan(agent.id, type.toLowerCase());
  await respond({
    response_type: 'in_channel',
    text: `:mag: Started a *${type.toLowerCase()}* scan on \`${esc(hostLabel(agent))}\`. `
      + 'A report event is posted when it completes, if your ManageLM webhook includes scan reports.',
  });
}

// ─── Search ──────────────────────────────────────────────────────────

/** Most results a search prints; the rest is in the portal. */
const SEARCH_LINES = 15;

const SEVERITY_ICONS: Record<string, string> = {
  critical: ':red_circle:', high: ':large_orange_circle:', medium: ':large_yellow_circle:', low: ':white_circle:',
};

type Row = Record<string, any>;
const host = (r: Row) => `\`${r.display_name || r.hostname || r.agent || r.server || '?'}\``;

/**
 * Searches the command offers: route segment, key of the rows in the reply,
 * and how one row reads. Other searches stay available in the portal and to
 * MCP clients; these are the ones that read well as chat lines.
 *
 * `line` receives the row with its string values already escaped.
 */
const SEARCHES: Record<string, { route: string; rows: string; line: (r: Row) => string }> = {
  agents: {
    route: 'agents', rows: 'agents',
    line: r => `${STATUS_ICONS[r.status] || ':grey_question:'} ${host(r)} ${r.status}${r.os_info ? ` · ${r.os_info}` : ''}`,
  },
  inventory: {
    route: 'inventory', rows: 'items',
    line: r => `${host(r)} ${r.item_name}${r.item_version ? ` ${r.item_version}` : ''} (${r.item_category}, ${r.item_status})`,
  },
  security: {
    route: 'security', rows: 'findings',
    line: r => `${SEVERITY_ICONS[r.severity] || ':white_circle:'} ${host(r)} ${r.title}${r.source && r.source !== 'audit' ? ` _(${r.source})_` : ''}`,
  },
  activity: {
    route: 'activity', rows: 'activity',
    line: r => `${host(r)} ${String(r.category || '').replace('_', ' ')}: ${r.linux_user || r.managelm_user || ''} ${r.command || r.file || r.source_ip || ''} ${r.login_time || r.timestamp || ''}`.trim(),
  },
  monitors: {
    route: 'monitors', rows: 'monitors',
    line: r => `${r.status === 'up' ? ':large_green_circle:' : r.status === 'down' ? ':red_circle:' : ':large_yellow_circle:'} ${r.name} on ${host(r)} ${r.status}${r.value != null ? ` (${r.value} ${r.unit})` : ''}`,
  },
  backups: {
    route: 'backups', rows: 'backups',
    line: r => `${r.status === 'ok' ? ':white_check_mark:' : r.status === 'failed' ? ':x:' : ':hourglass_flowing_sand:'} ${r.name} on ${host(r)} ${r.status}${r.error ? `: ${r.error}` : ''}`,
  },
  certificates: {
    route: 'certs', rows: 'certs',
    line: r => `${r.expired ? ':red_circle:' : r.expiring_soon ? ':large_yellow_circle:' : ':white_circle:'} ${host(r)} ${r.subject} (${r.days_left ?? '?'} days)${r.self_signed ? ' self-signed' : ''}`,
  },
  pki: {
    route: 'pki', rows: 'certificates',
    line: r => `${r.status === 'active' ? ':lock:' : ':warning:'} ${r.common_name} ${r.status}, expires ${r.expires || '?'}${r.agent ? ` on \`${r.agent}\`` : ''}`,
  },
  credentials: {
    route: 'credentials', rows: 'credentials',
    line: r => `${r.state === 'failed' ? ':x:' : ':key:'} ${r.name} (${r.account}) ${r.state}, next: ${r.next_rotation}`,
  },
};

/** /managelm search <kind> [text] — search the fleet; `text` is the search text as typed. */
async function handleSearch(kindArg: string | undefined, text: string, respond: Respond): Promise<void> {
  const kind = (kindArg || '').toLowerCase();
  // Own keys only: SEARCHES['constructor'] is Object's, not a search.
  if (!Object.hasOwn(SEARCHES, kind)) {
    await respond({ response_type: 'ephemeral', text: `Usage: \`/managelm search &lt;${Object.keys(SEARCHES).join('|')}&gt; [text]\`` });
    return;
  }
  const spec = SEARCHES[kind];

  const data = await mlm.search(spec.route, { query: text });
  const rows = (data[spec.rows] as Row[] | undefined) || [];
  if (rows.length === 0) {
    await respond({ response_type: 'ephemeral', text: `No ${kind} found.` });
    return;
  }

  // truncated: the portal capped the rows (monitors, backups, pki, credentials),
  // so the count is a floor and the ones left out are not in the portal reply either.
  const capped = data.truncated === true;
  const count = capped ? `*${rows.length}+ ${kind}*, capped by ManageLM: refine the search` : `*${rows.length} ${kind}*`;
  const lines = rows.slice(0, SEARCH_LINES).map(r => spec.line(escapeStrings(r)));
  const more = rows.length > SEARCH_LINES ? `\n_…and ${rows.length - SEARCH_LINES}${capped ? '+' : ''} more. Narrow the search or open the portal._` : '';
  await respond({
    response_type: 'ephemeral',
    blocks: [section(`${count}\n${lines.join('\n')}${more}`)],
  });
}

/** /managelm help — show available commands. */
async function handleHelp(respond: Respond): Promise<void> {
  await respond({
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*ManageLM Slack Commands*',
            '',
            '`/managelm status` — List all agents with their status',
            '`/managelm run` — Open task form (or inline: `/managelm run &lt;host&gt; &lt;skill&gt; &lt;instruction&gt;`)',
            '`/managelm task &lt;task_id&gt;` — Show a task\'s status and result',
            '`/managelm answer &lt;task_id&gt; &lt;answer&gt;` — Answer a task waiting for input',
            `\`/managelm scan &lt;host&gt; &lt;${Object.keys(mlm.SCAN_ROUTES).join('|')}&gt;\` — Start a scan`,
            `\`/managelm search &lt;${Object.keys(SEARCHES).join('|')}&gt; [text]\` — Search your fleet`,
            '`/managelm help` — Show this help message',
            '',
            '_Name a host by its exact hostname or display name. A name with spaces cannot be typed: pick that server in the run form._',
            `_Connected to ${esc(config.portalPublicUrl)}. Approving agents and other settings are done in the portal._`,
          ].join('\n'),
        },
      },
    ],
  });
}

// ─── Task details ───────────────────────────────────────────────────

/** Blocks describing a task — shared by `/managelm task` and the View Details button. */
async function taskDetailBlocks(taskId: string) {
  const task = await mlm.getTask(taskId);
  const status = STATUS_ICONS[task.status] || ':grey_question:';

  const fields: string[] = [
    `*Status:* ${esc(task.status)}`,
    `*Skill:* ${esc(task.skill_slug)}`,
  ];
  if (task.question) fields.push(`*Question:* ${esc(task.question)}`);
  if (task.summary) fields.push(`*Summary:* ${esc(task.summary)}`);
  if (task.error_message) fields.push(`*Error:* ${esc(task.error_message)}`);
  if (task.mutating) fields.push(':warning: _This task made changes_');
  if (task.completed_at) fields.push(`*Completed:* ${esc(task.completed_at)}`);
  if (task.status === 'needs_input') fields.push(`_Answer with_ \`/managelm answer ${esc(task.id)} &lt;your answer&gt;\``);

  return [section(`${status} *Task Details* (\`${esc(taskId)}\`)\n${fields.join('\n')}`)];
}

// ─── Run Task Modal ─────────────────────────────────────────────────

/** Slack refuses an option whose text is longer than this. */
const OPTION_TEXT_LIMIT = 75;

type Option = { text: { type: 'plain_text'; text: string }; value: string };
const option = (text: string, value: string): Option => ({
  text: { type: 'plain_text', text: text.length > OPTION_TEXT_LIMIT ? `${text.slice(0, OPTION_TEXT_LIMIT - 1)}…` : text },
  value,
});

/**
 * How long the form waits for the portal. Slack's trigger_id expires 3 s after
 * the command, and views.open itself needs part of that: a slower portal gets
 * a clear reply rather than an expired form.
 */
const FORM_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Open a modal for structured task submission. `channelId` is the channel the
 * command was typed in; it rides in private_metadata (set by the app, not
 * editable by the user) so the submission can be checked against
 * SLACK_ALLOWED_CHANNELS too.
 *
 * When the servers or skills cannot be listed, or no server is online, the
 * user gets that as an ephemeral reply instead of a form that cannot be used.
 */
async function openRunModal(client: WebClient, triggerId: string, channelId: string, respond: Respond): Promise<void> {
  // Online agents and the account's skills for the dropdowns, fetched together
  // within the trigger_id budget. Slack caps a static select at 100 options.
  let agents: mlm.AgentSummary[];
  let skills: mlm.Skill[];
  try {
    [agents, skills] = await Promise.all([
      mlm.listAgentSummaries(FORM_LOOKUP_TIMEOUT_MS),
      mlm.listSkills(FORM_LOOKUP_TIMEOUT_MS),
    ]);
  } catch (err: unknown) {
    await respond({
      response_type: 'ephemeral',
      text: `:x: Could not load servers and skills from ManageLM: ${esc(errorMessage(err, 'Unknown error'))}`,
    });
    return;
  }

  const agentOptions = agents.filter(a => a.status === 'online').slice(0, 100).map(a => option(hostLabel(a), a.id));
  if (agentOptions.length === 0) {
    await respond({ response_type: 'ephemeral', text: ':x: No online agents to run a task on.' });
    return;
  }

  // "Auto" first: the agent picks the skill from the instruction.
  const skillOptions: Option[] = [
    option('Auto (agent picks the skill)', 'auto'),
    ...skills.slice(0, 99).map(s => option(s.name, s.slug)),
  ];

  try {
    await openRunView(client, triggerId, channelId, agentOptions, skillOptions);
  } catch (err: unknown) {
    if (slackErrorCode(err) !== 'expired_trigger_id') throw err;
    await respond({
      response_type: 'ephemeral',
      text: ':x: ManageLM answered too slowly to open the form (Slack allows 3 seconds). Try again, or run the task inline: '
        + '`/managelm run &lt;host&gt; &lt;skill&gt; &lt;instruction&gt;`',
    });
  }
}

/** The run form itself (see openRunModal). */
async function openRunView(client: WebClient, triggerId: string, channelId: string, agentOptions: Option[], skillOptions: Option[]): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'run_task_modal',
      private_metadata: channelId,
      title: { type: 'plain_text', text: 'Run Task' },
      submit: { type: 'plain_text', text: 'Run' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'agent_block',
          label: { type: 'plain_text', text: 'Server' },
          element: {
            type: 'static_select',
            action_id: 'agent_select',
            placeholder: { type: 'plain_text', text: 'Choose a server' },
            options: agentOptions,
          },
        },
        {
          type: 'input',
          block_id: 'skill_block',
          label: { type: 'plain_text', text: 'Skill' },
          element: {
            type: 'static_select',
            action_id: 'skill_select',
            placeholder: { type: 'plain_text', text: 'Choose a skill' },
            initial_option: skillOptions[0],
            options: skillOptions,
          },
        },
        {
          type: 'input',
          block_id: 'instruction_block',
          label: { type: 'plain_text', text: 'Instruction' },
          element: {
            type: 'plain_text_input',
            action_id: 'instruction_input',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'e.g. List outdated packages' },
          },
        },
      ],
    },
  });
}

// ─── Modal submission handler ───────────────────────────────────────

export function registerModals(app: App): void {
  app.view('run_task_modal', async ({ ack, body, view, client }) => {
    if (!isAllowed(body.user.id, view.private_metadata)) {
      await ack({ response_action: 'errors', errors: { agent_block: NOT_ALLOWED } });
      return;
    }

    const agentId = view.state.values.agent_block.agent_select.selected_option?.value || '';
    const skill = view.state.values.skill_block.skill_select.selected_option?.value || '';
    const instruction = view.state.values.instruction_block.instruction_input.value || '';

    if (!agentId || !skill || !instruction) {
      await ack({ response_action: 'errors', errors: { instruction_block: 'All fields are required' } });
      return;
    }

    await ack();

    // Progress and result go to the info or alerts channel; with neither
    // configured, to the submitting user as a direct message from the app.
    const userId = body.user.id;
    let channel = config.channelInfo || config.channelAlerts || userId;

    /**
     * Post to `channel`. When the configured channel refuses (app not invited,
     * channel archived), this message and every later one go to the user by
     * direct message instead, the first with a note saying why.
     */
    const post = async (text: string): Promise<void> => {
      if (channel !== userId) {
        try {
          await client.chat.postMessage({ token: config.slackBotToken, channel, text });
          return;
        } catch (err: unknown) {
          const reason = slackErrorCode(err) || errorMessage(err, 'unknown error');
          console.warn(`[slack] Run form: cannot post to ${channel} (${reason}); sending to the user instead`);
          text = `:warning: _Could not post to the configured channel (${esc(reason)}), so this comes to you directly._\n${text}`;
          channel = userId;
        }
      }
      await client.chat.postMessage({ token: config.slackBotToken, channel, text });
    };
    // A message that cannot be delivered anywhere is logged; it must not stop the task.
    const undelivered = (err: unknown) => console.error('[slack] Run form: message not delivered:', err);

    let text: string;
    try {
      const agentName = hostLabel(await mlm.getAgent(agentId));
      await post(`:hourglass_flowing_sand: Running task on \`${esc(agentName)}\`...\n*Skill:* ${esc(skill)}\n*Instruction:* ${esc(instruction)}`)
        .catch(undelivered);
      text = outcomeText(await mlm.runTask(agentId, skill, instruction), agentName, skill);
    } catch (err: unknown) {
      text = `:x: Task failed: ${esc(errorMessage(err, 'Task failed'))}`;
    }
    await post(text).catch(undelivered);
  });
}

// ─── Interactive actions (buttons) ───────────────────────────────────

export function registerActions(app: App): void {
  // "View Details" button from task notifications
  app.action<BlockAction<ButtonAction>>('view_task', async ({ action, ack, body, respond }) => {
    await ack();

    if (!isAllowed(body.user.id, body.channel?.id)) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:no_entry: ${NOT_ALLOWED}` });
      return;
    }

    const taskId = action.value ?? '';
    if (!TASK_ID.test(taskId)) return;

    try {
      await respond({ response_type: 'ephemeral', replace_original: false, blocks: await taskDetailBlocks(taskId) });
    } catch (err: unknown) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: `:x: Failed to fetch task: ${esc(errorMessage(err, 'Unknown error'))}`,
      });
    }
  });

  // Catch-all for link buttons (no-op, they just open URLs)
  app.action(/^link_/, async ({ ack }) => {
    await ack();
  });
}

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
 * esc() where it is placed in a message; the caller passes raw values.
 */

import type { App, SlackCommandMiddlewareArgs, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import * as mlm from './managelm.js';
import { config, isAllowed } from './config.js';
import { STATUS_ICONS, esc, escapeStrings, truncate } from './formatters.js';

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

    const args = command.text.trim().split(/\s+/).filter(Boolean);
    const subcommand = (args[0] || 'help').toLowerCase();

    try {
      switch (subcommand) {
        case 'status':
          await handleStatus(respond);
          break;
        case 'run':
          // No args → open modal; with args → inline execution
          if (args.length < 4) {
            await openRunModal(client, command.trigger_id, command.channel_id);
          } else {
            await handleRun(args.slice(1), respond);
          }
          break;
        case 'task':
          await handleTask(args.slice(1), respond);
          break;
        case 'answer':
          await handleAnswer(args.slice(1), respond);
          break;
        case 'scan':
          await handleScan(args.slice(1), respond);
          break;
        case 'search':
          await handleSearch(args.slice(1), respond);
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
      + `_Answer with_ \`/managelm answer ${esc(task.id)} <your answer>\``;
  }
  const icon = STATUS_ICONS[task.status] || ':grey_question:';
  const summary = task.summary || task.error_message || 'No output';
  return `${icon} *Task ${esc(task.status)}* ${where}\n*Result:* ${esc(summary)}`;
}

/**
 * Resolve the host a command names (see mlm.findAgentByHostname), or reply why
 * it cannot and return null. Suggestions show the display name with the
 * hostname beside it, so a name shared by two hosts can still be told apart.
 */
async function resolveHost(name: string, respond: Respond): Promise<mlm.AgentSummary | null> {
  const { agent, candidates } = await mlm.findAgentByHostname(name);
  if (agent) return agent;

  if (candidates.length === 0) {
    await respond({ response_type: 'ephemeral', text: `:x: No agent found matching \`${esc(name)}\`` });
    return null;
  }
  const suggestions = candidates.slice(0, 5).map(a =>
    `\`${esc(hostLabel(a))}\`${a.display_name && a.display_name !== a.hostname ? ` (${esc(a.hostname)})` : ''}`,
  );
  const more = candidates.length > 5 ? `, and ${candidates.length - 5} more` : '';
  await respond({
    response_type: 'ephemeral',
    text: `:x: \`${esc(name)}\` does not name a single agent. Did you mean ${suggestions.join(', ')}${more}?`,
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

/** /managelm run <hostname> <skill> <instruction...> — inline task submit. */
async function handleRun(args: string[], respond: Respond): Promise<void> {
  const [hostname, skill, ...rest] = args;
  const instruction = rest.join(' ');

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
    await respond({ response_type: 'ephemeral', text: 'Usage: `/managelm task <task_id>` (the task ID is a UUID)' });
    return;
  }
  await respond({ response_type: 'ephemeral', blocks: await taskDetailBlocks(taskId) });
}

/** /managelm answer <task_id> <answer...> — answer a task waiting for input. */
async function handleAnswer(args: string[], respond: Respond): Promise<void> {
  const [taskId, ...rest] = args;
  const answer = rest.join(' ');
  if (!taskId || !TASK_ID.test(taskId) || !answer) {
    await respond({ response_type: 'ephemeral', text: 'Usage: `/managelm answer <task_id> <your answer>` (the task ID is a UUID)' });
    return;
  }

  // The answer can be a secret the agent asked for (a password, a license
  // key). Every reply stays ephemeral: an in_channel response makes Slack show
  // the typed command — answer included — to the whole channel.
  await respond({ response_type: 'ephemeral', text: ':hourglass_flowing_sand: Sending the answer...' });

  // The portal waits for the resumed task before it replies (up to 100 s), so
  // "Answer sent" is only said once that reply is in. Any failure before it —
  // unknown task, not waiting for input, session expired — means nothing was
  // sent, and the portal's own message says why.
  let text: string;
  try {
    const original = await mlm.getTask(taskId);
    const agent = await mlm.getAgent(original.agent_id);
    const outcome = await mlm.answerTask(taskId, answer);
    text = `:white_check_mark: Answer sent.\n${outcomeText(outcome, hostLabel(agent), original.skill_slug)}`;
  } catch (err: unknown) {
    text = `:x: Answer not sent: ${esc(errorMessage(err, 'Unknown error'))}`;
  }
  await respond({ response_type: 'ephemeral', replace_original: false, text });
}

/** /managelm scan <hostname> <type> — start a scan; the result arrives as a report event. */
async function handleScan(args: string[], respond: Respond): Promise<void> {
  const [hostname, type] = args;
  const types = Object.keys(mlm.SCAN_ROUTES);
  if (!hostname || !type || !types.includes(type.toLowerCase())) {
    await respond({ response_type: 'ephemeral', text: `Usage: \`/managelm scan <hostname> <${types.join('|')}>\`` });
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

/** /managelm search <kind> [text] — search the fleet. */
async function handleSearch(args: string[], respond: Respond): Promise<void> {
  const [kindArg, ...rest] = args;
  const kind = (kindArg || '').toLowerCase();
  const spec = SEARCHES[kind];
  if (!spec) {
    await respond({ response_type: 'ephemeral', text: `Usage: \`/managelm search <${Object.keys(SEARCHES).join('|')}> [text]\`` });
    return;
  }

  const data = await mlm.search(spec.route, { query: rest.join(' ') });
  const rows = (data[spec.rows] as Row[] | undefined) || [];
  if (rows.length === 0) {
    await respond({ response_type: 'ephemeral', text: `No ${kind} found.` });
    return;
  }

  const lines = rows.slice(0, SEARCH_LINES).map(r => spec.line(escapeStrings(r)));
  const more = rows.length > SEARCH_LINES ? `\n_…and ${rows.length - SEARCH_LINES} more. Narrow the search or open the portal._` : '';
  await respond({
    response_type: 'ephemeral',
    blocks: [section(`*${rows.length} ${kind}*\n${lines.join('\n')}${more}`)],
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
            '`/managelm run` — Open task form (or inline: `/managelm run <host> <skill> <instruction>`)',
            '`/managelm task <task_id>` — Show a task\'s status and result',
            '`/managelm answer <task_id> <answer>` — Answer a task waiting for input',
            `\`/managelm scan <host> <${Object.keys(mlm.SCAN_ROUTES).join('|')}>\` — Start a scan`,
            `\`/managelm search <${Object.keys(SEARCHES).join('|')}> [text]\` — Search your fleet`,
            '`/managelm help` — Show this help message',
            '',
            `_Connected to ${config.portalPublicUrl}. Approving agents and other settings are done in the portal._`,
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
  if (task.status === 'needs_input') fields.push(`_Answer with_ \`/managelm answer ${esc(task.id)} <your answer>\``);

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
 * Open a modal for structured task submission. `channelId` is the channel the
 * command was typed in; it rides in private_metadata (set by the app, not
 * editable by the user) so the submission can be checked against
 * SLACK_ALLOWED_CHANNELS too.
 */
async function openRunModal(client: WebClient, triggerId: string, channelId: string): Promise<void> {
  // Online agents and the account's skills for the dropdowns, fetched together:
  // Slack's trigger_id expires 3 s after the command. Slack caps a static select
  // at 100 options.
  const [agents, skills] = await Promise.allSettled([mlm.listAgentSummaries(), mlm.listSkills()]);

  let agentOptions: Option[] = agents.status === 'fulfilled'
    ? agents.value.filter(a => a.status === 'online').slice(0, 100).map(a => option(hostLabel(a), a.id))
    : [];
  if (agentOptions.length === 0) {
    agentOptions = [option('No online agents', '_none_')];
  }

  // "Auto" first: the agent picks the skill from the instruction. Keep Auto
  // only when the skills could not be listed.
  const skillOptions: Option[] = [option('Auto (agent picks the skill)', 'auto')];
  if (skills.status === 'fulfilled') {
    skillOptions.push(...skills.value.slice(0, 99).map(s => option(s.name, s.slug)));
  }

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

    if (agentId === '_none_') {
      await ack({ response_action: 'errors', errors: { agent_block: 'No online agents available' } });
      return;
    }

    if (!agentId || !skill || !instruction) {
      await ack({ response_action: 'errors', errors: { instruction_block: 'All fields are required' } });
      return;
    }

    await ack();

    // Progress and result go to the info or alerts channel; with neither
    // configured, to the submitting user as a direct message from the app.
    const channel = config.channelInfo || config.channelAlerts || body.user.id;

    try {
      const agent = await mlm.getAgent(agentId);
      const agentName = hostLabel(agent);

      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: `:hourglass_flowing_sand: Running task on \`${esc(agentName)}\`...\n*Skill:* ${esc(skill)}\n*Instruction:* ${esc(instruction)}`,
      });

      const outcome = await mlm.runTask(agentId, skill, instruction);
      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: outcomeText(outcome, agentName, skill),
      });
    } catch (err: unknown) {
      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: `:x: Task failed: ${esc(errorMessage(err, 'Task failed'))}`,
      }).catch(() => {});
    }
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

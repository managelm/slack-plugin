/**
 * Slack command handlers, interactive actions, and modal views.
 *
 * Slash command: /managelm <subcommand> [args]
 *   status                    — list agents with online/offline state
 *   approve <hostname>        — approve a pending agent
 *   run [hostname skill ...]  — open modal (no args) or submit inline
 *   help                      — show available commands
 *
 * Modal: run_task_modal
 *   Opened by `/managelm run` (no args) — lets user pick agent, skill,
 *   and type an instruction in a structured form.
 *
 * Actions (buttons in messages):
 *   approve_agent   — approve a pending agent (from enrollment notification)
 *   view_task       — fetch and display task details
 */

import type { App, SlackCommandMiddlewareArgs, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import * as mlm from './managelm.js';
import { config } from './config.js';
import { STATUS_ICONS } from './formatters.js';

// ─── Slash command ───────────────────────────────────────────────────

export function registerCommands(app: App): void {
  app.command('/managelm', async ({ command, ack, respond, client }) => {
    await ack();

    const args = command.text.trim().split(/\s+/);
    const subcommand = (args[0] || 'help').toLowerCase();

    try {
      switch (subcommand) {
        case 'status':
          await handleStatus(respond);
          break;
        case 'approve':
          await handleApprove(args.slice(1), respond);
          break;
        case 'run':
          // No args → open modal; with args → inline execution
          if (args.length < 4) {
            await openRunModal(client, command.trigger_id);
          } else {
            await handleRun(args.slice(1), respond);
          }
          break;
        case 'help':
        default:
          await handleHelp(respond);
          break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await respond({ response_type: 'ephemeral', text: `:x: Error: ${message}` });
    }
  });
}

type Respond = SlackCommandMiddlewareArgs['respond'];

/** /managelm status — list all agents with their state. */
async function handleStatus(respond: Respond): Promise<void> {
  const agents = await mlm.listAgents();

  if (agents.length === 0) {
    await respond({ response_type: 'ephemeral', text: 'No agents found.' });
    return;
  }

  // Sort: online first, then offline, then pending
  const order: Record<string, number> = { online: 0, offline: 1, pending: 2 };
  agents.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  const lines = agents.map(a => {
    const icon = STATUS_ICONS[a.status] || ':grey_question:';
    const name = a.display_name || a.hostname;
    const ip = a.ip_address ? ` (${a.ip_address})` : '';
    return `${icon} \`${name}\`${ip} — ${a.status}`;
  });

  const online = agents.filter(a => a.status === 'online').length;
  const summary = `*${agents.length} agents* (${online} online)\n\n${lines.join('\n')}`;

  await respond({
    response_type: 'in_channel',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summary },
      },
    ],
  });
}

/** /managelm approve <hostname> — approve a pending agent. */
async function handleApprove(args: string[], respond: Respond): Promise<void> {
  const hostname = args[0];
  if (!hostname) {
    await respond({ response_type: 'ephemeral', text: 'Usage: `/managelm approve <hostname>`' });
    return;
  }

  const agent = await mlm.findAgentByHostname(hostname);
  if (!agent) {
    await respond({ response_type: 'ephemeral', text: `:x: No agent found matching \`${hostname}\`` });
    return;
  }

  if (agent.status !== 'pending') {
    await respond({ response_type: 'ephemeral', text: `:information_source: Agent \`${agent.hostname}\` is already ${agent.status}.` });
    return;
  }

  await mlm.approveAgent(agent.id);
  await respond({
    response_type: 'in_channel',
    text: `:white_check_mark: Agent \`${agent.hostname}\` has been approved.`,
  });
}

/** /managelm run <hostname> <skill> <instruction...> — inline task submit. */
async function handleRun(args: string[], respond: Respond): Promise<void> {
  const [hostname, skill, ...rest] = args;
  const instruction = rest.join(' ');

  const agent = await mlm.findAgentByHostname(hostname);
  if (!agent) {
    await respond({ response_type: 'ephemeral', text: `:x: No agent found matching \`${hostname}\`` });
    return;
  }

  if (agent.status !== 'online') {
    await respond({ response_type: 'ephemeral', text: `:x: Agent \`${agent.hostname}\` is ${agent.status}. It must be online to run tasks.` });
    return;
  }

  await respond({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: Running task on \`${agent.hostname}\`...\n*Skill:* ${skill}\n*Instruction:* ${instruction}`,
  });

  try {
    const result = await mlm.runTask(agent.id, skill, instruction);
    const task = result.task;

    if (task.status === 'needs_input') {
      const question = task.question || 'The agent needs more information.';
      await respond({
        response_type: 'in_channel',
        replace_original: false,
        text: `:question: *Input needed* on \`${agent.hostname}\`\n*Skill:* ${skill}\n*Question:* ${question}\n_Answer in the portal or via API: \`POST /api/tasks/${task.id}/answer\`_`,
      });
      return;
    }

    const status = task.status === 'completed' ? ':white_check_mark:'
      : task.status === 'timeout' ? ':hourglass:' : ':x:';
    const summary = task.status === 'timeout'
      ? 'Task timed out — the agent did not respond in time'
      : (task.summary || task.error_message || 'No output');

    await respond({
      response_type: 'in_channel',
      replace_original: false,
      text: `${status} *Task ${task.status}* on \`${agent.hostname}\`\n*Skill:* ${skill}\n*Result:* ${summary}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Task failed';
    await respond({
      response_type: 'in_channel',
      replace_original: false,
      text: `:x: Task failed on \`${agent.hostname}\`: ${message}`,
    });
  }
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
            '`/managelm approve <hostname>` — Approve a pending agent',
            '`/managelm run` — Open task form (or inline: `/managelm run <host> <skill> <instruction>`)',
            '`/managelm help` — Show this help message',
            '',
            `_Connected to ${config.portalPublicUrl}_`,
          ].join('\n'),
        },
      },
    ],
  });
}

// ─── Run Task Modal ─────────────────────────────────────────────────

/** Open a modal for structured task submission. */
async function openRunModal(client: WebClient, triggerId: string): Promise<void> {
  // Fetch agents for the dropdown
  let agentOptions: { text: { type: 'plain_text'; text: string }; value: string }[] = [];
  try {
    const agents = await mlm.listAgents();
    agentOptions = agents
      .filter(a => a.status === 'online')
      .map(a => ({
        text: { type: 'plain_text' as const, text: a.display_name || a.hostname },
        value: a.id,
      }));
  } catch {
    // Fall back to empty — user can still type a hostname
  }

  if (agentOptions.length === 0) {
    agentOptions = [{ text: { type: 'plain_text', text: 'No online agents' }, value: '_none_' }];
  }

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'run_task_modal',
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
            options: [
              { text: { type: 'plain_text', text: 'Base (read-only)' }, value: 'base' },
              { text: { type: 'plain_text', text: 'System' }, value: 'system' },
              { text: { type: 'plain_text', text: 'Packages' }, value: 'packages' },
              { text: { type: 'plain_text', text: 'Services' }, value: 'services' },
              { text: { type: 'plain_text', text: 'Users' }, value: 'users' },
              { text: { type: 'plain_text', text: 'Network' }, value: 'network' },
              { text: { type: 'plain_text', text: 'Security' }, value: 'security' },
              { text: { type: 'plain_text', text: 'Firewall' }, value: 'firewall' },
              { text: { type: 'plain_text', text: 'Docker' }, value: 'docker' },
              { text: { type: 'plain_text', text: 'Files' }, value: 'files' },
            ],
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
  app.view('run_task_modal', async ({ ack, view, client }) => {
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

    // Post progress to the user's DM or alerts channel
    const channel = config.channelInfo || config.channelAlerts || '';
    if (!channel) return;

    try {
      const agent = await mlm.getAgent(agentId);
      const agentName = agent.display_name || agent.hostname;

      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: `:hourglass_flowing_sand: Running task on \`${agentName}\`...\n*Skill:* ${skill}\n*Instruction:* ${instruction}`,
      });

      const result = await mlm.runTask(agentId, skill, instruction);
      const task = result.task;

      if (task.status === 'needs_input') {
        await client.chat.postMessage({
          token: config.slackBotToken,
          channel,
          text: `:question: *Input needed* on \`${agentName}\`\n*Question:* ${task.question || 'The agent needs more information.'}\n_Answer in the portal._`,
        });
        return;
      }

      const status = task.status === 'completed' ? ':white_check_mark:'
        : task.status === 'timeout' ? ':hourglass:' : ':x:';
      const summary = task.status === 'timeout'
        ? 'Task timed out — the agent did not respond in time'
        : (task.summary || task.error_message || 'No output');

      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: `${status} *Task ${task.status}* on \`${agentName}\`\n*Skill:* ${skill}\n*Result:* ${summary}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Task failed';
      await client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: `:x: Task failed: ${message}`,
      }).catch(() => {});
    }
  });
}

// ─── Interactive actions (buttons) ───────────────────────────────────

export function registerActions(app: App): void {
  // "Approve" button from agent.enrolled notification
  app.action<BlockAction<ButtonAction>>('approve_agent', async ({ action, ack, respond }) => {
    await ack();
    const agentId = action.value ?? '';
    if (!agentId) return;

    try {
      const agent = await mlm.getAgent(agentId);

      if (agent.status !== 'pending') {
        await respond({ response_type: 'ephemeral', text: `:information_source: Agent \`${agent.hostname}\` is already ${agent.status}.` });
        return;
      }

      await mlm.approveAgent(agentId);
      await respond({
        response_type: 'in_channel',
        replace_original: false,
        text: `:white_check_mark: Agent \`${agent.hostname}\` has been approved.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await respond({ response_type: 'ephemeral', text: `:x: Failed to approve agent: ${message}` });
    }
  });

  // "View Details" button from task notifications
  app.action<BlockAction<ButtonAction>>('view_task', async ({ action, ack, respond }) => {
    await ack();
    const taskId = action.value ?? '';
    if (!taskId) return;

    try {
      const task = await mlm.getTask(taskId);
      const status = STATUS_ICONS[task.status] || ':grey_question:';

      const fields: string[] = [
        `*Status:* ${task.status}`,
        `*Skill:* ${task.skill_slug}`,
      ];
      if (task.question) fields.push(`*Question:* ${task.question}`);
      if (task.summary) fields.push(`*Summary:* ${task.summary}`);
      if (task.error_message) fields.push(`*Error:* ${task.error_message}`);
      if (task.mutating) fields.push(':warning: _This task made changes_');
      if (task.completed_at) fields.push(`*Completed:* ${task.completed_at}`);

      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${status} *Task Details* (\`${taskId}\`)\n${fields.join('\n')}`,
            },
          },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await respond({ response_type: 'ephemeral', text: `:x: Failed to fetch task: ${message}` });
    }
  });

  // Catch-all for link buttons (no-op, they just open URLs)
  app.action(/^link_/, async ({ ack }) => {
    await ack();
  });
}

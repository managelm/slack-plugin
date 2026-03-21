/**
 * Slack command handlers, interactive actions, and ManageLM webhook receiver.
 *
 * Slash command: /managelm <subcommand> [args]
 *   status                    — list agents with online/offline state
 *   approve <hostname>        — approve a pending agent
 *   run <hostname> <skill> <instruction>  — submit a task
 *   help                      — show available commands
 *
 * Actions (buttons in messages):
 *   approve_agent   — approve a pending agent (from enrollment notification)
 *   view_task       — fetch and display task details
 */

import type { App, SlackCommandMiddlewareArgs, BlockAction, ButtonAction } from '@slack/bolt';
import * as mlm from './managelm.js';
import { config } from './config.js';

// ─── Slash command ───────────────────────────────────────────────────

export function registerCommands(app: App): void {
  app.command('/managelm', async ({ command, ack, respond }) => {
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
          await handleRun(args.slice(1), respond);
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

  const statusIcon: Record<string, string> = {
    online: ':large_green_circle:',
    offline: ':red_circle:',
    pending: ':yellow_circle:',
  };

  const lines = agents.map(a => {
    const icon = statusIcon[a.status] || ':grey_question:';
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

/** /managelm run <hostname> <skill> <instruction...> — submit a task. */
async function handleRun(args: string[], respond: Respond): Promise<void> {
  if (args.length < 3) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/managelm run <hostname> <skill> <instruction>`\nExample: `/managelm run web-prod-01 packages List outdated packages`',
    });
    return;
  }

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

  // Acknowledge immediately — task may take a while
  await respond({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: Running task on \`${agent.hostname}\`...\n*Skill:* ${skill}\n*Instruction:* ${instruction}`,
  });

  try {
    const result = await mlm.runTask(agent.id, skill, instruction);
    const task = result.task;
    const status = task.status === 'completed' ? ':white_check_mark:' : ':x:';
    const summary = task.summary || task.error_message || 'No output';

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
            '`/managelm run <hostname> <skill> <instruction>` — Run a task on an agent',
            '`/managelm help` — Show this help message',
            '',
            `_Connected to ${config.portalPublicUrl}_`,
          ].join('\n'),
        },
      },
    ],
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
      const status = task.status === 'completed' ? ':white_check_mark:' : ':x:';

      const fields: string[] = [
        `*Status:* ${task.status}`,
        `*Skill:* ${task.skill_slug}`,
      ];
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

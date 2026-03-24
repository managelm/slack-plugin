/**
 * ManageLM portal API client.
 * Wraps fetch with authentication and error handling.
 */

import { config } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  hostname: string;
  display_name: string | null;
  status: 'online' | 'offline' | 'pending';
  health_metrics: Record<string, unknown> | null;
  tags: string[] | null;
  llm_model: string | null;
  agent_version: string | null;
  os_info: Record<string, unknown> | null;
  ip_address: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  agent_id: string;
  skill_slug: string;
  operation: string;
  status: 'sent' | 'running' | 'completed' | 'failed' | 'timeout' | 'needs_input' | 'answered';
  error_message: string | null;
  summary: string | null;
  question: string | null;
  mutating: boolean;
  created_at: string;
  completed_at: string | null;
  response_payload: string | null;
}

export interface TaskSubmitResult {
  task: Task;
  result: unknown;
}

// ─── HTTP helpers ────────────────────────────────────────────────────

/** Default timeout for API requests (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Extended timeout for synchronous task execution (wait=true). */
const TASK_TIMEOUT_MS = 120_000;

class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function api<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${config.portalUrl}/api${endpoint}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const init: RequestInit = { method, headers, signal: controller.signal };
  if (body && method !== 'GET' && method !== 'DELETE') {
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Handle non-JSON responses (e.g. 502 from reverse proxy)
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status} (non-JSON response)`);
    throw new ApiError(res.status, 'Unexpected non-JSON response from portal');
  }

  const json = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    throw new ApiError(res.status, (json.error as string) || `HTTP ${res.status}`);
  }

  return json as T;
}

// ─── Agents ──────────────────────────────────────────────────────────

/** List all agents visible to the API key. */
export async function listAgents(): Promise<Agent[]> {
  const data = await api<{ agents: Agent[] }>('GET', '/agents');
  return data.agents;
}

/** Get a single agent by ID. */
export async function getAgent(agentId: string): Promise<Agent> {
  const data = await api<{ agent: Agent }>('GET', `/agents/${encodeURIComponent(agentId)}`);
  return data.agent;
}

/** Approve a pending agent. */
export async function approveAgent(agentId: string): Promise<void> {
  await api('POST', `/agents/${encodeURIComponent(agentId)}/approve`);
}

/** Find an agent by hostname or display name (exact match first, then partial). */
export async function findAgentByHostname(hostname: string): Promise<Agent | null> {
  const agents = await listAgents();
  const lower = hostname.toLowerCase();
  return (
    agents.find(a =>
      a.hostname.toLowerCase() === lower ||
      (a.display_name && a.display_name.toLowerCase() === lower),
    ) ||
    agents.find(a =>
      a.hostname.toLowerCase().includes(lower) ||
      (a.display_name && a.display_name.toLowerCase().includes(lower)),
    ) ||
    null
  );
}

// ─── Tasks ───────────────────────────────────────────────────────────

/** Submit a task and wait for the result (120s timeout). */
export async function runTask(agentId: string, skillSlug: string, instruction: string): Promise<TaskSubmitResult> {
  return api<TaskSubmitResult>('POST', '/tasks?wait=true', {
    agent_id: agentId,
    skill_slug: skillSlug,
    instruction,
  }, TASK_TIMEOUT_MS);
}

/** Get task status by ID. */
export async function getTask(taskId: string): Promise<Task> {
  const data = await api<{ task: Task }>('GET', `/tasks/${encodeURIComponent(taskId)}`);
  return data.task;
}

/** Answer a question from an interactive task (needs_input). */
export async function answerTask(taskId: string, answer: string): Promise<TaskSubmitResult> {
  return api<TaskSubmitResult>('POST', `/tasks/${encodeURIComponent(taskId)}/answer?wait=true`, {
    answer,
  }, TASK_TIMEOUT_MS);
}

/** Get file changes made by a task. */
export async function getTaskChanges(taskId: string): Promise<Record<string, unknown>> {
  const data = await api<{ changeset: Record<string, unknown> }>('GET', `/tasks/${encodeURIComponent(taskId)}/changes`);
  return data.changeset;
}

/** Revert file changes from a task. */
export async function revertTask(taskId: string): Promise<Record<string, unknown>> {
  return api('POST', `/tasks/${encodeURIComponent(taskId)}/revert`);
}

// ─── Search ──────────────────────────────────────────────────────────

/** Search agents by health, OS, status, group, or free text. */
export async function searchAgents(params: Record<string, string | number>): Promise<any[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '') qs.set(k, String(v)); }
  const data = await api<{ agents: any[] }>('GET', `/search/agents?${qs}`);
  return data.agents;
}

/** Search inventory items across all agents. */
export async function searchInventory(params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) qs.set(k, v); }
  const data = await api<{ items: any[] }>('GET', `/search/inventory?${qs}`);
  return data.items;
}

/** Search security findings across all agents. */
export async function searchSecurity(params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) qs.set(k, v); }
  const data = await api<{ findings: any[] }>('GET', `/search/security?${qs}`);
  return data.findings;
}

/** Search SSH keys across infrastructure. */
export async function searchSshKeys(params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) qs.set(k, v); }
  return api('GET', `/search/ssh-keys?${qs}`);
}

/** Search sudo rules across infrastructure. */
export async function searchSudoRules(params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) qs.set(k, v); }
  const data = await api<{ rules: any[] }>('GET', `/search/sudo-rules?${qs}`);
  return data.rules;
}

// ─── Email ───────────────────────────────────────────────────────────

/** Send an email to the authenticated user. */
export async function sendEmail(subject: string, body: string): Promise<Record<string, unknown>> {
  return api('POST', '/email', { subject, body });
}

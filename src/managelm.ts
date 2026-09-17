/**
 * ManageLM portal API client.
 * Wraps fetch with authentication and error handling.
 *
 * The API key reaches the same features as the ManageLM MCP server (tasks,
 * scans, searches). Portal management — approving agents, users, webhooks —
 * is done in the portal, not through a key.
 */

import { config } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

/** The agent fields the portal's light list (GET /api/agents?view=basic) carries. */
export interface AgentSummary {
  id: string;
  hostname: string;
  display_name: string | null;
  status: 'online' | 'offline' | 'approved' | 'pending_approval' | 'revoked';
  tags: string[] | null;
  agent_version: string | null;
  os_info: string | null;
  last_seen_at: string | null;
}

/** A full agent row (GET /api/agents, GET /api/agents/:id). */
export interface Agent extends AgentSummary {
  health_metrics: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  agent_id: string;
  skill_slug: string;
  operation: string;
  status: 'sent' | 'completed' | 'failed' | 'timeout' | 'needs_input' | 'answered';
  error_message: string | null;
  summary: string | null;
  question: string | null;
  mutating: boolean;
  created_at: string;
  completed_at: string | null;
}

/** A task that finished within the wait, or one still running after it. */
export type TaskOutcome =
  | { task: Task; result: unknown }
  | { task_id: string; status: 'sent'; still_running: true };

export interface Skill {
  slug: string;
  name: string;
  node_type: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────────

/** Default timeout for API requests (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long the portal waits for a task before answering "still running"
 * (wait_seconds), and the client timeout that comfortably covers it. A task
 * that runs longer is not lost: the reply carries its ID to look up later.
 */
const TASK_WAIT_SECONDS = 100;
const TASK_TIMEOUT_MS = (TASK_WAIT_SECONDS + 15) * 1000;

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

/** Build a query string, skipping empty values. */
function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// ─── Agents ──────────────────────────────────────────────────────────

/** List all agents visible to the API key, with IP address and health metrics. */
export async function listAgents(): Promise<Agent[]> {
  const data = await api<{ agents: Agent[] }>('GET', '/agents');
  return data.agents;
}

/**
 * List all agents visible to the API key, names and status only. The full list
 * joins and returns every agent's metrics and settings, which on a large fleet
 * is megabytes for a dropdown or a name lookup.
 */
export async function listAgentSummaries(): Promise<AgentSummary[]> {
  const data = await api<{ agents: AgentSummary[] }>('GET', '/agents?view=basic');
  return data.agents;
}

/** Get a single agent by ID. */
export async function getAgent(agentId: string): Promise<Agent> {
  const data = await api<{ agent: Agent }>('GET', `/agents/${encodeURIComponent(agentId)}`);
  return data.agent;
}

/**
 * Resolve a host name typed in a command to one agent: a case-insensitive
 * exact match on hostname or display name, the rule of the portal's MCP
 * resolveSingleAgent. A partial name never selects a host. Commands run tasks
 * that change servers, and "web" with web01 and web02 would otherwise pick
 * whichever the portal happened to list first.
 *
 * Without exactly one match, `agent` is null and `candidates` is what the name
 * could have meant, for a "did you mean": the exact matches when several share
 * the name, else the partial ones. Empty candidates means not found.
 */
export async function findAgentByHostname(name: string): Promise<{ agent: AgentSummary | null; candidates: AgentSummary[] }> {
  const agents = await listAgentSummaries();
  const wanted = name.toLowerCase();
  const names = (a: AgentSummary) => [a.hostname, a.display_name].filter((n): n is string => !!n).map(n => n.toLowerCase());

  const exact = agents.filter(a => names(a).includes(wanted));
  if (exact.length === 1) return { agent: exact[0], candidates: [] };
  const candidates = exact.length > 1 ? exact : agents.filter(a => names(a).some(n => n.includes(wanted)));
  return { agent: null, candidates };
}

// ─── Skills ──────────────────────────────────────────────────────────

/** Skills in the account, one entry per slug (Linux and Windows share one). */
export async function listSkills(): Promise<Skill[]> {
  const data = await api<{ skills: Skill[] }>('GET', '/skills');
  const bySlug = new Map<string, Skill>();
  for (const s of data.skills) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Tasks ───────────────────────────────────────────────────────────

/** Submit a task and wait for the result, up to TASK_WAIT_SECONDS. */
export async function runTask(agentId: string, skillSlug: string, instruction: string): Promise<TaskOutcome> {
  return api<TaskOutcome>('POST', `/tasks?wait_seconds=${TASK_WAIT_SECONDS}`, {
    agent_id: agentId,
    skill_slug: skillSlug,
    instruction,
  }, TASK_TIMEOUT_MS);
}

/** Answer a question from an interactive task (needs_input) and wait for the resumed task. */
export async function answerTask(taskId: string, answer: string): Promise<TaskOutcome> {
  return api<TaskOutcome>('POST', `/tasks/${encodeURIComponent(taskId)}/answer?wait_seconds=${TASK_WAIT_SECONDS}`, {
    answer,
  }, TASK_TIMEOUT_MS);
}

/** Get task status by ID. */
export async function getTask(taskId: string): Promise<Task> {
  const data = await api<{ task: Task }>('GET', `/tasks/${encodeURIComponent(taskId)}`);
  return data.task;
}

// ─── Scans ───────────────────────────────────────────────────────────

/** Scan types, keyed by the name users type; the value is the portal route. */
export const SCAN_ROUTES: Record<string, string> = {
  security: 'security',
  inventory: 'inventory',
  access: 'sshkeys',
  certificates: 'certscan',
  activity: 'activity',
};

/** Start a scan on an agent. The result arrives as a report.* webhook event. */
export async function startScan(agentId: string, scanType: string): Promise<void> {
  const route = SCAN_ROUTES[scanType];
  if (!route) throw new Error(`Unknown scan type: ${scanType}`);
  await api('POST', `/${route}/${encodeURIComponent(agentId)}`);
}

// ─── Search ──────────────────────────────────────────────────────────

/** Call GET /api/search/<kind> and return the parsed body. */
export async function search(kind: string, params: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
  return api('GET', `/search/${kind}${query(params)}`);
}

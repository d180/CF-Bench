import type { Check, Run, Task } from './types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${String(response.status)})`;
    throw new Error(message);
  }
  return body as T;
}

export interface Config {
  zoneName: string;
  dashboardUrl: string;
}

export interface Status {
  pass: boolean;
  checks: Check[];
}

export const api = {
  tasks: () => request<Task[]>('/api/tasks'),
  runs: () => request<Run[]>('/api/runs'),
  config: () => request<Config>('/api/config'),
  status: (taskId: string) => request<Status>(`/api/tasks/${taskId}/status`),
  reset: (taskId: string) =>
    request<{ ok: boolean; message: string }>(`/api/tasks/${taskId}/reset`, { method: 'POST' }),
  grade: (taskId: string, body: { actor: 'human' | 'agent' }) =>
    request<{ runId: string; pass: boolean }>(`/api/tasks/${taskId}/grade`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

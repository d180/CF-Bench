export interface Task {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: string;
}

export interface Check {
  name: string;
  pass: boolean;
  kind: 'config' | 'http';
  detail: string;
}

export interface Run {
  id: string;
  task_id: string;
  actor: 'human' | 'agent';
  status: string;
  passed: number | null;
  created_at: string;
  graded_at: string | null;
  coasty_run_id: string | null;
  coasty_status: string | null;
  coasty_steps: number | null;
  coasty_cost_cents: number | null;
  video_url: string | null;
  notes: string | null;
  error: string | null;
  checks: Check[];
}

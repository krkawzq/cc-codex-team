export interface User {
  token: string;
  created_at: string;
  last_active_at?: string;
}

export interface SessionRecord {
  name: string;
  thread_id: string | null;
  state: "live";
  model?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  effort?: string;
  profile?: string;
  experimental_tools?: string[];
  created_at: string;
  last_active_at?: string;
  turn_count?: number;
  attached_to_user?: string;
  app_server_id?: string;
}

export interface TeamEvent {
  id: string;
  ts: string;
  type: string;
  session: string | null;
  thread_id: string | null;
  payload: Record<string, unknown>;
}

export interface DaemonInfo {
  pid: number;
  version: string;
  uptime_s: number;
  sock: string;
  data_dir: string;
  user_count: number;
  app_server_count: number;
  started_at: string;
}

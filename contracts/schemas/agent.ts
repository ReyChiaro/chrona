/** Public agent capabilities never contain a credential. */
export interface AgentStatus {
  mode: "api" | "disabled" | "unconfigured";
  model: string;
  configured: boolean;
  protocol: string;
}
export interface AgentConfiguration {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  timeoutSeconds: number;
  maxRounds: number;
  configured: boolean;
  mode: AgentStatus["mode"];
  protocol: string;
}
export interface AgentRun {
  requestId: string;
  mode: AgentStatus["mode"];
  status: string;
  phase: string;
  trace: unknown[];
  error?: string;
}

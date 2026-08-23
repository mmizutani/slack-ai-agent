import type { ModelRef } from "../agent/model";

/** Provider-neutral subagent configuration loaded from config/subagents. */
export interface SubagentDefinition {
  name: string;
  description: string;
  model?: ModelRef;
  instructions: string;
  tools?: string[];
  maxTurns?: number;
}

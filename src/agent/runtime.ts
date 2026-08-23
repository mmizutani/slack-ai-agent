import { AgentEvent, AgentRunRequest } from "./events";
import { AgentProviderId } from "../types";

export interface AgentRuntime {
  readonly provider: AgentProviderId;
  stream(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  resetSession?(session: AgentRunRequest["session"]): Promise<void> | void;
  close?(): Promise<void> | void;
}

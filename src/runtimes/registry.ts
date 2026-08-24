import { AgentConfigurationError } from "../agent/errors";
import { AgentRuntime } from "../agent/runtime";
import { AgentProviderId } from "../types";

export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<AgentProviderId, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.provider, runtime);
  }

  get(provider: AgentProviderId): AgentRuntime {
    const runtime = this.runtimes.get(provider);
    if (!runtime) {
      throw new AgentConfigurationError(
        `Agent runtime is not enabled: ${provider}`,
      );
    }
    return runtime;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map(runtime => runtime.close?.()),
    );
  }
}

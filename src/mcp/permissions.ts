import { ToolIdentity } from "../agent/events";

export interface EffectiveToolPolicy {
  role: string;
  allowed: string[];
  denied: string[];
  allowedTools: string[];
  disallowedTools: string[];
}

export function legacyToolIdentities(value: string): string[] {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(value);
  if (mcp) return [`mcp:${mcp[1]}/${mcp[2]}`];
  if (value === "Read") {
    return ["provider_native:anthropic/Read", "workspace/read_file"];
  }
  if (value === "Grep") {
    return ["provider_native:anthropic/Grep", "workspace/search_text"];
  }
  if (value === "Glob") {
    return ["provider_native:anthropic/Glob", "workspace/list_files"];
  }
  if (value.startsWith("Bash(")) {
    return [`provider_native:anthropic/${value}`];
  }
  if (
    /^(Task|Skill|Write|Edit|WebSearch|WebFetch|ReadMcpResource|ListMcpResources|Bash|ExitPlanMode|TodoWrite|BashOutput)$/.test(
      value,
    )
  ) {
    return [`provider_native:anthropic/${value}`];
  }
  if (
    /^(mcp|workspace|action)[:/]/.test(value) ||
    value.startsWith("provider_native:")
  ) {
    return [value];
  }
  return [];
}

/** Expand a denylist entry to the identities it blocks. */
export function denyIdentities(value: string): string[] {
  const identities = legacyToolIdentities(value);
  return identities.length > 0 ? identities : [value];
}

/** True when an identity is blocked, including Bash sub-tools under a Bash deny. */
export function isDenied(identity: string, denied: readonly string[]): boolean {
  if (denied.includes(identity)) return true;
  return (
    identity.startsWith("provider_native:anthropic/Bash(") &&
    denied.includes("provider_native:anthropic/Bash")
  );
}

function policyIdentities(value: string): string[] {
  // Legacy Read/Grep/Glob only grant their provider-native Claude tools by
  // default. OpenAI workspace aliases must be explicitly configured.
  return legacyToolIdentities(value).slice(
    0,
    value === "Read" || value === "Grep" || value === "Glob" ? 1 : undefined,
  );
}

export function toolIdentity(value: string): ToolIdentity | undefined {
  const canonical = legacyToolIdentities(value)[0];
  if (!canonical) return undefined;
  if (canonical.startsWith("mcp:")) {
    const [, server, ...parts] = canonical.split(/[/:]/);
    return { kind: "mcp", server, name: parts.join("/") };
  }
  const separator = canonical.indexOf(":");
  if (canonical.startsWith("workspace/")) {
    return { kind: "workspace", name: canonical.slice("workspace/".length) };
  }
  if (canonical.startsWith("action/")) {
    return { kind: "action", name: canonical.slice("action/".length) };
  }
  return {
    kind: "provider_native",
    name: separator === -1 ? canonical : canonical.slice(separator + 1),
  };
}

export function computeEffectiveToolPolicy(
  role: string | undefined,
  allowlist: Record<string, string[]>,
  denylist: string[],
): EffectiveToolPolicy {
  const hierarchy = Object.keys(allowlist);
  const index = role ? hierarchy.indexOf(role) : -1;
  const inherited =
    index < 0
      ? []
      : hierarchy.slice(0, index + 1).flatMap(name => allowlist[name] ?? []);
  const allowed = [...new Set(inherited.flatMap(policyIdentities))];
  const denied = [...new Set(denylist.flatMap(denyIdentities))];
  const effective = allowed.filter(value => !isDenied(value, denied));
  return {
    role: role ?? "none",
    allowed: effective,
    denied,
    allowedTools: effective,
    disallowedTools: denied,
  };
}

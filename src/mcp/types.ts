export type McpServerDefinition =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamable_http";
      url: string;
      headers?: Record<string, string>;
      headersHelper?: string;
      userEmailHeader?: string;
    }
  | {
      name: string;
      transport: "sse";
      url: string;
      headers?: Record<string, string>;
      headersHelper?: string;
      userEmailHeader?: string;
      legacy: true;
    };

export type ResolvedMcpServerDefinition =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamable_http" | "sse";
      url: string;
      headers?: Record<string, string>;
      legacy?: true;
    };

export interface RequesterIdentity {
  email?: string;
}

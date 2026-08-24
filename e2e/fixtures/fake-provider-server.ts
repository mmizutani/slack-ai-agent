import http from "http";
import type { AddressInfo } from "net";

export interface FakeProvider {
  url: string;
  /** Number of requests the provider under test actually made. */
  hits(): number;
  close(): Promise<void>;
}

/**
 * A local endpoint that fails every request.
 *
 * Used by the failure-path cycle instead of provoking a real provider outage:
 * pointing ANTHROPIC_BASE_URL or OPENAI_BASE_URL here makes the failure
 * deterministic, immediate and free, and it never bills a provider for a test
 * whose whole point is that the call does not succeed.
 */
export async function startFakeProvider(
  // 401, not 500. Both SDKs retry a 500 with backoff, so a failing endpoint
  // that returns one keeps the turn in flight well past any sane cycle
  // timeout and the user sees nothing at all. An auth failure is terminal, so
  // the error reaches Slack promptly — which is the behaviour under test.
  status = 401,
): Promise<FakeProvider> {
  let hits = 0;

  const server = http.createServer((req, res) => {
    hits += 1;
    // Drain the body so the client sees a complete request/response cycle
    // rather than a socket error, which exercises the SDK's error handling
    // rather than its transport handling.
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "injected failure",
          },
        }),
      );
    });
  });

  await new Promise<void>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

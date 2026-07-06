import { describe, expect, it, vi } from "vitest";
import { createMatrixQaCrablineSubstrate } from "./crabline-lifecycle.runtime.js";
import type { MatrixQaHarness } from "./harness.runtime.js";
import {
  createMatrixQaSubstrate,
  runMatrixQaLifecycleScenarios,
  type MatrixQaSubstrateRuntime,
} from "./lifecycle.js";
import { createMatrixQaTuwunelSubstrate } from "./tuwunel-lifecycle.runtime.js";

describe("Matrix QA substrate lifecycle", () => {
  it("passes the five lifecycle scenarios through the shared interface", async () => {
    let reachable = false;
    let runtimeSequence = 0;
    const substrate = createMatrixQaSubstrate<MatrixQaSubstrateRuntime>({
      id: "test",
      async start() {
        reachable = true;
        runtimeSequence += 1;
        return { baseUrl: "http://127.0.0.1:28008/" };
      },
      async stop() {
        reachable = false;
      },
    });
    const probe = vi.fn(async () => {
      expect(reachable).toBe(true);
    });

    const results = await runMatrixQaLifecycleScenarios({
      fetchImpl: async () => {
        if (!reachable) {
          throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
      },
      probe,
      substrate,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "cold-start",
      "idempotent-start",
      "restart",
      "stop",
      "resume",
    ]);
    expect(runtimeSequence).toBe(3);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(substrate.state.status).toBe("running");
  });

  it("keeps running state when stop fails", async () => {
    const runtime = { baseUrl: "http://127.0.0.1:28008/" };
    const substrate = createMatrixQaSubstrate({
      id: "test",
      async start() {
        return runtime;
      },
      async stop() {
        throw new Error("stop failed");
      },
    });
    await substrate.start();

    await expect(substrate.stop()).rejects.toThrow("stop failed");
    expect(substrate.state).toEqual({ runtime, status: "running" });
  });

  it("wraps Tuwunel harness start and cleanup", async () => {
    const stop = vi.fn(async () => {});
    const startMatrixQaHarness = vi.fn(async (params: { homeserverPort?: number }) => {
      expect(params.homeserverPort).toBe(
        startMatrixQaHarness.mock.calls.length > 1 ? 39123 : undefined,
      );
      return {
        homeserverPort: 39123,
        stop,
        upstreamBaseUrl: "http://127.0.0.1:28008/",
      } as unknown as MatrixQaHarness;
    });
    const substrate = createMatrixQaTuwunelSubstrate(
      { outputDir: "/tmp/matrix-qa" },
      { startMatrixQaHarnessImpl: startMatrixQaHarness },
    );

    const runtime = await substrate.start();
    await substrate.restart();
    await substrate.stop();

    expect(runtime.baseUrl).toBe("http://127.0.0.1:28008/");
    expect(startMatrixQaHarness).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("restarts Crabline on its original port with stable Matrix identity", async () => {
    const starts: Array<Record<string, unknown>> = [];
    const close = vi.fn(async () => {});
    const substrate = createMatrixQaCrablineSubstrate(
      { outputDir: "/tmp/matrix-qa" },
      {
        fetchImpl: async () => new Response("{}", { status: 200 }),
        async startMatrixServerImpl(params) {
          starts.push(params);
          return {
            close,
            manifest: {
              accessToken: params.accessToken,
              adminToken: params.adminToken,
              baseUrl: `http://127.0.0.1:${params.port ?? 34567}`,
              botUserId: params.botUserId,
              deviceId: params.deviceId,
              endpoints: {
                adminInboundUrl: "http://127.0.0.1/inbound",
                clientApiRoot: "http://127.0.0.1/_matrix/client/v3",
                syncUrl: "http://127.0.0.1/_matrix/client/v3/sync",
              },
              env: {
                MATRIX_ACCESS_TOKEN: params.accessToken,
                MATRIX_BASE_URL: "http://127.0.0.1:34567",
                MATRIX_USER_ID: params.botUserId,
              },
              provider: "matrix",
              recorderPath: params.recorderPath,
              version: 1,
            },
          };
        },
      },
    );

    const first = await substrate.start();
    const restarted = await substrate.restart();

    expect(first.baseUrl).toBe("http://127.0.0.1:34567");
    expect(restarted.baseUrl).toBe(first.baseUrl);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.port).toBe(34567);
    expect(starts[1]?.accessToken).toBe(starts[0]?.accessToken);
    expect(starts[1]?.botUserId).toBe(starts[0]?.botUserId);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

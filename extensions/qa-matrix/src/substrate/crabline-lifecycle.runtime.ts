import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createMatrixQaSubstrate } from "./lifecycle.js";

type MatrixQaCrablineManifest = {
  accessToken: string;
  baseUrl: string;
  botUserId: string;
};

type MatrixQaCrablineServer = {
  close(): Promise<void>;
  manifest: MatrixQaCrablineManifest;
};

type MatrixQaStartCrablineServer = (params: {
  accessToken: string;
  adminToken: string;
  botUserId: string;
  deviceId: string;
  port?: number;
  recorderPath: string;
  roomId: string;
  roomName: string;
  serverName: string;
}) => Promise<MatrixQaCrablineServer>;

export type MatrixQaCrablineRuntime = {
  baseUrl: string;
  roomId: string;
  server: MatrixQaCrablineServer;
};

function resolvePort(baseUrl: string) {
  const port = Number.parseInt(new URL(baseUrl).port, 10);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`Crabline Matrix server returned an invalid port: ${baseUrl}`);
  }
  return port;
}

async function waitForCrablineMatrixReady(params: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<unknown>;
}) {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await params.fetchImpl(new URL("_matrix/client/versions", params.baseUrl), {
        signal: AbortSignal.timeout(remainingMs),
      });
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
      lastError = new Error(`Crabline Matrix readiness returned HTTP ${response.status}`);
    } catch (error) {
      // A same-port restart can leave one stale Undici keepalive socket. Consume
      // that retry here so callers only observe the running lifecycle state.
      lastError = error;
    }
    await params.sleepImpl(25);
  }
  throw new Error("Crabline Matrix server did not become ready after restart", {
    cause: lastError,
  });
}

export function createMatrixQaCrablineSubstrate(
  params: {
    outputDir: string;
    roomId?: string;
    serverName?: string;
  },
  deps: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<unknown>;
    startMatrixServerImpl: MatrixQaStartCrablineServer;
  },
) {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleepImpl = deps?.sleepImpl ?? sleep;
  const { startMatrixServerImpl } = deps;
  const serverName = params.serverName?.trim() || "matrix-qa.test";
  const roomId = params.roomId?.trim() || `!matrix-qa-lifecycle:${serverName}`;
  const staticParams = {
    accessToken: `syt_matrix_qa_${randomUUID()}`,
    adminToken: `matrix-qa-${randomUUID()}`,
    botUserId: `@matrix-qa:${serverName}`,
    deviceId: "MATRIX_QA_CRABLINE",
    recorderPath: path.join(params.outputDir, "crabline-matrix.jsonl"),
    roomId,
    roomName: "Matrix QA Lifecycle",
    serverName,
  };
  let port: number | undefined;

  return createMatrixQaSubstrate<MatrixQaCrablineRuntime>({
    id: "crabline",
    async start() {
      const server = await startMatrixServerImpl({ ...staticParams, port });
      port ??= resolvePort(server.manifest.baseUrl);
      try {
        await waitForCrablineMatrixReady({
          baseUrl: server.manifest.baseUrl,
          fetchImpl,
          sleepImpl,
        });
      } catch (error) {
        // Readiness failure owns the lifecycle result. Cleanup is best-effort so
        // a secondary close error cannot hide the actionable startup failure.
        await server.close().catch(() => {});
        throw error;
      }
      return {
        baseUrl: server.manifest.baseUrl,
        roomId,
        server,
      };
    },
    async stop(runtime) {
      await runtime.server.close();
    },
  });
}

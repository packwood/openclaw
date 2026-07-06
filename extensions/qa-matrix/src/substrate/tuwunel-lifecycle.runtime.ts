import { startMatrixQaHarness, type MatrixQaHarness } from "./harness.runtime.js";
import { createMatrixQaSubstrate } from "./lifecycle.js";

export type MatrixQaTuwunelRuntime = {
  baseUrl: string;
  harness: MatrixQaHarness;
};

type MatrixQaTuwunelSubstrateDeps = NonNullable<Parameters<typeof startMatrixQaHarness>[1]> & {
  startMatrixQaHarnessImpl?: typeof startMatrixQaHarness;
};

export function createMatrixQaTuwunelSubstrate(
  params: Parameters<typeof startMatrixQaHarness>[0],
  deps?: MatrixQaTuwunelSubstrateDeps,
) {
  const { startMatrixQaHarnessImpl = startMatrixQaHarness, ...harnessDeps } = deps ?? {};
  let homeserverPort = params.homeserverPort;
  return createMatrixQaSubstrate<MatrixQaTuwunelRuntime>({
    id: "tuwunel",
    async start() {
      const harness = await startMatrixQaHarnessImpl(
        {
          ...params,
          ...(homeserverPort === undefined ? {} : { homeserverPort }),
        },
        harnessDeps,
      );
      homeserverPort ??= harness.homeserverPort;
      return {
        baseUrl: harness.upstreamBaseUrl,
        harness,
      };
    },
    async stop(runtime) {
      await runtime.harness.stop();
    },
  });
}

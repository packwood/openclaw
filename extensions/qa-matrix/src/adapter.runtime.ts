// Qa Matrix plugin module implements Matrix live transport adapter behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { createMatrixQaClient, provisionMatrixQaRoom } from "./substrate/client.js";
import { buildMatrixQaConfig } from "./substrate/config.js";
import type { MatrixQaObservedEvent } from "./substrate/events.js";
import { startMatrixQaHarness } from "./substrate/harness.runtime.js";
import { createMatrixQaRoomObserver } from "./substrate/sync.js";
import {
  findMatrixQaProvisionedRoom,
  type MatrixQaParticipantRole,
  type MatrixQaTopologySpec,
} from "./substrate/topology.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const MATRIX_SHARED_ROUTING_TOPOLOGY: MatrixQaTopologySpec = {
  defaultRoomKey: "main",
  rooms: [
    {
      key: "main",
      kind: "group",
      members: ["driver", "observer", "sut"],
      name: "OpenClaw Matrix QA Primary Room",
      requireMention: true,
    },
    {
      key: "secondary",
      kind: "group",
      members: ["driver", "observer", "sut"],
      name: "OpenClaw Matrix QA Secondary Room",
      requireMention: true,
    },
    {
      key: "dm",
      kind: "dm",
      members: ["driver", "sut"],
      name: "OpenClaw Matrix QA Driver DM",
    },
  ],
};

async function waitForMatrixChannelReady(
  gateway: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"],
  accountId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadline) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: Math.min(2_000, timeoutMs) },
        { timeoutMs: Math.min(5_000, timeoutMs) },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      lastAccounts = accounts;
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (
        account?.running === true &&
        account.connected === true &&
        account.restartPending !== true &&
        account.healthState !== "degraded"
      ) {
        return;
      }
    } catch {
      // Retry until the shared host readiness deadline.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
  throw new Error(
    `matrix account "${accountId}" did not become ready; last accounts: ${JSON.stringify(lastAccounts ?? [])}`,
  );
}

export async function createMatrixQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const repoRoot = options.repoRoot?.trim() || process.cwd();
  const harness = await startMatrixQaHarness({
    outputDir: path.join(context.outputDir, "matrix-harness"),
    repoRoot,
  });
  const suffix = randomUUID().slice(0, 8);
  let provisioning: Awaited<ReturnType<typeof provisionMatrixQaRoom>>;
  try {
    provisioning = await provisionMatrixQaRoom({
      baseUrl: harness.baseUrl,
      driverLocalpart: `qa-driver-${suffix}`,
      observerLocalpart: `qa-observer-${suffix}`,
      registrationToken: harness.registrationToken,
      roomName: `OpenClaw Matrix QA ${suffix}`,
      sutLocalpart: `qa-sut-${suffix}`,
      topology: MATRIX_SHARED_ROUTING_TOPOLOGY,
    });
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  const observedEvents: MatrixQaObservedEvent[] = [];
  const defaultRoomObserver = createMatrixQaRoomObserver({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
    observedEvents,
  });
  const secondaryRoomObserver = createMatrixQaRoomObserver({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
    observedEvents,
  });
  const dmObserver = createMatrixQaRoomObserver({
    accessToken: provisioning.driver.accessToken,
    baseUrl: harness.baseUrl,
    observedEvents,
  });
  try {
    await Promise.all([
      defaultRoomObserver.prime(),
      secondaryRoomObserver.prime(),
      dmObserver.prime(),
    ]);
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const driverClient = createMatrixQaClient({
    accessToken: provisioning.driver.accessToken,
    baseUrl: harness.baseUrl,
  });
  const observerClient = createMatrixQaClient({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
  });
  const defaultRoom = findMatrixQaProvisionedRoom(
    provisioning.topology,
    provisioning.topology.defaultRoomKey,
  );
  const secondaryRoom = findMatrixQaProvisionedRoom(provisioning.topology, "secondary");
  const dmRoom = findMatrixQaProvisionedRoom(provisioning.topology, "dm");
  const observationSources = [
    { observer: defaultRoomObserver, room: defaultRoom },
    { observer: secondaryRoomObserver, room: secondaryRoom },
    { observer: dmObserver, room: dmRoom },
  ];
  let stopped = false;
  let pollingError: Error | undefined;
  const logicalConversationByRoomId = new Map(
    provisioning.topology.rooms.map((room) => [
      room.roomId,
      {
        id: room.key,
        kind: room.kind === "dm" ? ("direct" as const) : ("group" as const),
      },
    ]),
  );
  const nativeEventIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = Promise.all(
    observationSources.map(async (source) => {
      for (;;) {
        if (stopped) {
          return;
        }
        const result = await source.observer.waitForOptionalRoomEvent({
          predicate: (event) => event.sender === provisioning.sut.userId,
          roomId: source.room.roomId,
          timeoutMs: 350,
        });
        if (!result.matched) {
          continue;
        }
        const event = result.event;
        const logicalConversation = logicalConversationByRoomId.get(source.room.roomId) ?? {
          id: source.room.key,
          kind: source.room.kind === "dm" ? ("direct" as const) : ("group" as const),
        };
        const outbound = await context.messages.addOutboundMessage({
          accountId,
          to: buildQaTarget({
            chatType: logicalConversation.kind,
            conversationId: logicalConversation.id,
          }),
          senderId: event.sender,
          text: event.body ?? "",
          timestamp: event.originServerTs,
          threadId:
            event.relatesTo?.relType === "m.thread" && event.relatesTo.eventId
              ? busMessageIds.get(event.relatesTo.eventId)
              : undefined,
          replyToId: event.relatesTo?.inReplyToId
            ? busMessageIds.get(event.relatesTo.inReplyToId)
            : undefined,
        });
        busMessageIds.set(event.eventId, outbound.id);
      }
    }),
  ).catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "matrix",
    label: "Matrix live",
    accountId,
    requiredPluginIds: ["matrix"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
    },
    async sendInbound(input) {
      const room =
        input.conversation.kind === "direct"
          ? dmRoom
          : input.conversation.id === "secondary"
            ? secondaryRoom
            : defaultRoom;
      logicalConversationByRoomId.set(room.roomId, {
        id: input.conversation.id,
        kind: input.conversation.kind === "direct" ? "direct" : "group",
      });
      const actorRole: MatrixQaParticipantRole =
        input.senderId === "observer" ? "observer" : "driver";
      const actor = provisioning[actorRole];
      const actorClient = actorRole === "observer" ? observerClient : driverClient;
      const hasPortableMention = input.text.includes("@openclaw");
      const body = input.text.replaceAll("@openclaw", provisioning.sut.userId);
      const eventId = await actorClient.sendTextMessage({
        body,
        mentionUserIds: hasPortableMention ? [provisioning.sut.userId] : undefined,
        replyToEventId: input.replyToId ? nativeEventIds.get(input.replyToId) : undefined,
        roomId: room.roomId,
        threadRootEventId: input.threadId ? nativeEventIds.get(input.threadId) : undefined,
      });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: actor.userId,
      });
      nativeEventIds.set(message.id, eventId);
      busMessageIds.set(eventId, message.id);
      return message;
    },
    resetTransport: () => {
      for (const room of provisioning.topology.rooms) {
        logicalConversationByRoomId.set(room.roomId, {
          id: room.key,
          kind: room.kind === "dm" ? "direct" : "group",
        });
      }
      nativeEventIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverAccessToken: provisioning.driver.accessToken,
        driverUserId: provisioning.driver.userId,
        homeserver: harness.baseUrl,
        observerAccessToken: provisioning.observer.accessToken,
        observerUserId: provisioning.observer.userId,
        sutAccessToken: provisioning.sut.accessToken,
        sutAccountId: accountId,
        sutDeviceId: provisioning.sut.deviceId,
        sutUserId: provisioning.sut.userId,
        topology: provisioning.topology,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForMatrixChannelReady(gateway, accountId, timeoutMs, pollIntervalMs),
    buildAgentDelivery: () => ({
      channel: "matrix",
      to: defaultRoom.roomId,
      replyChannel: "matrix",
      replyTo: defaultRoom.roomId,
    }),
    async handleAction() {
      throw new Error("Matrix live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the Matrix live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await harness.stop();
    },
  };
}

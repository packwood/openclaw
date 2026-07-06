package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelSummary
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerModelSelectionTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun successfulSelectionRecordsRecentAndUpdatesSelectedModel() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

      assertTrue(controller.setSessionModelAwait("main", " anthropic/claude-opus-4 "))

      assertEquals(listOf("anthropic/claude-opus-4"), recents)
      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals(
        "sessions.patch" to "{\"key\":\"main\",\"model\":\"anthropic/claude-opus-4\"}",
        requests.single(),
      )
    }

  @Test
  fun failedSelectionDoesNotRecordRecentOrUpdateSelectedModel() =
    runTest {
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> error("patch failed") },
          recordModelRecent = recents::add,
        )

      assertFalse(controller.setSessionModelAwait("main", "openai/gpt-5"))

      assertEquals(emptyList<String>(), recents)
      assertNull(controller.selectedModelRef.value)
      assertEquals("patch failed", controller.errorText.value)
    }

  @Test
  fun successfulDefaultSelectionDoesNotRecordRecent() =
    runTest {
      val requests = mutableListOf<String?>()
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, paramsJson ->
            requests += paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

      assertTrue(controller.setSessionModelAwait("main", null))

      assertEquals(emptyList<String>(), recents)
      assertEquals("{\"key\":\"main\",\"model\":null}", requests.single())
    }

  @Test
  fun immediateSendWaitsForPendingModelSelection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
                "{}"
              }
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5")
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()

      assertEquals(listOf("sessions.patch"), requests.filter { it == "sessions.patch" || it == "chat.send" })

      releasePatch.complete(Unit)
      assertTrue(send.await())
      assertEquals(
        listOf("sessions.patch", "chat.send"),
        requests.filter { it == "sessions.patch" || it == "chat.send" },
      )
    }

  @Test
  fun unsupportedReasoningSendsOffWithoutChangingStoredLevelAndRestoresAfterFlip() =
    runTest {
      val catalog =
        listOf(
          model(id = "plain", supportsReasoning = false),
          model(id = "reasoning", supportsReasoning = true),
        )
      val sentThinkingLevels = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            when (method) {
              "chat.send" -> {
                val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
                """{"runId":"run-${sentThinkingLevels.size}","status":"ok"}"""
              }
              else -> "{}"
            }
          },
          modelCatalog = { catalog },
        )
      controller.handleGatewayEvent("health", null)
      controller.setThinkingLevel("high")
      assertTrue(controller.setSessionModelAwait("main", "openai/plain"))

      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "plain model",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )
      assertEquals(listOf("off"), sentThinkingLevels)
      assertEquals("high", controller.thinkingLevel.value)

      assertTrue(controller.setSessionModelAwait("main", "openai/reasoning"))
      assertTrue(
        controller.sendMessageAwaitAcceptance(
          message = "reasoning restored",
          thinkingLevel = controller.thinkingLevel.value,
          attachments = emptyList(),
        ),
      )
      assertEquals(listOf("off", "high"), sentThinkingLevels)
      assertEquals("high", controller.thinkingLevel.value)
    }

  private fun model(
    id: String,
    supportsReasoning: Boolean,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id,
      provider = "openai",
      available = true,
      supportsVision = false,
      supportsAudio = false,
      supportsDocuments = false,
      supportsReasoning = supportsReasoning,
      contextTokens = null,
    )
}

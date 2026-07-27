import test from "node:test";
import assert from "node:assert/strict";

import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";

const fetchers = createExportPlatformFetchers({});
const internalText = "The user is asking a general question about Claude's features, so I should look up the relevant documentation.";
const answerText = "Here's a practical rundown of how to use Claude:";

function exportedText(messages) {
  return (messages || []).flatMap((message) => (
    (message.contentBlocks || []).map((block) => String(block && block.text || ""))
  )).join("\n");
}

test("Claude API export excludes structured thinking blocks and keeps final text", () => {
  const messages = fetchers.parseClaudeConversationPayload({
    chat_messages: [
      {
        sender: "assistant",
        content: [
          { type: "thinking", thinking: internalText },
          { type: "text", text: answerText }
        ]
      }
    ]
  });

  assert.equal(exportedText(messages).includes(internalText), false);
  assert.equal(exportedText(messages).includes(answerText), true);
});

test("Claude API export excludes text blocks marked internal by metadata", () => {
  const messages = fetchers.parseClaudeConversationPayload({
    chat_messages: [
      {
        sender: "assistant",
        content: [
          { type: "text", text: internalText, metadata: { is_thinking: true } },
          { type: "text", text: answerText }
        ]
      }
    ]
  });

  assert.equal(exportedText(messages).includes(internalText), false);
  assert.equal(exportedText(messages).includes(answerText), true);
});

test("Claude API export excludes hidden preamble messages", () => {
  const messages = fetchers.parseClaudeConversationPayload({
    chat_messages: [
      {
        sender: "assistant",
        metadata: { is_thinking_preamble_message: true },
        content: [{ type: "text", text: internalText }]
      },
      {
        sender: "assistant",
        content: [{ type: "text", text: answerText }]
      }
    ]
  });

  assert.equal(messages.length, 1);
  assert.equal(exportedText(messages).includes(internalText), false);
  assert.equal(exportedText(messages).includes(answerText), true);
});

test("Claude API export never removes normal prose based on wording alone", () => {
  const messages = fetchers.parseClaudeConversationPayload({
    chat_messages: [
      {
        sender: "human",
        content: [{ type: "text", text: internalText }]
      },
      {
        sender: "assistant",
        content: [{ type: "text", text: answerText }]
      }
    ]
  });

  assert.equal(exportedText(messages).includes(internalText), true);
  assert.equal(exportedText(messages).includes(answerText), true);
});

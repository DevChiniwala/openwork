import assert from "node:assert/strict"
import { test } from "node:test"
import { DM_CONTEXT_LIMIT, slackContextRequest } from "../src/slack-assistant/protocol.js"

test("a new top-level DM reads the DM's recent messages, so a DM Workbot sent just before is in its context", () => {
  assert.deepEqual(slackContextRequest({ channel_type: "im", ts: "1790000000.000200" }, "D012345", "1790000000.000200"), {
    method: "conversations.history",
    body: { channel: "D012345", latest: "1790000000.000200", inclusive: true, oldest: "1789913600.000200", limit: DM_CONTEXT_LIMIT },
  })
})

test("a reply in a thread, in a DM or a channel, still reads that thread", () => {
  const thread = { method: "conversations.replies", body: { channel: "D012345", ts: "1790000000.000100", limit: 30 } }
  assert.deepEqual(slackContextRequest({ channel_type: "im", ts: "1790000000.000200", thread_ts: "1790000000.000100" }, "D012345", "1790000000.000100"), thread)
  assert.deepEqual(slackContextRequest({ channel_type: "channel", ts: "1790000000.000100" }, "C012345", "1790000000.000100"), {
    method: "conversations.replies",
    body: { channel: "C012345", ts: "1790000000.000100", limit: 30 },
  })
  // Without a usable timestamp there's no window to read, so it falls back to the thread.
  assert.equal(slackContextRequest({ channel_type: "im", ts: "not-a-ts" }, "D012345", "not-a-ts").method, "conversations.replies")
})

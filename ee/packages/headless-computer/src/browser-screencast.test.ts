import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { WebSocketServer } from "ws"
import { streamBrowser } from "./browser-screencast.mjs"

/** A stand-in for Chromium's debugging endpoint: a tab list, and per-tab sockets that record commands. */
async function fakeChromium() {
  const commands: { tab: string; method: string; params: Record<string, unknown> }[] = []
  const tabs = new Map<string, import("ws").WebSocket>()
  let list: { id: string; url: string; title: string }[] = []
  const server = createServer((request, response) => {
    const { port } = server.address() as AddressInfo
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(list.map(tab => ({ ...tab, type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tab.id}` }))))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on("connection", (socket, request) => {
    const tab = request.url!.split("/").pop()!
    tabs.set(tab, socket)
    socket.on("message", data => {
      const { id, method, params } = JSON.parse(String(data))
      commands.push({ tab, method, params })
      socket.send(JSON.stringify({ id, result: {} }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    commands,
    show(next: typeof list) { list = next },
    frame(tab: string, sessionId: number) {
      tabs.get(tab)!.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: Buffer.from(`jpeg-${sessionId}`).toString("base64"), sessionId, metadata: {} } }))
    },
    close() { sockets.close(); server.close() },
  }
}

function fakeViewer() {
  const sent: (string | Buffer)[] = []
  return Object.assign(new EventEmitter(), { readyState: 1, sent, send(message: string | Buffer) { sent.push(message) } })
}

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check())
}

test("streams the front tab's frames and pages, acknowledging only frames the viewer drew", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }, { id: "b", url: "https://example.org/", title: "Other" }])
  const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20 })
  try {
    await until(() => chromium.commands.some(command => command.tab === "a" && command.method === "Page.startScreencast"))
    assert.deepEqual(JSON.parse(String(viewer.sent[0])), { type: "page", url: "https://example.com/", title: "Example" })

    chromium.frame("a", 7)
    chromium.frame("a", 8)
    await until(() => viewer.sent.filter(Buffer.isBuffer).length === 2)
    assert.equal(String(viewer.sent.find(Buffer.isBuffer)), "jpeg-7")
    assert.equal(chromium.commands.filter(command => command.method === "Page.screencastFrameAck").length, 0)

    viewer.emit("message", Buffer.from("ack"), false)
    await until(() => chromium.commands.some(command => command.method === "Page.screencastFrameAck"))
    assert.deepEqual(chromium.commands.filter(command => command.method === "Page.screencastFrameAck").map(command => command.params.sessionId), [7])

    // Bringing another tab to the front moves the stream to it.
    chromium.show([{ id: "b", url: "https://example.org/", title: "Other" }, { id: "a", url: "https://example.com/", title: "Example" }])
    await until(() => chromium.commands.some(command => command.tab === "b" && command.method === "Page.startScreencast"))
    await until(() => viewer.sent.some(message => typeof message === "string" && JSON.parse(message).url === "https://example.org/"))
  } finally { stop(); chromium.close() }
})

test("anything but an acknowledgement ends the stream, so a viewer cannot send input", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  let closed = false
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }])
  streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20, onClose: () => { closed = true } })
  try {
    await until(() => chromium.commands.some(command => command.method === "Page.startScreencast"))
    viewer.emit("message", Buffer.from('{"method":"Input.dispatchMouseEvent"}'), true)
    assert.equal(closed, true)
    const sent = chromium.commands.length
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(chromium.commands.length, sent)
  } finally { chromium.close() }
})

test("refuses a debugging address that isn't Chromium's own loopback endpoint", async () => {
  const viewer = fakeViewer()
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify([{ id: "a", type: "page", url: "https://example.com/", title: "Example", webSocketDebuggerUrl: "ws://attacker.example:9222/devtools/page/a" }]))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const stop = streamBrowser(viewer, { endpoint: `http://127.0.0.1:${port}`, pollMs: 20 })
  try {
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(viewer.sent.length, 0)
  } finally { stop(); server.close() }
})

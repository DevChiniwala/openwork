/**
 * Streams the browser's front tab to one viewer with Chromium's screencast instead of remote-desktop video. Chromium
 * sends a JPEG only when the page changes, and the next one only after the viewer acknowledges the last, so a slow
 * connection gets fewer frames instead of a growing backlog.
 *
 * To the viewer: binary messages are JPEG frames; text messages are JSON `{ type: "page", url, title }` whenever the
 * front tab or its address changes. From the viewer: the text "ack" after each drawn frame, and nothing else. The
 * viewer never reaches Chromium's debugging protocol itself, so it can watch but not drive the browser.
 */
export function streamBrowser(viewer, { endpoint = "http://127.0.0.1:9222", pollMs = 1000, quality = 70, maxWidth = 1600, maxHeight = 1200, onClose = () => {} } = {}) {
  let closed = false;
  let tab = null;
  let page = null;
  // Frames sent but not yet drawn, oldest first. Chromium holds back new frames while too many are outstanding.
  let unacknowledged = [];
  let timer;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    tab?.socket.close();
    onClose();
  };

  const deliver = (message) => { if (viewer.readyState === 1) viewer.send(message); };

  const sendPage = (target) => {
    const next = { type: "page", url: target.url, title: target.title };
    if (page?.url === next.url && page?.title === next.title) return;
    page = next;
    deliver(JSON.stringify(next));
  };

  const attach = (target) => {
    // Chromium may report its host in this URL. Never follow a remote endpoint.
    const address = new URL(target.webSocketDebuggerUrl);
    if (address.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== new URL(endpoint).port) throw new Error("Invalid Chromium endpoint.");
    const socket = new WebSocket(address);
    const current = { id: target.id, socket };
    let sequence = 0;
    const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++sequence, method, params }));
    socket.addEventListener("open", () => {
      send("Page.enable");
      send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
    });
    socket.addEventListener("message", (event) => {
      if (tab !== current || closed) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method !== "Page.screencastFrame") return;
      const { data, sessionId } = message.params;
      unacknowledged.push({ sessionId, send });
      deliver(Buffer.from(data, "base64"));
    });
    // The tab closing is picked up by the next poll; only the viewer's socket ends the stream.
    socket.addEventListener("close", () => { if (tab === current) tab = null; });
    socket.addEventListener("error", () => socket.close());
    return current;
  };

  const poll = async () => {
    if (closed) return;
    try {
      const response = await fetch(`${endpoint}/json/list`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      // Chromium lists page targets most recently activated first, so the first one is the tab in front.
      const front = response.ok ? (await response.json()).find((target) => target.type === "page" && target.webSocketDebuggerUrl) : undefined;
      if (closed) return;
      if (front && tab?.id !== front.id) {
        tab?.socket.close();
        unacknowledged = [];
        tab = attach(front);
      }
      if (front) sendPage(front);
    } catch {
      // A browser restart or a slow list leaves the last frame up; the next poll reattaches.
    }
    if (!closed) timer = setTimeout(poll, pollMs);
  };

  viewer.on("message", (data, binary) => {
    if (binary || String(data) !== "ack") return close();
    const frame = unacknowledged.shift();
    frame?.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  viewer.on("close", close);
  viewer.on("error", close);
  void poll();
  return close;
}

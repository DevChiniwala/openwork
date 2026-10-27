/**
 * Streams the browser's front tab to one viewer with Chromium's screencast instead of remote-desktop video. Chromium
 * sends a JPEG only when the page changes, and the next one only after the viewer acknowledges the last, so a slow
 * connection gets fewer frames instead of a growing backlog.
 *
 * To the viewer: binary messages are JPEG frames; text messages are JSON `{ type: "page", id, url, title, tabs }`
 * whenever the front tab, its address, or the open tabs change. `tabs` lists every open tab `{ id, url, title }` in the
 * order they opened, so the viewer can draw a tab strip that doesn't reshuffle as tabs come to the front.
 *
 * From the viewer: the text "ack" after each drawn frame, and `{ type: "tab", action: "activate" | "close", id }` for
 * one of those tabs. With `control` (the person took control) also pointer, wheel, key and text input for the front
 * tab, with positions as fractions of the frame. Anything else ends the stream. The viewer never reaches Chromium's
 * debugging protocol itself: the guest checks each message and sends only these commands.
 */
export function streamBrowser(viewer, { endpoint = "http://127.0.0.1:9222", control = false, pollMs = 1000, quality = 70, maxWidth = 1600, maxHeight = 1200, onClose = () => {} } = {}) {
  let closed = false;
  let tab = null;
  let page = null;
  // Tab ids in the order they first appeared; Chromium's own list reorders on every switch.
  let opened = [];
  // The front tab's viewport in CSS pixels, from the latest frame, to place input given as fractions of the frame.
  let viewport = null;
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

  const sendPage = (target, targets) => {
    const ids = new Set(targets.map((entry) => entry.id));
    opened = [...opened.filter((id) => ids.has(id)), ...targets.map((entry) => entry.id).filter((id) => !opened.includes(id))];
    const byId = new Map(targets.map((entry) => [entry.id, entry]));
    const tabs = opened.map((id) => { const { url, title } = byId.get(id); return { id, url, title }; });
    const next = JSON.stringify({ type: "page", id: target.id, url: target.url, title: target.title, tabs });
    if (page === next) return;
    page = next;
    deliver(next);
  };

  const attach = (target) => {
    // Chromium may report its host in this URL. Never follow a remote endpoint.
    const address = new URL(target.webSocketDebuggerUrl);
    if (address.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== new URL(endpoint).port) throw new Error("Invalid Chromium endpoint.");
    const socket = new WebSocket(address);
    let sequence = 0;
    const send = (method, params = {}) => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: ++sequence, method, params })); };
    const current = { id: target.id, socket, send };
    socket.addEventListener("open", () => {
      send("Page.enable");
      send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
    });
    socket.addEventListener("message", (event) => {
      if (tab !== current || closed) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method !== "Page.screencastFrame") return;
      const { data, sessionId, metadata } = message.params;
      if (metadata?.deviceWidth > 0 && metadata?.deviceHeight > 0) viewport = { width: metadata.deviceWidth, height: metadata.deviceHeight };
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
      const targets = response.ok ? (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl) : [];
      const front = targets[0];
      if (closed) return;
      if (front && tab?.id !== front.id) {
        tab?.socket.close();
        unacknowledged = [];
        viewport = null;
        tab = attach(front);
      }
      if (front) sendPage(front, targets);
    } catch {
      // A browser restart or a slow list leaves the last frame up; the next poll reattaches.
    }
    if (!closed) timer = setTimeout(poll, pollMs);
  };
  // After a tab command, show the result now instead of at the next poll.
  const pollSoon = () => { clearTimeout(timer); timer = setTimeout(poll, 50); };

  const tabCommand = async (action, id) => {
    try {
      const response = await fetch(`${endpoint}/json/${action}/${id}`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
    } catch {
      // The next poll shows whatever the browser has.
    }
    if (!closed) pollSoon();
  };

  const input = (message) => {
    const at = (x, y) => ({ x: x * viewport.width, y: y * viewport.height });
    if (message.type === "mouse") {
      const { x, y } = at(message.x, message.y);
      tab.send("Input.dispatchMouseEvent", { type: { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[message.event], x, y, button: message.button, buttons: message.buttons, clickCount: message.clickCount, modifiers: message.modifiers });
    } else if (message.type === "wheel") {
      const { x, y } = at(message.x, message.y);
      tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: message.modifiers });
    } else if (message.type === "key") {
      // A key that types sends its text with keyDown; editing and navigation keys need rawKeyDown with their key code.
      const type = message.event === "up" ? "keyUp" : message.text ? "keyDown" : "rawKeyDown";
      tab.send("Input.dispatchKeyEvent", { type, key: message.key, code: message.code, windowsVirtualKeyCode: message.keyCode, nativeVirtualKeyCode: message.keyCode, modifiers: message.modifiers, ...(type === "keyDown" ? { text: message.text, unmodifiedText: message.text } : {}) });
    } else if (message.type === "text") {
      tab.send("Input.insertText", { text: message.text });
    }
  };

  const receive = (data) => {
    const text = String(data);
    if (text === "ack") {
      const frame = unacknowledged.shift();
      frame?.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      return true;
    }
    let message;
    try { message = JSON.parse(text); } catch { return false; }
    if (message?.type === "tab") {
      if (!["activate", "close"].includes(message.action) || !opened.includes(message.id)) return false;
      // Closing the last tab would quit the browser, so keep it.
      if (message.action === "close" && opened.length <= 1) return true;
      void tabCommand(message.action, message.id);
      return true;
    }
    if (!control || !validInput(message)) return false;
    // Input before the first frame has nowhere to land; drop it rather than end the session.
    if (tab && viewport) input(message);
    return true;
  };

  viewer.on("message", (data, binary) => {
    if (binary || !receive(data)) close();
  });
  viewer.on("close", close);
  viewer.on("error", close);
  void poll();
  return close;
}

const fraction = (value) => typeof value === "number" && value >= 0 && value <= 1;
const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const delta = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000;
const name = (value) => typeof value === "string" && value.length <= 32;

/** True for input the person may send while they have control: exactly these shapes, nothing passed through. */
function validInput(message) {
  if (!message || typeof message !== "object") return false;
  const keys = Object.keys(message).sort().join();
  if (message.type === "mouse") {
    return keys === "button,buttons,clickCount,event,modifiers,type,x,y" && ["down", "up", "move"].includes(message.event) && fraction(message.x) && fraction(message.y)
      && ["none", "left", "middle", "right", "back", "forward"].includes(message.button) && count(message.buttons, 31) && count(message.clickCount, 3) && count(message.modifiers, 15);
  }
  if (message.type === "wheel") return keys === "deltaX,deltaY,modifiers,type,x,y" && fraction(message.x) && fraction(message.y) && delta(message.deltaX) && delta(message.deltaY) && count(message.modifiers, 15);
  if (message.type === "key") {
    return keys === "code,event,key,keyCode,modifiers,text,type" && ["down", "up"].includes(message.event) && name(message.key) && name(message.code)
      && count(message.keyCode, 255) && count(message.modifiers, 15) && typeof message.text === "string" && message.text.length <= 4;
  }
  if (message.type === "text") return keys === "text,type" && typeof message.text === "string" && message.text.length > 0 && message.text.length <= 10_000;
  return false;
}

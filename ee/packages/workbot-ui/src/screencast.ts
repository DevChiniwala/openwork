"use client";

import { z } from "zod";

const tabSchema = z.object({ id: z.string(), url: z.string(), title: z.string() });
// `id` and `tabs` (the open tabs, in the order they opened) are absent from computers built before them.
const pageSchema = z.object({ type: z.literal("page"), id: z.string().optional(), url: z.string(), title: z.string(), tabs: z.array(tabSchema).optional() });
export type ScreencastTab = z.infer<typeof tabSchema>;
export type ScreencastPage = Omit<z.infer<typeof pageSchema>, "type">;

/**
 * Draws the browser's front tab from the computer's screencast: JPEG frames over a WebSocket, each acknowledged once
 * drawn so the computer never queues more than the connection can show. It fires the events Workbot listens for on
 * noVNC ("connect" once the first frame is on screen, "disconnect" when the stream ends) plus "page" with the tab's
 * address, title and open tabs, since a page stream has no browser toolbar. The viewer can switch and close those tabs;
 * with `control` it also sends the person's pointer, wheel, keys and pasted text to the page.
 */
export class ScreencastViewer extends EventTarget {
  private readonly socket: WebSocket;
  private readonly canvas = document.createElement("canvas");
  private drawing = Promise.resolve();
  private drawn = false;
  private ended = false;
  /** The latest address and title the stream reported. */
  page: ScreencastPage | null = null;

  constructor(target: HTMLElement, url: string, { control = false }: { control?: boolean } = {}) {
    super();
    this.canvas.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;outline:none";
    target.append(this.canvas);
    if (control) this.forwardInput();
    this.socket = new WebSocket(url);
    this.socket.binaryType = "blob";
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { return; }
        const page = pageSchema.safeParse(payload);
        if (!page.success) return;
        this.page = { id: page.data.id, url: page.data.url, title: page.data.title, tabs: page.data.tabs };
        this.dispatchEvent(new CustomEvent<ScreencastPage>("page", { detail: this.page }));
        return;
      }
      const frame = event.data as Blob;
      this.drawing = this.drawing.then(() => this.draw(frame)).catch(() => this.disconnect());
    });
    this.socket.addEventListener("close", () => this.end());
    this.socket.addEventListener("error", () => this.end());
  }

  /** Whether a frame reached the screen; a stream that ends before one never connected. */
  get connected() { return this.drawn; }

  disconnect() { this.socket.close(); this.end(); }

  /** Puts the keyboard on the page, for typing into it with control. */
  focus() { this.canvas.focus({ preventScroll: true }); }

  /** Brings one of the browser's open tabs to the front, or closes it. */
  tab(action: "activate" | "close", id: string) { this.send({ type: "tab", action, id }); }

  private send(message: object) { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }

  /** Where a pointer event lands on the frame, as fractions of it; the frame is letterboxed inside the canvas box. */
  private position(event: MouseEvent) {
    const box = this.canvas.getBoundingClientRect();
    if (!this.canvas.width || !this.canvas.height || !box.width || !box.height) return null;
    const scale = Math.min(box.width / this.canvas.width, box.height / this.canvas.height);
    const width = this.canvas.width * scale, height = this.canvas.height * scale;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width;
    const y = (event.clientY - box.top - (box.height - height) / 2) / height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }

  private forwardInput() {
    const canvas = this.canvas;
    canvas.tabIndex = 0;
    canvas.style.cursor = "default";
    const modifiers = (event: MouseEvent | KeyboardEvent) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const buttons = ["left", "middle", "right", "back", "forward"] as const;
    const pointer = (kind: "down" | "up" | "move") => (event: PointerEvent) => {
      const at = this.position(event);
      if (!at) return;
      if (kind === "down") { canvas.focus(); canvas.setPointerCapture(event.pointerId); }
      event.preventDefault();
      this.send({ type: "mouse", event: kind, ...at, button: kind === "move" ? "none" : buttons[event.button] ?? "none", buttons: event.buttons & 31, clickCount: kind === "move" ? 0 : Math.min(Math.max(event.detail, 1), 3), modifiers: modifiers(event) });
    };
    canvas.addEventListener("pointerdown", pointer("down"));
    canvas.addEventListener("pointerup", pointer("up"));
    canvas.addEventListener("pointermove", pointer("move"));
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      const at = this.position(event);
      if (!at) return;
      event.preventDefault();
      // Lines and pages arrive as counts; the page expects pixels.
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, value * unit));
      this.send({ type: "wheel", ...at, deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY), modifiers: modifiers(event) });
    }, { passive: false });
    const key = (kind: "down" | "up") => (event: KeyboardEvent) => {
      // Paste goes through the paste event with its text; the computer's clipboard doesn't have it.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      if (event.isComposing || event.key.length > 32 || event.code.length > 32) return;
      event.preventDefault();
      const typed = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : event.key === "Enter" ? "\r" : "";
      this.send({ type: "key", event: kind, key: event.key, code: event.code, keyCode: event.keyCode & 255, modifiers: modifiers(event), text: kind === "down" ? typed : "" });
    };
    canvas.addEventListener("keydown", key("down"));
    canvas.addEventListener("keyup", key("up"));
    canvas.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      event.preventDefault();
      if (text) this.send({ type: "text", text: text.slice(0, 10_000) });
    });
  }

  private async draw(frame: Blob) {
    const image = await createImageBitmap(frame);
    if (this.ended) { image.close(); return; }
    if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    this.canvas.getContext("2d")?.drawImage(image, 0, 0);
    image.close();
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send("ack");
    if (!this.drawn) { this.drawn = true; this.dispatchEvent(new Event("connect")); }
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.dispatchEvent(new Event("disconnect"));
  }
}

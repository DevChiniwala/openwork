"use client";

import { z } from "zod";

const pageSchema = z.object({ type: z.literal("page"), url: z.string(), title: z.string() });
export type ScreencastPage = Omit<z.infer<typeof pageSchema>, "type">;

/**
 * Draws the browser's front tab from the computer's screencast: JPEG frames over a WebSocket, each acknowledged once
 * drawn so the computer never queues more than the connection can show. It fires the events Workbot listens for on
 * noVNC ("connect" once the first frame is on screen, "disconnect" when the stream ends) plus "page" with the tab's
 * address and title, since a page stream has no browser toolbar. View only: the stream accepts acknowledgements and
 * nothing else.
 */
export class ScreencastViewer extends EventTarget {
  private readonly socket: WebSocket;
  private readonly canvas = document.createElement("canvas");
  private drawing = Promise.resolve();
  private drawn = false;
  private ended = false;
  /** The latest address and title the stream reported. */
  page: ScreencastPage | null = null;

  constructor(target: HTMLElement, url: string) {
    super();
    this.canvas.style.cssText = "display:block;width:100%;height:100%;object-fit:contain";
    target.append(this.canvas);
    this.socket = new WebSocket(url);
    this.socket.binaryType = "blob";
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { return; }
        const page = pageSchema.safeParse(payload);
        if (!page.success) return;
        this.page = { url: page.data.url, title: page.data.title };
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

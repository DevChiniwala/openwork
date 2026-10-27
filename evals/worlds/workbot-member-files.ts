import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

type MemberFile = {
  id: string; path: string; name: string; mediaType: string; size: number; version: number;
  origin: { kind: "upload" | "agent" | "browser"; agent: string | null; url: string | null };
  lastWriter: { kind: "upload" | "agent" | "browser"; sessionId: string | null; messageId: string | null };
  createdAt: number; updatedAt: number;
};

/**
 * The real Workbot page (Vite, the client people load) with synthetic Workbot API answers for My files: a member whose
 * chat downloaded a statement in the browser and added it up, with files in Downloads, Workbot's own folder, Uploads and
 * a folder of their own. `?files=off` is the `memberFiles` feature off as `/v1/workbot/me` reports
 * it. Den and the runner are not involved; the runner's own end-to-end check covers the real files
 * (`pnpm --filter @openwork-ee/headless-runner member-files:e2e`).
 */
export async function workbotMemberFiles(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const now = Date.now();
  const deleted: string[] = [];
  const added: string[] = [];
  const statement = "date,description,amount\n2026-10-01,Coffee beans,18.50\n2026-10-03,Train ticket,23.50\n";
  const file = (id: string, path: string, mediaType: string, size: number, origin: MemberFile["origin"], at: number): MemberFile => ({
    id: `mf_${id.padEnd(32, "0")}`, path, name: path.split("/").pop() ?? path, mediaType, size, version: 1, origin,
    lastWriter: { kind: origin.kind, sessionId: "hs_c_fixture", messageId: "wb_turn_files" }, createdAt: at, updatedAt: at,
  });
  const files: MemberFile[] = [
    file("a1", "Downloads/october-statement.csv", "text/csv", statement.length, { kind: "browser", agent: null, url: "https://bank.example.test/statements/2026-10" }, now - 4 * 60_000),
    file("a2", "Downloads/train-receipt.pdf", "application/pdf", 182_400, { kind: "browser", agent: null, url: "https://rail.example.test/receipts/8812" }, now - 26 * 3_600_000),
    file("b1", "agents/workbot/october-total.txt", "text/plain", 14, { kind: "agent", agent: "workbot", url: null }, now - 3 * 60_000),
    file("b2", "agents/workbot/notes.md", "text/markdown", 1_204, { kind: "agent", agent: "workbot", url: null }, now - 2 * 86_400_000),
    file("c1", "Uploads/team-roster.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48_200, { kind: "upload", agent: null, url: null }, now - 5 * 86_400_000),
    file("d1", "Reports/q3-review.pdf", "application/pdf", 1_420_000, { kind: "agent", agent: "workbot", url: null }, now - 9 * 86_400_000),
  ];
  const answer = "I downloaded your October statement and added it up: **42.00** in total.\n\nThe statement is in [october-statement.csv](/files/Downloads/october-statement.csv) and the total in [october-total.txt](/files/agents/workbot/october-total.txt), both in My files.";
  const turns = [{
    id: "turn_files", text: "Download my October statement from the bank and add it up", sentAt: now - 5 * 60_000, finishedAt: now - 3 * 60_000, status: "done", attachments: [],
    outputs: [files[0], files[2]].flatMap((entry) => entry ? [{ id: entry.id, name: entry.name, mediaType: entry.mediaType, size: entry.size, updatedAt: entry.updatedAt }] : []),
    parts: [{ kind: "steps", steps: [
      { label: "Downloaded your statement", icon: "computer", status: "done", app: null, startedAt: now - 5 * 60_000, finishedAt: now - 4 * 60_000, updates: [], surface: "browser" },
    ] }, { kind: "text", text: answer }],
    modelSteps: 2, error: null,
  }];
  const chatFiles = [{ id: `fl_${"e1".padEnd(32, "0")}`, name: "expense-policy.pdf", mediaType: "application/pdf", size: 96_000, source: "user", createdAt: now - 6 * 60_000 }];
  try {
    const fixtureDir = await mkdtemp(join(tmpdir(), "workbot-member-files-"));
    resources.defer(() => rm(fixtureDir, { recursive: true, force: true }));
    const briefPath = join(fixtureDir, "project-brief.txt");
    await writeFile(briefPath, "Project brief: ship My files.");
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-member-files-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const referring = new URL(req.headers.referer ?? "http://fixture");
          const on = referring.searchParams.get("files") !== "off";
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") {
            return json({ name: "Alex Example", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: true, canSchedule: false, sideChats: true, memberFiles: on, denUrl: "https://workspace.example.test" });
          }
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: on ? turns : turns.map((turn) => ({ ...turn, outputs: [] })), hasEarlier: false, filesEnabled: true });
          if (url.pathname === "/v1/workbot/chats") return json({ main: { updatedAt: now - 3 * 60_000 }, side: [] });
          if (url.pathname === "/v1/workbot/files" && req.method === "GET") return json({ enabled: true, files: chatFiles });
          if (url.pathname === "/v1/workbot/my-files" && req.method === "GET") {
            if (!on) return json({ error: "feature_disabled" }, 404);
            if (referring.searchParams.get("empty") === "1") return json({ enabled: true, files: [], usage: { bytes: 0, files: 0, maxBytes: 10 * 1024 ** 3, maxFileBytes: 100 * 1024 ** 2 } });
            return json({ enabled: true, files, usage: { bytes: files.reduce((sum, entry) => sum + entry.size, 0), files: files.length, maxBytes: 10 * 1024 ** 3, maxFileBytes: 100 * 1024 ** 2 } });
          }
          if (url.pathname === "/v1/workbot/my-files" && req.method === "POST") {
            const name = url.searchParams.get("name") ?? "file";
            let size = 0;
            for await (const chunk of req) size += Buffer.byteLength(chunk);
            const created = file(`f${added.length + 1}`, `Uploads/${name}`, "text/plain", size, { kind: "upload", agent: null, url: null }, Date.now());
            files.push(created);
            added.push(created.path);
            return json(created, 201);
          }
          const memberFile = /^\/v1\/workbot\/files\/(mf_[a-f0-9]{32})(\/preview)?$/.exec(url.pathname);
          if (memberFile) {
            const found = files.find((entry) => entry.id === memberFile[1]);
            if (!found || memberFile[2]) return json({ error: "not_found" }, 404);
            if (req.method === "DELETE") {
              files.splice(files.indexOf(found), 1);
              deleted.push(found.path);
              res.statusCode = 204;
              return res.end();
            }
            res.setHeader("content-type", "application/octet-stream");
            return res.end(found.path.endsWith("october-statement.csv") ? statement : found.path.endsWith("october-total.txt") ? "Total: 42.00\n" : "fixture");
          }
          if (url.pathname === "/v1/workbot/connections") return json({ connections: [] });
          if (url.pathname === "/v1/workbot/events") { res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (url.pathname.endsWith("/calendar/v1/automations")) return json({ items: [], nextCursor: null });
          if (url.pathname.endsWith("/calendar/v1/automation-runs")) return json({ runs: [], nextCursor: null });
          if (url.pathname.includes("/calendar-events")) return json({ error: "needs_connection" }, 409);
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-member-files", startUrl: `${url}?files=off`, headless: true }));
    return {
      web,
      url,
      briefPath,
      deleted: () => [...deleted],
      added: () => [...added],
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}

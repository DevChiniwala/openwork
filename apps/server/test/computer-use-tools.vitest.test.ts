import { expect, test } from "vitest";
import { server } from "../src/opencode-plugins/openwork-computer-use.js";

test("the agent can discover computer tools on every desktop platform, including Linux VM clients", async () => {
  const plugin = await server();
  expect(plugin.tool.computer_discover).toBeDefined();
  expect(plugin.tool.computer_open).toBeDefined();
  expect(plugin.tool.computer_act).toBeDefined();
  expect(plugin.tool.computer_run).toBeDefined();
  expect(plugin.tool.computer_close).toBeDefined();
  expect(plugin.tool.computer_discover.description).toContain("selected computer");
});

test("app scripts ask the person first and run nothing when declined", async () => {
  const plugin = await server();
  const asked: unknown[] = [];
  const context = { sessionID: "chat", ask: async (request: unknown) => { asked.push(request); throw new Error("declined"); } };
  await expect(plugin.tool.computer_script.execute({ app: "blender", code: "result = 1" }, context)).rejects.toThrow("declined");
  expect(asked).toEqual([{ permission: "computer_script", patterns: ["blender"], always: ["blender"], metadata: { app: "blender", code: "result = 1" } }]);
});

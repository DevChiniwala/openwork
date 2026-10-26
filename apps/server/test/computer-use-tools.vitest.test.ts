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

test("app scripts are offered on this Mac and approved in OpenWork, not by an engine prompt", async () => {
  const plugin = await server();
  expect(plugin.tool.computer_script).toBeDefined();
  expect(plugin.tool.computer_script.description).toContain("full script");
  expect(Object.keys(plugin.tool.computer_script.args)).toEqual(["app", "code", "timeoutMs"]);
});

test("a Windows PC is not offered app scripting", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const plugin = await server();
    expect("computer_script" in plugin.tool).toBe(false);
    expect(plugin.tool.computer_open.description).toContain("Windows PC");
  } finally { Object.defineProperty(process, "platform", platform); }
});

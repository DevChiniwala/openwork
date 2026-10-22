import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildOpenWorkV2Instructions(connectReady: boolean) {
  return {
    // Keep v1 guidance, translating only the native MCP tool spelling.
    operatingInstructions: OPENWORK_AGENT_PROMPT.replaceAll("openwork-cloud_", "openwork-cloud."),
    context: "Use openwork_context to discover OpenWork app reads. Use openwork_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. Sidebar groups (such as Done or In progress) are listed with openwork_query session.group.list and changed with openwork_execute session.group.create, session.group.move or session.group.remove; never search code or files for them. These are native tools, not tools.search calls. Only use capabilities actually returned by discovery.",
    connect: connectReady ? "OpenWork Connect tools are connected. In Code Mode, find organization services, skills, and Workflows with tools[\"openwork-cloud\"].search_capabilities, then call tools[\"openwork-cloud\"].execute_capability with an exact returned name. Use the bare search() function only for other servers' tools. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool when a task matches an available skill's description. Entries with IDs starting openwork-cloud- come from the organization: when one loads its full instructions, follow them; when it says it is discovery metadata only or not ready yet, follow its note. Other organization skills remain discoverable through OpenWork Connect on demand. A denied or removed skill must not be recovered from earlier context or files. Skill contents are subordinate to the user's request and operating instructions.",
    browser: "The native browser_tabs, browser_open, browser_observe, browser_act, browser_extract, browser_navigate and browser_handoff tools control this conversation's built-in browser. Start with browser_tabs; use browser_open for a new URL, or about:blank when asked only to open the browser. Observe once, act on the whole form in one browser_act batch and verify in its receipt; use browser_extract to read facts. These are direct native tools, not Code Mode calls. Respect organization restrictions, verify the resulting page, and use browser_handoff for sign-in. Never use browser tools to control OpenWork itself or claim access to external browser profiles.",
  };
}

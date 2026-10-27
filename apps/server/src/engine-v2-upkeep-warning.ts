/**
 * Upkeep errors can contain workspace paths, local commands, or upstream error
 * bodies. Status is readable by client/viewer tokens, so only fixed summaries
 * belong there — never interpolate an error or try to recognize private paths.
 */
export function engineV2UpkeepWarning(message: string, at = new Date()): string {
  const summary = message.startsWith("Providers:")
    ? "Provider catalog refresh did not finish in time; serving the engine's catalog."
    : message.startsWith("MCP")
      ? "An MCP connection needs upkeep; requests can continue."
      : message.startsWith("History copy state:")
        ? "History copy progress could not be saved."
        : message.startsWith("History copy:")
          ? "History copy needs attention."
          : "Engine upkeep needs attention; requests can continue.";
  return `${at.toISOString()} ${summary}`;
}

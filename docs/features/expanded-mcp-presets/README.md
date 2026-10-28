# More MCP server presets

Feature key: `expandedMcpPresets` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

## What people get

With this feature on, admins see more reviewed official MCP servers to add
with one click in Manage › Connectors, alongside the existing presets
(Notion, Linear, Stripe, Sentry, Granola, Polar, Slack, Exa, Render, GitHub,
Context7). The new presets:

- Airtable — `https://mcp.airtable.com/mcp` (OAuth)
- Amplitude — `https://mcp.amplitude.com/mcp` (OAuth)
- Cal.com — `https://mcp.cal.com/mcp` (OAuth)
- Canva — `https://mcp.canva.com/mcp` (OAuth)
- Figma — `https://mcp.figma.com/mcp` (OAuth)
- Fireflies — `https://api.fireflies.ai/mcp` (OAuth)
- Hugging Face — `https://huggingface.co/mcp` (OAuth)
- Honeycomb — `https://mcp.honeycomb.io/mcp` (OAuth)
- Klaviyo — `https://mcp.klaviyo.com/mcp` (OAuth)
- Lucid — `https://mcp.lucid.app/mcp` (OAuth)
- monday.com — `https://mcp.monday.com/mcp` (OAuth)
- Mural — `https://mcp-canvas.mural.co/mcp` (OAuth)
- PostHog — `https://mcp.posthog.com/mcp` (OAuth)
- Semgrep — `https://mcp.semgrep.ai/mcp` (OAuth)
- Tavily — `https://mcp.tavily.com/mcp` (API key from app.tavily.com)
- Vercel — `https://mcp.vercel.com` (OAuth)

Each OAuth preset uses the same CIMD/DCR auth pipeline as the existing presets
(`packages/enterprise-mcp-client`); no new auth path was added.

## How it works

- `EXTERNAL_MCP_PRESETS` (the 11 existing presets) is the always-on core list.
- `EXTERNAL_MCP_PRESETS_EXPANDED` (the 16 above) is gated by this feature flag.
- `externalMcpPresetsForCatalog({ expanded })` returns the core list, plus the
  expanded list only when the flag is on. It feeds:
  - the `/v1/mcp-connections/presets` route (Manage › Connectors), and
  - `connectorCatalogForQuery` (the `search_capabilities` connectors catalog).
- `ALL_EXTERNAL_MCP_PRESETS` (core + expanded) is the list the auth policy
  (`external-mcp-auth-policy`) matches against, so an existing connection to an
  expanded-preset server keeps its preset auth behavior even when the flag is
  off. This is what makes the flag safe to turn off: it hides new catalog
  suggestions, it never revokes or breaks existing connections.

## What turning it off does

- Hides the 16 new presets from the preset list and the connectors catalog.
- The resolve flow (`/v1/mcp-connections/resolve`) stops matching the new
  preset names/URLs; an admin typing "airtable" no longer gets a preset match
  (they may still get a probed discovery result).
- Existing connections made while the flag was on stay connected and keep
  their saved auth type and OAuth client. They are not deleted or revoked.

## What this is not

- Not a proof that every listed provider accepts OpenWork as an OAuth client.
  The preset URLs and their OAuth protected-resource metadata were verified by
  probing the public `/.well-known/oauth-protected-resource` endpoint;
  advertisement is not a successful connection. A real sign-in still requires
  the member to take over OAuth for their own account.
- Not an import of a third-party MCP registry. The list is a reviewed subset,
  not a mirror of an external catalog.
export const shadowAiFaq = [
  {
    question: "What is shadow AI?",
    answer:
      "Shadow AI is employees using AI tools at work without their company's approval or oversight. It can include personal chatbot accounts, unsanctioned AI coding tools, and agents connected to company files with personal API keys. The issue is not that people use AI; it is that IT cannot consistently govern access, providers, or usage."
  },
  {
    question: "How can companies manage shadow AI without banning AI tools?",
    answer:
      "Give employees an approved path that works with their day-to-day tools. Agree on permitted models and providers, use company SSO, assign permissions, and review usage. OpenWork combines an AI gateway for model traffic with support for multiple agents, so governance does not depend on everyone adopting one coding tool."
  },
  {
    question: "What does OpenWork's AI gateway control?",
    answer:
      "For model traffic routed through OpenWork, the AI gateway gives IT one controlled path with company sign-in, permissions, provider choice, and usage visibility. It is not a network-wide discovery tool and does not automatically intercept unsanctioned AI tools or personal accounts outside that path."
  },
  {
    question: "Can we use AWS Bedrock and keep our existing AI coding tools?",
    answer:
      "OpenWork supports centrally provisioned providers such as AWS Bedrock. OpenWork and OpenCode with the opencode-openwork plugin can use your organization's AI gateway models. Claude Code, Codex, and Cursor can use shared skills and connections through the MCP gateway; AI gateway model integration for those clients is in progress. Adding MCP alone does not route a client's model traffic through the AI gateway."
  },
  {
    question: "Does company data leave the user's PC?",
    answer:
      "In the local desktop model-gateway setup, files and the workspace stay on the user's PC. Workspace processing sends SSO configuration and model traffic, not a copy of the workspace. Model traffic includes prompts, responses, and any file content the agent includes as context, so local-first does not mean that a remote model never sees company data. Product analytics, diagnostics, update checks, optional cloud workers, and connected services have separate data flows."
  },
  {
    question: "Is an AI gateway enough for shadow AI governance?",
    answer:
      "An AI gateway is one part of shadow AI governance, not a replacement for company policy. Document approved tools and data handling, configure supported clients to use the gateway, train employees, and review access and usage. Use endpoint and network controls where you need to address tools that bypass the approved path."
  }
];

export const shadowAiMarkdown = `# Manage shadow AI without taking away the tools people like

Shadow AI is employees using unsanctioned AI tools at work. OpenWork gives IT one controlled path for model traffic, while teams keep the AI coding tools and agents they prefer.

## Shadow AI governance through an AI gateway

- Company SSO and permissions govern access to the approved model path.
- IT chooses providers, including AWS Bedrock, rather than distributing personal API keys.
- Usage visibility helps teams review model use and spend on the gateway.
- OpenWork and OpenCode with the opencode-openwork plugin can use company AI gateway models. Claude Code, Codex, and Cursor use the MCP gateway for shared skills and connections; AI gateway model integration for those clients is in progress.
- The [MCP gateway](https://openworklabs.com/connect) shares skills and connections. Adding MCP alone does not route model traffic.

## Local work, controlled model traffic

In the local desktop model-gateway setup, files and the workspace stay on the user's PC. Workspace processing sends SSO configuration and model traffic, not a copy of the workspace. Prompts and responses can include file content supplied as model context. Product analytics, diagnostics, update checks, optional cloud workers, and connected services have separate data flows.

## An approved path, not automatic discovery

OpenWork governs traffic routed through it. It does not automatically discover or block every unsanctioned AI tool. Combine it with an approved-tool policy, employee training, and endpoint or network controls where needed.

## FAQ

${shadowAiFaq.map((entry) => `### ${entry.question}\n\n${entry.answer}`).join("\n\n")}

## Next steps

- [Plan your rollout](https://openworklabs.com/enterprise#book)
- [Enterprise deployment](https://openworklabs.com/enterprise)
- [Plans and pricing](https://openworklabs.com/pricing)
- [AI coding tools and agents](https://openworklabs.com/guides/claude-code-codex-cursor)
`;

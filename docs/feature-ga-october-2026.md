# October 2026 rollout graduation

These rollout switches are retired. Their enabled behavior is now the product
on both cloud and self-hosted deployments; a fresh installation needs no
organization override, deployment rollout row, or operator feature lock.

## Generally available

| Area | Retired switches |
| --- | --- |
| Roles and agent policy | `permissions`, `agentPermissions`, `teamRoles`, `sharedRoles` |
| Team and member management | `teamPageTabs`, `desktopPolicyScreenRemoval`, `teamAccessRows`, `memberListToolbars` |
| Workbot | `workbot`, `workbotLunaDefault`, `slackWorkbotReplies` |
| Organization skills | `nativeCloudSkills`, `mcpSkillsExtension` |
| Models | `orgDefaultModel`, `modelRemovalRecovery`, `lastTurnModelFooter` |
| Chat progress | `appBuildProgress`, `backgroundShellTasks` |
| Provider spend limits | `gatewayProviderUsageLimits` |
| Google Docs tools | `googleDocumentTools` |
| Invitations | `inviteLinkVerifiesEmail` |
| Sign-in navigation | `rememberLastOrganization` |
| Team membership lookup | `teamMembershipCache` |
| Cloud-agent models through the AI Gateway | `cloudAgentGateway` |
| Secure keys in chat | `secureSecretFields` |
| Slack Assistant (still needs the Slack connector set up) | `slackAssistant` |
| Workbot sign-in and account connection | `workbotFirstRun`, `workbotInlineConnect` |
| Content-free chat index for admins | `headlessSessionIndex` |

## Folded into another switch

| Retired switch | Now controlled by |
| --- | --- |
| `workbotGuidedNavigation` | `workbotWorkspaceAssistant` |
| `engineV2Upgrade` (the optional desktop invitation is gone) | `engineV2ForceUpgrade` ("Upgrade to OpenCode v2") |
| `headlessStepTurns` | `headlessDurableTurns` ("Cloud tasks survive restarts and updates") |

The remaining switches stay off by default. An old override for a folded key
does not turn on its new switch.

## Removed with their feature

`workbotTeamLinks` (Workbot's team settings links), `remoteSessionEvents` (MCP
resource subscriptions for remote session receipts; poll with
`remote-session:status` instead), and the deprecated `modelsAnalyticsUi` and
`taskAnalyticsUi` screens with the API routes only they used.

Removing a rollout does not remove authorization, connector consent, model
availability checks, or operator configuration. Self-hosted installations must
still configure their model providers, runner services and OAuth integrations.
Luna is never represented as available without a verified authorized model.
Older stored overrides and feature environment variables for these keys no
longer control behavior. Old Helm values remain accepted for upgrade
compatibility, but are ignored.

## Managed deployments remain opt-in

`managedDeploymentsGcp` and `managedDeploymentsMcp` are folded into
`managedDeployments`. That single switch remains **cloud-only and off by
default**; it controls AWS, Google Cloud and deployment agent tools together.
An old GCP or MCP override cannot enable the parent rollout. Installer
publication and provider configuration remain separate operator requirements.
Disabling the parent blocks launches without deleting resources or interrupting
authenticated installer enrollment or health reports.

Self-hosted installations can use the generally available product features, but
cannot use this hosted control-plane rollout to provision more installations.
Other switches that were not globally enabled are not graduated by this change.

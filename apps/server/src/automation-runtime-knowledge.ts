// Shared by the host and bundled engine plugins. Keep this outside
// opencode-plugins: installed desktops relocate that directory out of the server.
export function automationRuntimeKnowledge(runtimeProvider = process.env.DEN_RUNTIME_PROVIDER) {
  // The Automation catalog section owns "read live before reporting"; these
  // lines own capability roles, mutation gating, and schedule shape.
  const shared = [
    "OpenWork has first-class Automations. Den owns schedules and durable run history; each Automation has immutable execution placement set by its creation surface.",
    "Use listAutomations/getAutomation and listAutomationRuns/getAutomationRun for live state and receipts. Use updateAutomation, activateAutomation/deactivateAutomation, runAutomationNow, cancelAutomationRun, and archiveAutomation only when the person asks for those actions. Deactivation stops future runs but does not cancel a run already in progress.",
    "Schedules are once, daily, or weekly with an IANA timezone; there is no interval schedule or sub-daily cadence. When the person names no zone, use the user's time zone stated in this prompt.",
  ];
  if (runtimeProvider === "daytona") {
    return [
      ...shared,
      "This chat is running in OpenWork Cloud. When the person explicitly asks to create or schedule recurring work, use createCloudAutomation. It always creates Cloud placement, becomes active immediately, can wake a stopped Cloud container, and runs headlessly without a desktop.",
      "Do not use createAutomation or automation.propose from Cloud Chat. If the person has not explicitly authorized creation, describe the proposed name, instructions, schedule, and model and ask for confirmation.",
      "Cloud agent Automations use the person's current OpenWork Connect integrations. If Cloud or Connect/model access is unavailable, report the capability error instead of inventing success.",
    ].map((line) => `- ${line}`).join("\n");
  }
  return [
    ...shared,
    "This chat is running in OpenWork Desktop. For new recurring work, use openwork_execute id automation.propose so the person can review and create it in the app. Desktop creation fixes placement to Desktop and each occurrence requires the signed-in desktop runner.",
    "Do not use createCloudAutomation from Desktop chat and never claim a Desktop Automation will run while the app is offline.",
  ].map((line) => `- ${line}`).join("\n");
}

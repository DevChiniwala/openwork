import { Cloud, KeyRound, Monitor, Split, Users, type LucideIcon } from "lucide-react";

export type EnterpriseCard = {
  icon: LucideIcon;
  title: string;
  detail: string;
};

export const enterpriseControls: EnterpriseCard[] = [
  {
    icon: KeyRound,
    title: "Company identity",
    detail: "Use SAML or OIDC single sign-on. Provision and deprovision access through SCIM, instead of managing another set of personal accounts."
  },
  {
    icon: Users,
    title: "Explicit permissions",
    detail: "Assign access to models, skills, and connections by role and team. Keep administration separate from the access employees need to do their work."
  },
  {
    icon: Cloud,
    title: "Your approved providers",
    detail: "Configure providers centrally, including AWS Bedrock. Give supported clients an organizational model path rather than distributing personal provider keys."
  },
  {
    icon: Split,
    title: "Visibility into routed usage",
    detail: "Review model usage and spend through the gateway. Understand the approved traffic without claiming visibility into tools that bypass it."
  }
];

export const enterpriseRollout = [
  {
    step: "Start with a person",
    body: "Install per user. Connect company sign-in and an approved provider, then test one useful workflow with a small pilot group."
  },
  {
    step: "Plan a 30-day trial",
    body: "A proposed evaluation: validate permissions, review data flows, test identity lifecycle, and collect feedback from employees and IT."
  },
  {
    step: "Expand in phases",
    body: "Use the pilot findings to plan a few hundred seats, with the deployment path, support, and scope agreed before expansion."
  }
];

export const enterpriseDeployments: (EnterpriseCard & { href: string; link: string })[] = [
  {
    icon: Monitor,
    title: "Local-first desktop",
    detail: "An agent workspace for macOS, Windows, and Linux. Start with a per-user install and connect the organization’s approved services.",
    href: "/download",
    link: "Download OpenWork"
  },
  {
    icon: Cloud,
    title: "Cloud management",
    detail: "Manage organizational access, models, shared skills, and connections from OpenWork’s control plane.",
    href: "/cloud",
    link: "Explore OpenWork Cloud"
  },
  {
    icon: KeyRound,
    title: "Managed private or self-hosted",
    detail: "Discuss a managed private deployment, or review self-hosting requirements. Agree on infrastructure, operations, and responsibility boundaries before rollout.",
    href: "https://github.com/different-ai/openwork/blob/dev/docs/managed-deployments.md",
    link: "Review deployment documentation"
  }
];

export const enterpriseDataBoundary = [
  {
    title: "On the employee’s computer.",
    body: "In the local desktop model-gateway setup, files and the workspace stay on the computer. Workspace processing sends SSO configuration and model traffic, not a copy of the workspace."
  },
  {
    title: "Through the model path.",
    body: "Prompts, responses, and file content selected as context travel through the gateway to your configured provider. Local-first does not mean a remote model never sees company data."
  },
  {
    title: "Review separately.",
    body: "Product analytics, diagnostics, update checks, optional cloud workers, and connected services have their own data flows. Review those alongside your provider and deployment configuration."
  }
];

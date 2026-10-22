import { ChevronRight } from "lucide-react";

import { BookCallForm } from "./book-call-form";
import { LpSectionHeader } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { enterpriseFaq } from "../lib/enterprise";
import { TRUST_CENTER_URL } from "../lib/trust-center";

type Props = {
  stars: string;
  calUrl: string;
};

const controls = [
  {
    number: "01",
    title: "Company identity",
    detail: "Use SAML or OIDC single sign-on. Provision and deprovision access through SCIM, instead of managing another set of personal accounts."
  },
  {
    number: "02",
    title: "Explicit permissions",
    detail: "Assign access to models, skills, and connections by role and team. Keep administration separate from the access employees need to do their work."
  },
  {
    number: "03",
    title: "Your approved providers",
    detail: "Configure providers centrally, including AWS Bedrock. Give supported clients an organizational model path rather than distributing personal provider keys."
  },
  {
    number: "04",
    title: "Visibility into routed usage",
    detail: "Review model usage and spend through the gateway. Understand the approved traffic without claiming visibility into tools that bypass it."
  }
];

const rollout = [
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

/** Architecture, not a simulated product dashboard: no invented usage or states. */
function EnterpriseArchitecture() {
  return (
    <figure className="rounded-[24px] bg-[var(--lp-tonal)] p-6 sm:p-8">
      <figcaption className="text-sm font-medium text-[var(--lp-muted)]">The approved model path</figcaption>
      <div className="mt-7 border-b border-[var(--lp-border)] pb-6">
        <p className="text-xl font-medium tracking-tight">Employee workspace</p>
        <p className="mt-2 text-sm leading-6 text-[var(--lp-body)]">OpenWork or OpenCode + plugin</p>
        <p className="mt-3 text-xs text-[var(--lp-muted)]">Local files stay on the computer</p>
      </div>
      <div className="ml-4 border-l border-[var(--lp-muted)] py-5 pl-5 text-xs leading-5 text-[var(--lp-body)]">
        Prompts, responses, and selected file context
      </div>
      <div className="rounded-2xl bg-[var(--lp-ink)] px-6 py-5 text-[var(--lp-page)]">
        <p className="text-lg font-medium">OpenWork AI gateway</p>
        <p className="mt-2 text-sm leading-6">Company SSO · Permissions · Usage</p>
      </div>
      <div className="ml-4 border-l border-[var(--lp-muted)] py-5 pl-5 text-xs text-[var(--lp-body)]">Routed model requests</div>
      <div className="border-t border-[var(--lp-border)] pt-5">
        <p className="text-lg font-medium tracking-tight">Your approved model provider</p>
        <p className="mt-2 text-sm text-[var(--lp-body)]">AWS Bedrock or another configured provider</p>
      </div>
    </figure>
  );
}

export function LandingEnterprise(props: Props) {
  const calHref = props.calUrl || "#book";
  const calExternal = /^https?:\/\//.test(calHref);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={props.stars} callUrl={props.calUrl} active="enterprise" mobilePrimaryHref="#book" mobilePrimaryLabel="Contact sales" />
      <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
        <section aria-labelledby="enterprise-heading" className="grid gap-12 pb-16 pt-12 md:pt-20 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:gap-16 lg:pb-24">
          <div>
            <p className="text-sm text-[var(--lp-muted)]">OpenWork Enterprise</p>
            <h1 id="enterprise-heading" className="mt-5 text-[44px] font-light leading-[1.06] tracking-[-0.04em] sm:text-[56px] lg:text-[64px]">
              AI your team wants.<br />
              <span className="font-pixel">Control IT needs.</span>
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-7 text-[var(--lp-body)]">
              Give employees an approved way to work with AI. Bring model traffic under company sign-in, permissions, and provider choice—without forcing everyone into the same agent.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={calHref} target={calExternal ? "_blank" : undefined} rel={calExternal ? "noreferrer" : undefined} className="lp-pill-primary">Book a demo</a>
              <a href="#controls" className="lp-pill-secondary">Explore the controls</a>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--lp-muted)]">
              <span>SAML / OIDC + SCIM</span>
              <span>AWS Bedrock</span>
              <span>Local-first desktop</span>
            </div>
          </div>
          <EnterpriseArchitecture />
        </section>

        <section aria-labelledby="shadow-ai-heading" className="grid gap-8 border-y border-[var(--lp-border)] py-12 md:grid-cols-[1fr_1.5fr] md:gap-20 md:py-16">
          <div>
            <p className="text-sm text-[var(--lp-muted)]">The shadow AI problem</p>
            <h2 id="shadow-ai-heading" className="mt-4 text-[30px] font-light leading-tight tracking-tight md:text-[36px]">The work is already happening.<br />Give it an approved path.</h2>
          </div>
          <div>
            <p className="text-lg leading-8 text-[var(--lp-body)]">Personal AI accounts. Unmanaged API keys. Company context sent to providers IT never approved. Banning the tools doesn’t give people a better way to work.</p>
            <p className="mt-5 text-base leading-7 text-[var(--lp-body)]">OpenWork connects practical agent workflows with organizational controls. Govern model traffic routed through your gateway, with clear visibility into what that path covers—and what it does not.</p>
            <a href="/shadow-ai" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">Understand shadow AI</a>
          </div>
        </section>

        <section id="controls" aria-labelledby="controls-heading" className="mt-20 scroll-mt-8 md:mt-28">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.5fr] lg:gap-20">
            <div>
              <p className="text-sm text-[var(--lp-muted)]">One organizational control plane</p>
              <h2 id="controls-heading" className="mt-4 text-[36px] font-light leading-tight tracking-tight md:text-[44px]">Choose the access.<br />Choose the models.</h2>
              <a href="/ai-governance" className="mt-7 inline-block text-sm font-medium underline underline-offset-4">Explore AI governance</a>
            </div>
            <ol>
              {controls.map(control => (
                <li key={control.number} className="grid grid-cols-[28px_1fr] gap-x-4 border-t border-[var(--lp-border)] py-6 first:pt-0 first:border-t-0">
                  <span aria-hidden="true" className="mono pt-1 text-xs text-[var(--lp-muted)]">{control.number}</span>
                  <div>
                    <h3 className="text-lg font-medium tracking-tight">{control.title}</h3>
                    <p className="mt-2 text-[15px] leading-7 text-[var(--lp-body)]">{control.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="agents-heading" className="mt-20 rounded-[24px] bg-[var(--lp-tonal)] px-6 py-10 sm:p-10 md:mt-28 md:p-12">
          <p className="text-sm text-[var(--lp-muted)]">Agent choice, with clear boundaries</p>
          <h2 id="agents-heading" className="mt-4 max-w-2xl text-[36px] font-light leading-tight tracking-tight md:text-[44px]">Keep the tools.<br />Know what’s connected.</h2>
          <div className="mt-10 divide-y divide-[var(--lp-border)]">
            <div className="grid gap-4 pb-7 md:grid-cols-[1fr_1.5fr] md:gap-12">
              <h3 className="text-xl font-medium">OpenWork &amp; OpenCode</h3>
              <div>
                <p className="text-[15px] leading-7 text-[var(--lp-body)]">Use organizational AI gateway models in OpenWork, or in OpenCode with the <code className="mono text-[13px]">opencode-openwork</code> plugin.</p>
                <p className="mt-3 text-sm font-medium">AI gateway model access</p>
              </div>
            </div>
            <div className="grid gap-4 pt-7 md:grid-cols-[1fr_1.5fr] md:gap-12">
              <h3 className="text-xl font-medium">Claude Code, Codex &amp; Cursor</h3>
              <div>
                <p className="text-[15px] leading-7 text-[var(--lp-body)]">Connect shared skills and connections through the MCP gateway. AI gateway model integration for these clients is in progress.</p>
                <p className="mt-3 text-sm font-medium">MCP access is not model routing</p>
              </div>
            </div>
          </div>
          <a href="/connect" className="lp-pill-secondary mt-8">Explore the MCP gateway</a>
        </section>

        <section aria-labelledby="data-heading" className="mt-20 grid gap-8 md:mt-28 md:grid-cols-[1fr_1.5fr] md:gap-20">
          <div>
            <p className="text-sm text-[var(--lp-muted)]">A boundary you can explain</p>
            <h2 id="data-heading" className="mt-4 text-[36px] font-light leading-tight tracking-tight md:text-[44px]">Local files.<br />A clear data boundary.</h2>
            <a href="/privacy" className="mt-7 inline-block text-sm font-medium underline underline-offset-4">Read the privacy policy</a>
          </div>
          <div className="space-y-6 text-[15px] leading-7 text-[var(--lp-body)]">
            <p><strong className="font-medium text-[var(--lp-ink)]">On the employee’s computer.</strong> In the local desktop model-gateway setup, files and the workspace stay on the computer. Workspace processing sends SSO configuration and model traffic, not a copy of the workspace.</p>
            <p><strong className="font-medium text-[var(--lp-ink)]">Through the model path.</strong> Prompts, responses, and file content selected as context travel through the gateway to your configured provider. Local-first does not mean a remote model never sees company data.</p>
            <p><strong className="font-medium text-[var(--lp-ink)]">Review separately.</strong> Product analytics, diagnostics, update checks, optional cloud workers, and connected services have their own data flows. Review those alongside your provider and deployment configuration.</p>
          </div>
        </section>

        <section aria-labelledby="deployment-heading" className="mt-20 border-t border-[var(--lp-border)] pt-10 md:mt-28">
          <div className="grid gap-10 md:grid-cols-[1fr_1.5fr] md:gap-20">
            <div>
              <p className="text-sm text-[var(--lp-muted)]">Deployment, on your terms</p>
              <h2 id="deployment-heading" className="mt-4 text-[36px] font-light leading-tight tracking-tight">Start on the laptop.<br />Choose the control plane.</h2>
            </div>
            <div className="divide-y divide-[var(--lp-border)]">
              {[
                { title: "Local-first desktop", body: "An agent workspace for macOS, Windows, and Linux. Start with a per-user install and connect the organization’s approved services.", href: "/download", link: "Download OpenWork" },
                { title: "Cloud management", body: "Manage organizational access, models, shared skills, and connections from OpenWork’s control plane.", href: "/cloud", link: "Explore OpenWork Cloud" },
                { title: "Managed private or self-hosted", body: "Discuss a managed private deployment, or review self-hosting requirements. Agree on infrastructure, operations, and responsibility boundaries before rollout.", href: "https://github.com/different-ai/openwork/blob/dev/docs/managed-deployments.md", link: "Review deployment documentation" }
              ].map(deployment => (
                <div key={deployment.title} className="py-6 first:pt-0">
                  <h3 className="text-lg font-medium">{deployment.title}</h3>
                  <p className="mt-2 text-[15px] leading-7 text-[var(--lp-body)]">{deployment.body}</p>
                  <a href={deployment.href} className="mt-3 inline-block text-sm font-medium underline underline-offset-4">{deployment.link}</a>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-label="A proposed enterprise rollout" className="mt-20 md:mt-28">
          <LpSectionHeader label="A practical evaluation" heading="Prove the fit. Then expand." />
          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
            {rollout.map((phase, index) => (
              <li key={phase.step} className="border-t border-[var(--lp-border)] pt-5">
                <span className="mono text-xs text-[var(--lp-muted)]">0{index + 1}</span>
                <h3 className="mt-5 text-xl font-medium tracking-tight">{phase.step}</h3>
                <p className="mt-3 text-[15px] leading-7 text-[var(--lp-body)]">{phase.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm leading-6 text-[var(--lp-muted)]">An evaluation plan, not a deployment guarantee. Timeline, scope, support, and commercial terms are agreed with your team.</p>
        </section>

        <section aria-labelledby="trust-heading" className="mt-20 flex flex-col justify-between gap-7 border-y border-[var(--lp-border)] py-10 md:mt-28 md:flex-row md:items-center">
          <div className="max-w-xl">
            <p className="text-sm text-[var(--lp-muted)]">Review the evidence</p>
            <h2 id="trust-heading" className="mt-3 text-[30px] font-light leading-tight tracking-tight">Your security review starts here.</h2>
            <p className="mt-4 text-[15px] leading-7 text-[var(--lp-body)]">Use the Trust Center for current security materials and the source for implementation details. Bring your deployment questions to the evaluation.</p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-4">
            <a href={TRUST_CENTER_URL} target="_blank" rel="noreferrer" className="lp-pill-primary">Visit the Trust Center</a>
            <a href="https://github.com/different-ai/openwork" className="text-sm font-medium underline underline-offset-4">Inspect the source</a>
          </div>
        </section>

        <section aria-labelledby="enterprise-faq-heading" className="mt-20 grid gap-8 md:mt-28 md:grid-cols-[1fr_1.5fr] md:gap-20">
          <h2 id="enterprise-faq-heading" className="text-[36px] font-light tracking-tight">Before you roll out.</h2>
          <div className="divide-y divide-[var(--lp-border)] border-y border-[var(--lp-border)]">
            {enterpriseFaq.map(entry => (
              <details key={entry.question} className="group py-5">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-5 rounded-sm text-base font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--lp-ink)] [&::-webkit-details-marker]:hidden">
                  {entry.question}
                  <ChevronRight aria-hidden="true" size={18} strokeWidth={1.5} className="mt-1 shrink-0 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" />
                </summary>
                <p className="mt-4 pr-6 text-[15px] leading-7 text-[var(--lp-body)]">{entry.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="contact-heading" className="mt-20 md:mt-28">
          <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <p className="text-sm text-[var(--lp-muted)]">Make an approved path worth using</p>
              <h2 id="contact-heading" className="mt-3 text-[36px] font-light leading-tight tracking-tight md:text-[44px]">Bring IT. Bring a real workflow.</h2>
            </div>
            <a href={calHref} target={calExternal ? "_blank" : undefined} rel={calExternal ? "noreferrer" : undefined} className="lp-pill-primary self-start">Book a demo</a>
          </div>
          <BookCallForm />
        </section>
        <div className="mt-16"><SiteFooter /></div>
      </main>
    </div>
  );
}

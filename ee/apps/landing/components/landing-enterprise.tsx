import { Check, ChevronRight } from "lucide-react";

import { BookCallForm } from "./book-call-form";
import { CoworkComparison } from "./cowork-comparison";
import { LpArrowLink, LpSectionHeader } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { enterpriseFaq } from "../lib/enterprise";
import {
  enterpriseControls,
  enterpriseDataBoundary,
  enterpriseDeployments,
  enterpriseRollout,
  type EnterpriseCard
} from "../lib/enterprise-sections";
import { TRUST_CENTER_URL } from "../lib/trust-center";

type Props = {
  stars: string;
  calUrl: string;
};

const body = "text-[15px] leading-[23px] text-[var(--lp-body)]";
const section = "mt-28 scroll-mt-24 md:mt-36";

/** Tonal icon card, same pattern as CompareCards on the compare pages. */
function IconCard({ card, children }: { card: EnterpriseCard; children?: React.ReactNode }) {
  const Icon = card.icon;
  return (
    <li className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
      <Icon aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 text-[var(--lp-ink)]" />
      <h3 className="mt-8 text-[17px] font-medium leading-[24px] tracking-[-0.01em]">{card.title}</h3>
      <p className="mt-2 flex-1 text-[14.5px] leading-[22px] text-[var(--lp-body)]">{card.detail}</p>
      {children}
    </li>
  );
}

/** Architecture, not a simulated product dashboard: no invented usage or states. */
function EnterpriseArchitecture() {
  const step = "flex min-h-[64px] flex-col justify-center rounded-[10px] bg-white px-4 py-3";
  const hop = "flex items-center gap-2 px-4 py-1.5 text-xs text-[var(--lp-muted)]";
  return (
    <figure className="flex w-full flex-col gap-2 rounded-[24px] bg-[var(--lp-tonal)] p-5 lg:w-[420px] lg:shrink-0">
      <figcaption className="px-1 pb-1.5 text-sm text-[var(--lp-muted)]">The approved model path</figcaption>
      <div className={step}>
        <span className="text-[14px] font-medium text-[var(--lp-ink)]">Employee workspace</span>
        <span className="text-xs text-[var(--lp-muted)]">OpenWork or OpenCode + plugin · Local files stay on the computer</span>
      </div>
      <div className={hop}><span aria-hidden="true">↓</span>Prompts, responses, and selected file context</div>
      <div className="flex min-h-[64px] flex-col justify-center rounded-[10px] bg-[var(--lp-ink)] px-4 py-3 text-[var(--lp-page)]">
        <span className="text-[14px] font-medium">OpenWork AI gateway</span>
        <span className="text-xs opacity-80">Company SSO · Permissions · Usage</span>
      </div>
      <div className={hop}><span aria-hidden="true">↓</span>Routed model requests</div>
      <div className={step}>
        <span className="text-[14px] font-medium text-[var(--lp-ink)]">Your approved model provider</span>
        <span className="text-xs text-[var(--lp-muted)]">AWS Bedrock or another configured provider</span>
      </div>
    </figure>
  );
}

export function LandingEnterprise(props: Props) {
  const calHref = props.calUrl || "#book";
  const calProps = /^https?:\/\//.test(calHref) ? { target: "_blank", rel: "noreferrer" } : {};

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={props.stars} callUrl={props.calUrl} active="enterprise" mobilePrimaryHref="#book" mobilePrimaryLabel="Contact sales" />
      <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
        <section aria-labelledby="enterprise-heading" className="flex flex-col gap-12 pb-4 pt-12 md:pt-20 lg:flex-row lg:items-end lg:gap-16">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-[var(--lp-muted)]">OpenWork Enterprise</p>
            <h1 id="enterprise-heading" className="mt-5 text-[clamp(2.5rem,4.4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]">
              <span className="block">AI your team wants.</span>
              <span className="block">Control IT needs.</span>
            </h1>
            <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
              Give employees an approved way to work with AI. Bring model traffic under company sign-in, permissions, and provider choice, without forcing everyone into the same agent.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={calHref} {...calProps} className="lp-pill-primary">Book a demo</a>
              <a href="#controls" className="lp-pill-secondary">Explore the controls</a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
              {["SAML / OIDC + SCIM", "AWS Bedrock", "Local-first desktop"].map(item => (
                <li key={item} className="flex items-center gap-2 text-[13px] text-[var(--lp-muted)]">
                  <Check size={13} strokeWidth={2.6} className="shrink-0 text-[#047857]" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <EnterpriseArchitecture />
        </section>

        <section aria-labelledby="shadow-ai-heading" className={section}>
          <div id="shadow-ai-heading">
            <LpSectionHeader label="The shadow AI problem" heading="The work is already happening. Give it an approved path." headingLines={["The work is already happening.", "Give it an approved path."]} />
          </div>
          <div className="mt-6 grid max-w-[960px] gap-6 md:grid-cols-2 md:gap-10">
            <p className={body}>Personal AI accounts. Unmanaged API keys. Company context sent to providers IT never approved. Banning the tools doesn’t give people a better way to work.</p>
            <p className={body}>OpenWork connects practical agent workflows with organizational controls. Govern model traffic routed through your gateway, with clear visibility into what that path covers, and what it does not.</p>
          </div>
          <div className="mt-6"><LpArrowLink href="/shadow-ai">Understand shadow AI</LpArrowLink></div>
        </section>

        <section id="controls" aria-labelledby="controls-heading" className={section}>
          <div id="controls-heading">
            <LpSectionHeader label="One organizational control plane" heading="Choose the access. Choose the models." headingLines={["Choose the access.", "Choose the models."]} right={<LpArrowLink href="/ai-governance">Explore AI governance</LpArrowLink>} />
          </div>
          <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {enterpriseControls.map(card => <IconCard key={card.title} card={card} />)}
          </ul>
        </section>

        <section aria-labelledby="agents-heading" className={section}>
          <div id="agents-heading">
            <LpSectionHeader label="Agent choice, with clear boundaries" heading="Keep the tools. Know what’s connected." headingLines={["Keep the tools.", "Know what’s connected."]} right={<a href="/connect" className="lp-pill-secondary lp-pill-sm">Explore the MCP gateway</a>} />
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-8">
              <span className="inline-flex h-[22px] w-fit items-center rounded-full bg-[#E7F6EE] px-[9px] text-xs font-semibold text-[#047857]">AI gateway model access</span>
              <h3 className="mt-2 text-[20px] font-medium tracking-[-0.01em]">OpenWork &amp; OpenCode</h3>
              <p className={body}>Use organizational AI gateway models in OpenWork, or in OpenCode with the <code className="mono text-[13px]">opencode-openwork</code> plugin.</p>
            </div>
            <div className="flex flex-col gap-3 rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-8">
              <span className="inline-flex h-[22px] w-fit items-center rounded-full px-[9px] text-xs font-semibold text-[#5E6877] shadow-[inset_0_0_0_1px_#D3DAE4]">MCP access is not model routing</span>
              <h3 className="mt-2 text-[20px] font-medium tracking-[-0.01em]">Claude Code, Codex &amp; Cursor</h3>
              <p className={body}>Connect shared skills and connections through the MCP gateway. AI gateway model integration for these clients is in progress.</p>
            </div>
          </div>
        </section>

        <CoworkComparison id="enterprise-comparison-heading" label="OpenWork vs Claude Cowork" heading="Feature parity. Zero lock-in." className="mt-28 block md:mt-36" />

        <section aria-labelledby="data-heading" className={section}>
          <div id="data-heading">
            <LpSectionHeader label="A boundary you can explain" heading="Local files. A clear data boundary." headingLines={["Local files.", "A clear data boundary."]} right={<LpArrowLink href="/privacy">Read the privacy policy</LpArrowLink>} />
          </div>
          <div className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
            {enterpriseDataBoundary.map(item => (
              <div key={item.title} className="border-t border-[var(--lp-ink)] pt-5">
                <h3 className="text-[17px] font-medium tracking-[-0.01em]">{item.title}</h3>
                <p className={`mt-3 ${body}`}>{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="deployment-heading" className={section}>
          <div id="deployment-heading">
            <LpSectionHeader label="Deployment, on your terms" heading="Start on the laptop. Choose the control plane." headingLines={["Start on the laptop.", "Choose the control plane."]} />
          </div>
          <ul className="mt-10 grid gap-3 md:grid-cols-3">
            {enterpriseDeployments.map(card => (
              <IconCard key={card.title} card={card}>
                <div className="mt-6"><LpArrowLink href={card.href}>{card.link}</LpArrowLink></div>
              </IconCard>
            ))}
          </ul>
        </section>

        <section aria-label="A proposed enterprise rollout" className={section}>
          <LpSectionHeader label="A practical evaluation" heading="Prove the fit. Then expand." />
          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
            {enterpriseRollout.map((phase, index) => (
              <li key={phase.step} className="flex flex-col">
                <div className="flex h-10 items-center border-b border-[var(--lp-ink)]">
                  <span className="mono text-xs text-[var(--lp-muted)]">0{index + 1}</span>
                </div>
                <h3 className="mt-5 text-[17px] font-medium tracking-[-0.01em]">{phase.step}</h3>
                <p className={`mt-3 ${body}`}>{phase.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-[13px] leading-6 text-[var(--lp-muted)]">An evaluation plan, not a deployment guarantee. Timeline, scope, support, and commercial terms are agreed with your team.</p>
        </section>

        <section aria-labelledby="trust-heading" className="mt-28 flex flex-col justify-between gap-10 rounded-[24px] bg-[var(--lp-tonal)] px-7 py-12 md:mt-36 md:flex-row md:items-center md:px-14 md:py-[72px]">
          <div className="max-w-[640px]">
            <div className="text-[15px] text-[var(--lp-muted)]">Review the evidence</div>
            <h2 id="trust-heading" className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[40px] md:leading-[48px]">Your security review starts here.</h2>
            <p className={`mt-4 ${body}`}>Use the Trust Center for current security materials and the source for implementation details. Bring your deployment questions to the evaluation.</p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-3 sm:flex-row md:items-center">
            <a href={TRUST_CENTER_URL} target="_blank" rel="noreferrer" className="lp-pill-primary">Visit the Trust Center</a>
            <a href="https://github.com/different-ai/openwork" className="lp-pill-secondary">Inspect the source</a>
          </div>
        </section>

        <section aria-labelledby="enterprise-faq-heading" className="mt-28 grid gap-8 md:mt-36 md:grid-cols-[1fr_1.5fr] md:gap-20">
          <h2 id="enterprise-faq-heading" className="text-[36px] font-light leading-[42px] tracking-[-0.015em]">Before you roll out.</h2>
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

        <section aria-labelledby="contact-heading" className={section}>
          <div id="contact-heading" className="mb-8">
            <LpSectionHeader label="Make an approved path worth using" heading="Bring IT. Bring a real workflow." right={<a href={calHref} {...calProps} className="lp-pill-primary">Book a demo</a>} />
          </div>
          <BookCallForm />
        </section>
        <div className="mt-16"><SiteFooter /></div>
      </main>
    </div>
  );
}

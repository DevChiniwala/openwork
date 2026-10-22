import Link from "next/link";

import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";
import { shadowAiFaq } from "../../lib/shadow-ai";

export const metadata = withSocialMetadata({
  title: "Shadow AI governance — Manage shadow AI with OpenWork",
  description:
    "Manage shadow AI with OpenWork's AI gateway: SSO, permissions, AWS Bedrock and usage visibility. Keep local files and the AI coding tools your team likes.",
  alternates: { canonical: "/shadow-ai" },
  openGraph: { url: "https://openworklabs.com/shadow-ai" }
});

const controls = [
  {
    title: "Company sign-in",
    body: "Use company SSO instead of a collection of personal AI accounts. Bring access under your organization's identity controls."
  },
  {
    title: "Permissions",
    body: "Decide who can use the approved models. Give teams the access they need without distributing individual provider keys."
  },
  {
    title: "Provider choice",
    body: "Choose where model requests go, including AWS Bedrock. Provision providers centrally rather than leaving every employee to choose a separate service."
  },
  {
    title: "Usage visibility",
    body: "Review model usage and spend on the gateway. Make decisions about adoption and access from the approved traffic, not guesswork."
  }
];

export default async function ShadowAiPage() {
  const github = await getGithubData();

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: shadowAiFaq.map((entry) => ({
            "@type": "Question",
            name: entry.question,
            acceptedAnswer: { "@type": "Answer", text: entry.answer }
          }))
        }}
      />
      <SiteNav stars={github.stars} />

      <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
        <section aria-labelledby="shadow-ai-heading" className="pt-12 md:pt-[72px]">
          <div className="text-[13px] text-[var(--lp-muted)]">Shadow AI governance</div>
          <h1
            id="shadow-ai-heading"
            className="mt-5 max-w-[900px] text-[36px] font-medium leading-[40px] tracking-[-0.045em] sm:text-[40px] sm:leading-[44px] md:text-[60px] md:leading-[64px]"
          >
            Manage shadow AI.
            <span className="block">Keep the tools your team likes.</span>
          </h1>
          <p className="mt-6 max-w-[700px] text-[17px] leading-[27px] text-[var(--lp-body)] md:text-lg md:leading-7">
            People are already using AI at work. Give them an approved path: OpenWork&apos;s AI gateway
            brings model traffic under company SSO, permissions, and provider choice, without making
            everyone use the same agent.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/enterprise#book" className="lp-pill-primary">Plan your rollout</Link>
            <a href="#how-it-works" className="lp-pill-secondary">See how it works</a>
          </div>
        </section>

        <section aria-labelledby="definition-heading" className="mt-20 grid gap-6 border-t border-[var(--lp-border)] pt-8 md:mt-24 md:grid-cols-[1fr_2fr] md:gap-16">
          <h2 id="definition-heading" className="text-[26px] font-medium leading-8 tracking-[-0.025em]">
            What is shadow AI?
          </h2>
          <div className="space-y-4 text-base leading-7 text-[var(--lp-body)]">
            <p>
              Shadow AI is employees using AI tools without company approval or oversight. Think
              personal chatbot accounts, unsanctioned AI coding tools, or agents using personal API
              keys to work with company files.
            </p>
            <p>
              The work may be useful. The unmanaged access is the problem: IT cannot consistently
              choose providers, govern permissions, or see usage. A blanket ban can push that work
              further out of sight. An approved path gives teams a practical alternative.
            </p>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="gateway-heading" className="mt-24 scroll-mt-8 md:mt-28">
          <div className="text-[13px] text-[var(--lp-muted)]">One model path for IT</div>
          <h2 id="gateway-heading" className="mt-3 max-w-[760px] text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">
            Bring model traffic through one AI gateway.
          </h2>
          <p className="mt-5 max-w-[700px] text-base leading-7 text-[var(--lp-body)]">
            Configure supported clients to use OpenWork&apos;s model gateway. IT manages the approved
            path; employees use the models and tools available to their team.
          </p>
          <ol aria-label="Approved model traffic path" className="mt-8 flex flex-col gap-4 rounded-[20px] bg-[var(--lp-tonal)] p-6 md:flex-row md:items-start md:gap-8 md:p-8">
            {[
              ["01", "Your team's tools", "OpenWork or OpenCode with the OpenWork plugin"],
              ["02", "OpenWork AI gateway", "SSO, permissions, and usage visibility"],
              ["03", "Your chosen provider", "AWS Bedrock or another approved provider"]
            ].map(([number, title, detail]) => (
              <li key={number} className="flex-1 border-t border-[var(--lp-border)] pt-4">
                <span className="mono text-xs text-[var(--lp-muted)]">{number}</span>
                <div className="mt-3 text-[17px] font-medium">{title}</div>
                <p className="mt-2 text-sm leading-[22px] text-[var(--lp-body)]">{detail}</p>
              </li>
            ))}
          </ol>
          <div className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2">
            {controls.map((control) => (
              <div key={control.title} className="border-t border-[var(--lp-border)] pt-5">
                <h3 className="text-[17px] font-medium">{control.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[var(--lp-body)]">{control.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="tools-heading" className="mt-24 grid gap-8 md:mt-28 md:grid-cols-2 md:gap-16">
          <h2 id="tools-heading" className="text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">
            Shadow AI governance shouldn&apos;t mean one tool for everyone.
          </h2>
          <div className="space-y-4 text-base leading-7 text-[var(--lp-body)]">
            <p>
              OpenWork works with multiple AI coding tools and agents, including OpenCode, Claude
              Code, Codex, and Cursor. Teams keep familiar workflows while the company manages
              access to shared capabilities.
            </p>
            <p>
              OpenWork and{" "}
              <Link href="/guides/openwork-and-opencode" className="underline underline-offset-4">OpenCode with the OpenWork plugin</Link>{" "}
              can use company AI gateway models. Claude Code, Codex, and Cursor use the{" "}
              <Link href="/connect" className="underline underline-offset-4">MCP gateway</Link>{" "}
              for shared skills and connections; AI gateway model integration for those clients is
              in progress. Adding MCP alone does not route their model traffic.
            </p>
            <Link href="/guides/claude-code-codex-cursor" className="inline-block font-medium text-[var(--lp-ink)] underline underline-offset-4">
              Explore AI coding tools and agents
            </Link>
          </div>
        </section>

        <section aria-labelledby="data-heading" className="mt-24 rounded-[24px] bg-[var(--lp-tonal)] px-6 py-10 md:mt-28 md:px-12 md:py-12">
          <div className="text-[13px] text-[var(--lp-muted)]">Local desktop, company-controlled models</div>
          <h2 id="data-heading" className="mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">
            Your files stay on your PC.
          </h2>
          <div className="mt-6 grid gap-6 text-base leading-7 text-[var(--lp-body)] md:grid-cols-2 md:gap-12">
            <p>
              In the local desktop model-gateway setup, files and the workspace stay on the
              user&apos;s PC. Workspace processing sends SSO configuration and model traffic,
              not a copy of the workspace.
              There is no need to move the workspace into a cloud worker to govern model access.
            </p>
            <p>
              Model traffic includes prompts, responses, and any file content the agent includes as
              context. Local-first does not mean a remote model never sees company data. Choose
              your provider and data-handling policy accordingly. Product analytics, diagnostics,
              update checks, optional cloud workers, and connected services have separate data flows.
            </p>
          </div>
          <Link href="/privacy" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">Read the privacy policy</Link>
        </section>

        <section aria-labelledby="rollout-heading" className="mt-24 md:mt-28">
          <h2 id="rollout-heading" className="text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">
            Turn unsanctioned AI tools into an approved workflow.
          </h2>
          <ol className="mt-8 list-decimal space-y-4 pl-5 text-base leading-7 text-[var(--lp-body)] marker:font-medium marker:text-[var(--lp-ink)]">
            <li>Start with the tools employees actually use. Agree on approved models and what data may be sent to them.</li>
            <li>Set up company SSO, provider access, and permissions in OpenWork. Configure supported clients to use the AI gateway.</li>
            <li>Review gateway usage, adjust access, and make the approved path easy to adopt.</li>
          </ol>
          <p className="mt-6 max-w-[800px] border-l-2 border-[var(--lp-border)] pl-5 text-sm leading-6 text-[var(--lp-body)]">
            OpenWork governs traffic routed through it. It does not automatically discover or block
            every personal AI account or tool outside that path. Pair the gateway with employee
            guidance and endpoint or network controls where needed.
          </p>
        </section>

        <section aria-labelledby="faq-heading" className="mt-24 md:mt-28">
          <h2 id="faq-heading" className="text-[32px] font-medium leading-[38px] tracking-[-0.035em]">Shadow AI FAQ</h2>
          <div className="mt-8 border-b border-[var(--lp-border)]">
            {shadowAiFaq.map((entry) => (
              <details key={entry.question} className="group border-t border-[var(--lp-border)] py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-medium [&::-webkit-details-marker]:hidden">
                  {entry.question}
                  <span aria-hidden="true" className="text-[var(--lp-muted)] transition-transform duration-150 group-open:rotate-90">›</span>
                </summary>
                <p className="mt-4 max-w-[850px] text-sm leading-6 text-[var(--lp-body)]">{entry.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-24 border-t border-[var(--lp-border)] pt-10 md:mt-28">
          <h2 className="max-w-[760px] text-[32px] font-medium leading-[38px] tracking-[-0.035em]">Give your team an approved way to use AI.</h2>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link href="/enterprise#book" className="lp-pill-primary">Plan your rollout</Link>
            <Link href="/enterprise" className="lp-pill-secondary">Explore enterprise deployment</Link>
            <Link href="/pricing" className="lp-pill-secondary">Compare plans</Link>
          </div>
        </section>
        <div className="mt-16"><SiteFooter /></div>
      </main>
    </div>
  );
}

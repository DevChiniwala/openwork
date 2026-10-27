"use client";

import { ChevronRight } from "lucide-react";
import { KindTile } from "./item-logo";
import { LinkButton } from "./item-list";
import type { PluginSkill } from "./plugin-data";

/** Skill names are stored as slugs; people read "Prep a sales call". */
export function skillTitle(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Native disclosure keeps keyboard, focus and open state without a second page. */
export function SkillPreview({ skill, editHref }: { skill: PluginSkill; editHref?: string }) {
  return (
    <details className="group/skill" data-skill-preview={skill.id}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 text-[13px] text-[var(--dls-text-primary)] outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-gray-300 [&::-webkit-details-marker]:hidden">
        <KindTile kind="skill" />
        <span className="min-w-0 flex-1 break-words font-medium">{skillTitle(skill.name)}</span>
        <span className="shrink-0 text-[12px] text-[var(--dls-text-secondary)]">Skill</span>
        <ChevronRight className="size-4 shrink-0 text-[var(--dls-text-secondary)] transition-transform duration-150 ease-out group-open/skill:rotate-90 motion-reduce:transition-none" strokeWidth={1.5} aria-hidden />
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-4 sm:pl-14">
        {skill.description ? <p className="text-[13px] text-[var(--dls-text-secondary)]">{skill.description}</p> : null}
        {skill.body ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-[var(--dls-text-primary)]">{skill.body}</pre>
        ) : <p className="text-[13px] text-[var(--dls-text-secondary)]">No skill steps published yet.</p>}
        {editHref ? <div><LinkButton size="xs" href={editHref}>Edit skill</LinkButton></div> : null}
      </div>
    </details>
  );
}

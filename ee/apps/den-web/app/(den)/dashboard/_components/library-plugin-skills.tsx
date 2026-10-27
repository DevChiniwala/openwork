"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { ItemRowsSkeleton } from "./item-list";
import { pluginDetailQueryOptions } from "./plugin-data";
import { SkillPreview } from "./skill-preview";

/** Fetch contents only when asked, using the same authorized query as plugin details. */
export function LibraryPluginSkills({ pluginId, name }: { pluginId: string; name: string }) {
  const [opened, setOpened] = useState(false);
  const plugin = useQuery({ ...pluginDetailQueryOptions(pluginId), enabled: opened });
  return (
    <details className="group/skills mx-3 border-t border-gray-100" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
      <summary data-testid={`library-plugin-skills-${pluginId}`} aria-label={`Skills in ${name}`} className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-[12px] text-[var(--dls-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-gray-300 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform duration-150 ease-out group-open/skills:rotate-90 motion-reduce:transition-none" strokeWidth={1.5} aria-hidden />
        Skills
      </summary>
      {opened ? (
        <div className="divide-y divide-gray-100 pb-2">
          {plugin.isLoading ? <ItemRowsSkeleton label={`Loading skills in ${name}`} rows={2} /> : plugin.error ? (
            <div className="flex items-center justify-between gap-3 py-3" role="alert">
              <p className="text-[13px] text-[var(--dls-text-secondary)]">Skills could not load.</p>
              <DenButton variant="secondary" size="xs" onClick={() => void plugin.refetch()}>Try again</DenButton>
            </div>
          ) : plugin.data?.skills.length ? plugin.data.skills.map((skill) => <SkillPreview key={skill.id} skill={skill} />) : (
            <p className="py-3 text-[13px] text-[var(--dls-text-secondary)]">No skills in this plugin.</p>
          )}
        </div>
      ) : null}
    </details>
  );
}

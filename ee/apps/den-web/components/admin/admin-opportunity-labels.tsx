import { ArrowDownRight, BadgeDollarSign, CalendarClock, Hand, Rocket, UsersRound, type LucideIcon } from "lucide-react";
import type { OpportunityItem } from "@openwork/types/den/admin-organization";
import { DenBadge } from "../../app/(den)/_components/ui/badge";

export const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

// Kinds are different jobs, not one list relabelled: say which job each row is.
export const KIND: Record<OpportunityItem["kind"], { label: string; icon: LucideIcon; tone: string }> = {
  follow_up: { label: "Follow-up", icon: CalendarClock, tone: "text-[var(--dls-accent)]" },
  commercial: { label: "Commercial", icon: BadgeDollarSign, tone: "text-[var(--ow-success)]" },
  expansion: { label: "Expansion", icon: UsersRound, tone: "text-[var(--ow-success)]" },
  declining: { label: "Check in", icon: ArrowDownRight, tone: "text-[var(--ow-warning)]" },
  activation: { label: "Getting started", icon: Rocket, tone: "text-[var(--dls-text-secondary)]" },
  welcome: { label: "Welcome", icon: Hand, tone: "text-[var(--dls-text-secondary)]" },
};

export const STAGE_LABEL: Record<NonNullable<OpportunityItem["followUp"]>["stage"], string> = {
  needs_review: "Needs review", ready: "Ready for outreach", contacted: "Contacted", engaged: "Engaged", closed: "Closed", dismissed: "Dismissed",
};

export const ADOPTION_LABEL: Record<OpportunityItem["adoption"]["stage"], string> = {
  no_observed_use: "No observed use", quiet_this_week: "Not observed this week", individual: "One person active",
  team: "Team active", expanding: "Team growing",
};

// Red is reserved for failures; priority uses amber, blue and neutral with text.
const PRIORITY_TONE = { high: "warning", medium: "info", low: "neutral" } as const;
export function PriorityBadge({ priority }: { priority: OpportunityItem["priority"] }) {
  return <DenBadge size="sm" tone={PRIORITY_TONE[priority]}>{priority === "high" ? "High" : priority === "medium" ? "Medium" : "Low"} priority</DenBadge>;
}

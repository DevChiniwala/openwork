import Link from "next/link";
import { LayoutDashboard, ScanSearch } from "lucide-react";

export function AdminOpportunityNav({ active }: { active: "overview" | "adoption" }) {
  return <nav aria-label="Opportunity sections" className="flex gap-5 border-b border-[var(--dls-border)] text-sm">
    {[
      { id: "overview", label: "This week", href: "/admin/opportunities", icon: LayoutDashboard },
      { id: "adoption", label: "Adoption opportunities", href: "/admin/opportunities/adoption", icon: ScanSearch },
    ].map(({ id, label, href, icon: Icon }) => <Link key={id} prefetch={false} href={href} aria-current={id === active ? "page" : undefined}
      className={`flex items-center gap-2 border-b-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 ${id === active ? "border-current font-medium text-[var(--dls-text-primary)]" : "border-transparent text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"}`}>
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />{label}
    </Link>)}
  </nav>;
}

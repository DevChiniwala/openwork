import { CapabilityMatrix } from "./capability-matrix";
import { CompareSection } from "./lp-compare";
import { LpSectionHeader } from "./lp-primitives";

const DEFAULT_CAPTION =
  "Claude Enterprise, Claude Desktop on 3P, and OpenWork compared by capability";

type Props = {
  /** id of the section heading, used for aria-labelledby. */
  id?: string;
  heading?: string;
  caption?: string;
  /**
   * When set, render the landing-page section header (small label above a
   * light heading) instead of the compare-page heading. Used on /enterprise.
   */
  label?: string;
  className?: string;
};

/**
 * OpenWork vs Claude Cowork capability comparison, shared by the
 * Claude Cowork alternative page and the Enterprise page.
 */
export function CoworkComparison({
  id = "comparison-heading",
  heading = "OpenWork vs Claude Cowork",
  caption = DEFAULT_CAPTION,
  label,
  className
}: Props) {
  if (!label) {
    return (
      <CompareSection id={id} heading={heading}>
        <CapabilityMatrix caption={caption} />
      </CompareSection>
    );
  }

  return (
    <section aria-labelledby={id} className={`scroll-mt-28 ${className ?? ""}`}>
      <div id={id}>
        <LpSectionHeader label={label} heading={heading} />
      </div>
      <div className="mt-10">
        <CapabilityMatrix caption={caption} />
      </div>
    </section>
  );
}

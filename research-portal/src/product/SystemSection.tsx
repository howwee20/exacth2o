import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/** One system owns its experiments, status, and system-specific actions. */
export function SystemSection({ name, description, action, children, defaultExpanded = true }: {
  name: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();
  return <section className="px-system-section" aria-label={name} data-expanded={expanded}>
    <header className="px-system-heading">
      <div><h2><button type="button" className="px-system-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <ChevronDown size={18} aria-hidden="true" />{name}
      </button></h2>{description ? <p>{description}</p> : null}</div>
      {action}
    </header>
    <div className="px-system-content" id={contentId} hidden={!expanded}>{children}</div>
  </section>;
}

import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useState } from "react";
import { followPortalLink, portalRouteHref, portalRouteUrl, type PortalRoute, usePortalSearch } from "../portalRoute";

/** An ordinary link to a portal route: real href (copy, open in new tab), in-app navigation on click. */
export function PortalLink({
  to,
  extra,
  children,
  onClick,
  ...rest
}: { to: PortalRoute; extra?: Record<string, string | null>; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  // Re-render when the URL changes so the carried `project` parameter stays current.
  usePortalSearch();
  return (
    <a
      {...rest}
      href={portalRouteHref(to, extra)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) followPortalLink(event, to, extra);
      }}
    >
      {children}
    </a>
  );
}

/** Copy the absolute URL of a route; returns a small status for the caller to show. */
export function useCopyRoute() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (route: PortalRoute, label = "Link copied") => {
    const url = portalRouteUrl(route);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(label);
    } catch {
      setCopied(url);
    }
    window.setTimeout(() => setCopied(null), 2600);
  };
  return { copied, copy };
}

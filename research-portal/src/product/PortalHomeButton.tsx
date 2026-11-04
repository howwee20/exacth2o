import { ArrowLeft } from "lucide-react";

/** Page navigation stays in document flow, clear of the shared header controls. */
export function PortalHomeButton({ onClick }: { onClick: () => void }) {
  return <div className="px-page-home">
    <button type="button" className="px-home-button" onClick={onClick}>
      <ArrowLeft size={15} aria-hidden="true" />Home
    </button>
  </div>;
}

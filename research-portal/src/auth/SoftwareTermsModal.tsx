import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { softwareTermsCompany, softwareTermsIntro, softwareTermsSections, softwareTermsVersion } from "../softwareTerms";

export function SoftwareTermsModal({
  open,
  accepted,
  onAgree,
  onClose,
}: {
  open: boolean;
  accepted: boolean;
  onAgree: () => void;
  onClose: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canAgree, setCanAgree] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCanAgree(accepted);
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 12) {
        setCanAgree(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accepted, open]);

  if (!open) return null;

  function handleScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining <= 16) {
      setCanAgree(true);
    }
  }

  return (
    <div className="portal-terms-backdrop" role="presentation">
      <section
        className="portal-terms-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portalTermsTitle"
        aria-describedby="portalTermsNote"
      >
        <header className="portal-terms-header">
          <div>
            <span>Exact H2O LLC</span>
            <h3 id="portalTermsTitle">Software Access Terms</h3>
            <p id="portalTermsNote">Version {softwareTermsVersion}.</p>
          </div>
          <button type="button" className="portal-terms-close" aria-label="Close terms" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="portal-terms-scroll" ref={scrollerRef} onScroll={handleScroll} tabIndex={0}>
          {softwareTermsIntro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {softwareTermsSections.map((section) => (
            <section key={section.title} className="portal-terms-section">
              <h4>{section.title}</h4>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.items?.length ? (
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
          <section className="portal-terms-section">
            <h4>Contact</h4>
            {softwareTermsCompany.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        </div>

        <footer className="portal-terms-actions">
          <p>{canAgree ? "Ready for acceptance." : "Scroll through the terms to enable agreement."}</p>
          <div>
            <button type="button" className="portal-terms-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="portal-terms-primary"
              disabled={!canAgree}
              onClick={() => {
                onAgree();
                onClose();
              }}
            >
              I agree
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

import { ArrowLeft, LogOut, Menu, X } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { StatusChip } from "../SettingsChrome";
import { controllerPillText, controllerPresence } from "../settingsPresentation";
import type { SettingsNavItem, SettingsSection } from "../portalTypes";
import type { PortalExperiment } from "../experimentRegistry";

type Props = {
  scope: "installation" | "experiment";
  experiment: PortalExperiment;
  navOpen: boolean;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  activeItem: SettingsNavItem;
  activeSection: SettingsSection;
  availableSettingsNavGroups: { label: SettingsNavItem["group"]; items: SettingsNavItem[] }[];
  presence: ReturnType<typeof controllerPresence>;
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onSignOut: () => void;
  children: ReactNode;
};

/** Settings navigation and layout, independent of commands and form state. */
export function SettingsFrame({ scope, experiment, navOpen, setNavOpen, activeItem,
  activeSection, availableSettingsNavGroups, presence, onClose, onSectionChange,
  onSignOut, children }: Props) {
  const selectSection = (section: SettingsSection) => {
    onSectionChange(section);
    setNavOpen(false);
  };

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label={scope === "installation" ? "Installation settings" : `${experiment.name} settings`}>
      <section className={`settings-modal${navOpen ? " is-nav-open" : ""}`}>
        <div className="settings-mobile-bar">
          <button
            type="button"
            onClick={() => setNavOpen((current) => !current)}
            aria-expanded={navOpen}
            aria-controls="settings-sidebar"
          >
            {navOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
            Sections
          </button>
          <strong>{activeItem.label}</strong>
          <button type="button" onClick={onClose} aria-label="Close settings">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {navOpen ? <button type="button" className="settings-nav-scrim" aria-label="Close sections" onClick={() => setNavOpen(false)} /> : null}
        <aside className="settings-sidebar" id="settings-sidebar" aria-label="Settings sections">
          <button type="button" className="settings-back-button" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to portal
          </button>
          <nav>
            {availableSettingsNavGroups.map((group) => (
              <div className="settings-sidebar-group" key={group.label}>
                <p className="settings-sidebar-group-label">{scope === "installation" && group.label === "Experiment" ? "Controller" : group.label}</p>
                {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={item.id === activeItem.id ? "is-active" : ""}
                      aria-current={item.id === activeItem.id ? "page" : undefined}
                      onClick={() => selectSection(item.id)}
                    >
                      <span>
                        <strong>{item.label}</strong>
                      </span>
                    </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-account-actions">
            <button type="button" className="settings-sign-out-button" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </aside>
        <section className={`settings-content is-${activeSection}`}>
          {activeSection !== "autocalibrate" ? <header className="settings-content-header">
            <div>
              <p className="settings-content-eyebrow">{scope === "installation" ? "Installation settings" : `${experiment.name} · Experiment settings`}</p>
              <h2>{activeSection === "assistant" ? "Settings assistant" : activeItem.label}</h2>
              <p className="settings-content-lede">
                {activeSection === "assistant"
                  ? "Describe a settings change in plain language, then review it before anything is queued."
                  : activeSection === "overview" ? (scope === "installation" ? "Status and configuration for every pot on this controller." : "The saved plan and records for this experiment.") : activeItem.description}
              </p>
            </div>
            <div className="settings-content-actions">
              {scope === "installation" ? <StatusChip tone={presence.tone}>{controllerPillText(presence)}</StatusChip> : null}
            </div>
          </header> : null}
          <div className="settings-section-body">
            {children}
          </div>
        </section>
      </section>
    </div>
  );
}

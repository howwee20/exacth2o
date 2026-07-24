import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import { ExperimentArchiveReview } from "./ExperimentArchiveReview";
import { ExperimentBuilder } from "./ExperimentBuilder";
import { SettingsAssistant } from "./SettingsAssistant";
import {
  AssistantAutomationPanel,
  AssistantMessageBody,
  LifecycleReview,
  MonitorReview,
  ScheduleReview,
} from "./AssistantOperations";
import {
  chatWithAssistant,
  loadAssistantConversation,
  type AssistantConversationMessage,
} from "./experimentClient";
import type { SettingsPlan } from "./settingsSpec";
import type { PairingRow } from "./types";

type AssistantWorkflow =
  | "experiment"
  | "settings"
  | "archive"
  | "schedule"
  | "monitor"
  | "lifecycle";

export function PortalAssistantWorkspace({
  projectId,
  pairings,
  inventoryUpdatedAt,
  activity,
  controlBusy,
  onApplySettings,
  onExperimentCreated,
  onExperimentArchived,
}: {
  projectId: string;
  pairings: PairingRow[];
  inventoryUpdatedAt: string | null;
  activity: ReactNode;
  controlBusy: boolean;
  onApplySettings: (plan: SettingsPlan, configHash: string) => Promise<void>;
  onExperimentCreated: (slug: string) => Promise<void>;
  onExperimentArchived: () => Promise<void>;
}) {
  const [request, setRequest] = useState("");
  const [messages, setMessages] = useState<AssistantConversationMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [automationRefreshKey, setAutomationRefreshKey] = useState(0);
  const [working, setWorking] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<{
    type: AssistantWorkflow;
    prompt: string;
    autoStart: boolean;
    key: number;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void loadAssistantConversation(projectId)
      .then((conversation) => {
        if (!active) return;
        setThreadId(conversation.threadId);
        setMessages(conversation.messages.map(({ role, content }) => ({ role, content })));
      })
      .catch(() => {
        // Conversation storage is optional during a rolling deployment.
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const sendRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = request.trim();
    if (!prompt) return;
    const conversation = messages.slice(-12);
    setMessages((current) => [...current, { role: "user", content: prompt }]);
    setRequest("");
    setWorking(true);
    setAssistantError(null);
    try {
      const result = await chatWithAssistant(projectId, prompt, conversation, threadId);
      setThreadId(result.thread_id);
      setMessages((current) => [
        ...current,
        { role: "assistant", content: result.reply },
      ]);
      if (
        (
          result.workflow === "experiment" ||
          result.workflow === "settings" ||
          result.workflow === "archive" ||
          result.workflow === "schedule" ||
          result.workflow === "monitor" ||
          result.workflow === "lifecycle"
        ) &&
        result.workflow_prompt
      ) {
        setWorkflow({
          type: result.workflow,
          prompt: result.workflow_prompt,
          autoStart: true,
          key: Date.now(),
        });
      }
    } catch (nextError) {
      setAssistantError(
        nextError instanceof Error ? nextError.message : "Could not answer the request.",
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="portal-workspace-intro">
      <section className="portal-assistant-hero">
        <div className="portal-assistant-copy">
          {messages.length ? (
            <div className="portal-assistant-thread" aria-live="polite">
              {messages.map((message, index) => (
                <article
                  className={`is-${message.role}`}
                  key={`${message.role}-${index}-${message.content.slice(0, 24)}`}
                >
                  <strong>{message.role === "user" ? "You" : "ExactH2O"}</strong>
                  <AssistantMessageBody content={message.content} />
                </article>
              ))}
              {working ? (
                <article className="is-assistant is-working">
                  <Loader2 className="chart-loading-spinner" size={16} />
                  <p>Checking the system</p>
                </article>
              ) : null}
            </div>
          ) : null}
          <form className="portal-assistant-request" onSubmit={(event) => void sendRequest(event)}>
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              maxLength={4_000}
              placeholder="Ask about an experiment or describe a change."
              aria-label="Ask ExactH2O or describe a change"
            />
            <button type="submit" disabled={working || !request.trim()}>
              {working
                ? <Loader2 className="chart-loading-spinner" size={16} />
                : <Sparkles size={16} />}
              Send
            </button>
          </form>
          {assistantError ? (
            <span className="portal-assistant-error" role="alert">{assistantError}</span>
          ) : null}
          <div className="portal-assistant-actions">
            <button
              type="button"
              onClick={() => setWorkflow({
                type: "experiment",
                prompt: "",
                autoStart: false,
                key: Date.now(),
              })}
            >
              <Sparkles size={16} />
              New experiment
            </button>
            <button
              type="button"
              onClick={() => setWorkflow({
                type: "settings",
                prompt: "",
                autoStart: false,
                key: Date.now(),
              })}
            >
              <MessageSquare size={16} />
              System settings
            </button>
          </div>
        </div>
      </section>
      {workflow?.type === "experiment" ? (
        <ExperimentBuilder
          key={`experiment-${workflow.key}`}
          projectId={projectId}
          pairings={pairings}
          inventoryUpdatedAt={inventoryUpdatedAt}
          initialPrompt={workflow.prompt}
          autoGenerate={workflow.autoStart}
          presentation="inline"
          onClose={() => setWorkflow(null)}
          onCreated={onExperimentCreated}
        />
      ) : null}
      {workflow?.type === "settings" ? (
        <section className="portal-inline-settings" key={`settings-${workflow.key}`}>
          <header>
            <h2>Review settings</h2>
            <button type="button" onClick={() => setWorkflow(null)} aria-label="Close settings plan">
              <X size={17} />
            </button>
          </header>
          <SettingsAssistant
            projectId={projectId}
            initialPrompt={workflow.prompt}
            autoReview={workflow.autoStart}
            embedded
            controlBusy={controlBusy}
            onApply={onApplySettings}
          />
        </section>
      ) : null}
      {workflow?.type === "archive" ? (
        <ExperimentArchiveReview
          key={`archive-${workflow.key}`}
          projectId={projectId}
          experiment={workflow.prompt}
          onClose={() => setWorkflow(null)}
          onArchived={onExperimentArchived}
        />
      ) : null}
      {workflow?.type === "schedule" ? (
        <ScheduleReview
          key={`schedule-${workflow.key}`}
          projectId={projectId}
          initialPrompt={workflow.prompt}
          onClose={() => setWorkflow(null)}
          onChanged={() => setAutomationRefreshKey((current) => current + 1)}
        />
      ) : null}
      {workflow?.type === "monitor" ? (
        <MonitorReview
          key={`monitor-${workflow.key}`}
          projectId={projectId}
          initialPrompt={workflow.prompt}
          onClose={() => setWorkflow(null)}
          onChanged={() => setAutomationRefreshKey((current) => current + 1)}
        />
      ) : null}
      {workflow?.type === "lifecycle" ? (
        <LifecycleReview
          key={`lifecycle-${workflow.key}`}
          projectId={projectId}
          request={workflow.prompt}
          onClose={() => setWorkflow(null)}
          onChanged={() => {
            setAutomationRefreshKey((current) => current + 1);
            void onExperimentArchived();
          }}
        />
      ) : null}
      <AssistantAutomationPanel
        projectId={projectId}
        refreshKey={automationRefreshKey}
      />
      {activity}
    </div>
  );
}

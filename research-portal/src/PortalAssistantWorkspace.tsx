import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  Check,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AssistantEvidenceArtifacts } from "./AssistantEvidenceArtifacts";
import type { AssistantEvidenceBundle } from "./assistantEvidence";
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
  deleteAssistantThread,
  listAssistantThreads,
  loadAssistantConversation,
  renameAssistantThread,
  type AssistantConversationMessage,
  type AssistantThread,
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

type AssistantDisplayMessage = AssistantConversationMessage & {
  id: string;
  evidence?: AssistantEvidenceBundle;
};

export function PortalAssistantWorkspace({
  projectId,
  pairings,
  inventoryUpdatedAt,
  activity,
  controlBusy,
  onApplySettings,
  onExperimentCreated,
  onExperimentArchived,
  onOpenExperiment,
}: {
  projectId: string;
  pairings: PairingRow[];
  inventoryUpdatedAt: string | null;
  activity: ReactNode;
  controlBusy: boolean;
  onApplySettings: (plan: SettingsPlan, configHash: string) => Promise<void>;
  onExperimentCreated: (slug: string) => Promise<void>;
  onExperimentArchived: () => Promise<void>;
  onOpenExperiment?: (slug: string) => void;
}) {
  const [request, setRequest] = useState("");
  const [messages, setMessages] = useState<AssistantDisplayMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<AssistantThread[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threadLoading, setThreadLoading] = useState(true);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [threadActionBusy, setThreadActionBusy] = useState(false);
  const [automationRefreshKey, setAutomationRefreshKey] = useState(0);
  const [working, setWorking] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<{
    type: AssistantWorkflow;
    prompt: string;
    autoStart: boolean;
    key: number;
  } | null>(null);

  const displayConversation = useCallback(async (nextThreadId: string) => {
    setThreadLoading(true);
    setAssistantError(null);
    try {
      const conversation = await loadAssistantConversation(projectId, nextThreadId);
      setThreadId(conversation.threadId);
      setMessages(conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        evidence: message.metadata?.evidence,
      })));
    } catch (nextError) {
      setAssistantError(
        nextError instanceof Error ? nextError.message : "Could not load the conversation.",
      );
    } finally {
      setThreadLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setThreadLoading(true);
    void listAssistantThreads(projectId)
      .then(async (nextThreads) => {
        if (!active) return;
        setThreads(nextThreads);
        if (!nextThreads.length) {
          setThreadId(null);
          setMessages([]);
          setThreadLoading(false);
          return;
        }
        const conversation = await loadAssistantConversation(projectId, nextThreads[0].id);
        if (!active) return;
        setThreadId(conversation.threadId);
        setMessages(conversation.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          evidence: message.metadata?.evidence,
        })));
        setThreadLoading(false);
      })
      .catch(() => {
        if (active) setThreadLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const startNewChat = () => {
    setThreadId(null);
    setMessages([]);
    setRequest("");
    setWorkflow(null);
    setAssistantError(null);
    setHistoryOpen(false);
  };

  const beginRename = (thread: AssistantThread) => {
    setRenamingThreadId(thread.id);
    setRenamingTitle(thread.title);
    setDeletingThreadId(null);
  };

  const saveRename = async () => {
    const title = renamingTitle.trim();
    if (!renamingThreadId || !title) return;
    setThreadActionBusy(true);
    try {
      const result = await renameAssistantThread(projectId, renamingThreadId, title);
      setThreads((current) => current.map((thread) =>
        thread.id === result.thread.id ? result.thread : thread
      ));
      setRenamingThreadId(null);
      setRenamingTitle("");
    } catch (nextError) {
      setAssistantError(
        nextError instanceof Error ? nextError.message : "Could not rename the conversation.",
      );
    } finally {
      setThreadActionBusy(false);
    }
  };

  const confirmDelete = async (deleteThreadId: string) => {
    setThreadActionBusy(true);
    try {
      await deleteAssistantThread(projectId, deleteThreadId);
      const nextThreads = await listAssistantThreads(projectId);
      setThreads(nextThreads);
      setDeletingThreadId(null);
      if (threadId === deleteThreadId) {
        if (nextThreads.length) await displayConversation(nextThreads[0].id);
        else startNewChat();
      }
    } catch (nextError) {
      setAssistantError(
        nextError instanceof Error ? nextError.message : "Could not delete the conversation.",
      );
    } finally {
      setThreadActionBusy(false);
    }
  };

  const sendRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = request.trim();
    if (!prompt) return;
    const conversation = messages.slice(-12).map(({ role, content }) => ({ role, content }));
    setMessages((current) => [
      ...current,
      { id: `local-user-${Date.now()}`, role: "user", content: prompt },
    ]);
    setRequest("");
    setWorking(true);
    setAssistantError(null);
    try {
      const result = await chatWithAssistant(projectId, prompt, conversation, threadId);
      setThreadId(result.thread_id);
      setMessages((current) => [
        ...current,
        {
          id: result.request_id,
          role: "assistant",
          content: result.reply,
          evidence: result.evidence,
        },
      ]);
      void listAssistantThreads(projectId).then(setThreads).catch(() => undefined);
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
      <section className={`portal-assistant-workbench ${historyOpen ? "has-history" : ""}`}>
        <header className="portal-assistant-workbench-head">
          <div>
            <span><Sparkles size={15} /></span>
            <strong>Assistant</strong>
          </div>
          <nav>
            <button
              type="button"
              className={historyOpen ? "is-selected" : ""}
              onClick={() => setHistoryOpen((current) => !current)}
            >
              <History size={15} />
              Chats
            </button>
            <button type="button" onClick={startNewChat}>
              <Plus size={15} />
              New
            </button>
          </nav>
        </header>
        <div className="portal-assistant-workbench-body">
          {historyOpen ? (
            <aside className="portal-assistant-history" aria-label="Saved conversations">
              {threads.length ? threads.map((thread) => (
                <article className={thread.id === threadId ? "is-selected" : ""} key={thread.id}>
                  {renamingThreadId === thread.id ? (
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      void saveRename();
                    }}>
                      <input
                        value={renamingTitle}
                        onChange={(event) => setRenamingTitle(event.target.value)}
                        maxLength={160}
                        aria-label="Conversation name"
                        autoFocus
                      />
                      <button type="submit" disabled={threadActionBusy || !renamingTitle.trim()} title="Save">
                        <Check size={14} />
                      </button>
                      <button type="button" onClick={() => setRenamingThreadId(null)} title="Cancel">
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="portal-assistant-history-open"
                        onClick={() => {
                          setHistoryOpen(false);
                          void displayConversation(thread.id);
                        }}
                      >
                        <strong>{thread.title}</strong>
                        <time>{new Date(thread.updated_at).toLocaleDateString()}</time>
                      </button>
                      {deletingThreadId === thread.id ? (
                        <div className="portal-assistant-history-confirm">
                          <button
                            type="button"
                            disabled={threadActionBusy}
                            onClick={() => void confirmDelete(thread.id)}
                          >
                            Delete
                          </button>
                          <button type="button" onClick={() => setDeletingThreadId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="portal-assistant-history-actions">
                          <button type="button" onClick={() => beginRename(thread)} title="Rename">
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletingThreadId(thread.id);
                              setRenamingThreadId(null);
                            }}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </article>
              )) : (
                <p>No saved chats.</p>
              )}
            </aside>
          ) : null}
          <div className="portal-assistant-copy">
            {threadLoading ? (
              <div className="portal-assistant-thread-loading">
                <Loader2 className="chart-loading-spinner" size={17} />
              </div>
            ) : messages.length ? (
              <div className="portal-assistant-thread" aria-live="polite">
                {messages.map((message) => (
                  <article className={`is-${message.role}`} key={message.id}>
                    <strong>{message.role === "user" ? "You" : "ExactH2O"}</strong>
                    <AssistantMessageBody content={message.content} />
                    {message.role === "assistant" && message.evidence ? (
                      <AssistantEvidenceArtifacts
                        projectId={projectId}
                        evidence={message.evidence}
                        onOpenExperiment={onOpenExperiment}
                      />
                    ) : null}
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

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  applyDateApproval,
  createEventGroup,
  createEventGroupAndMove,
  deleteEventGroup,
  finalizeOrganization,
  getAppConfiguration,
  getDashboardStats,
  getDateMediaThumbnail,
  getDateReviewQueue,
  getEventGroupItems,
  getEventGroupMediaPreview,
  getEventGroups,
  getToolHealth,
  initializeApp,
  moveEventGroupItems,
  renameEventGroup,
  runEventGrouping,
  setAiTaskModel,
  setAnthropicKey,
  setOpenAiKey,
  setOutputDirectory,
  setWorkingDirectory,
  startDownloadSession,
  resetSession,
  type ToolHealth
} from "./lib/api";
import type { DashboardStats, DateEstimate, EventGroup, EventGroupItem } from "./types";

type Tab = "dashboard" | "dates" | "events" | "settings";
type PipelineStage = "index" | "date" | "group" | "finalize";
type PipelineStageState = "idle" | "running" | "completed" | "failed";

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  downloading: 0,
  indexed: 0,
  dateNeedsReview: 0,
  dateVerified: 0,
  grouped: 0,
  filed: 0,
  errors: 0
};

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_REFRESH_INTERVAL_MS ?? "3000");
const DISABLE_UI_POLLING = import.meta.env.VITE_E2E_DISABLE_POLLING === "1";

function derivePipelineStages(stats: DashboardStats): Record<PipelineStage, PipelineStageState> {
  return {
    index: stats.total > 0 ? "completed" : "idle",
    date:
      stats.total === 0
        ? "idle"
        : stats.dateNeedsReview > 0
          ? "running"
          : stats.dateVerified > 0 || stats.grouped > 0 || stats.filed > 0
            ? "completed"
            : "idle",
    group: stats.grouped > 0 || stats.filed > 0 ? "completed" : "idle",
    finalize: stats.filed > 0 ? "completed" : "idle"
  };
}

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [dateItems, setDateItems] = useState<DateEstimate[]>([]);
  const [groups, setGroups] = useState<EventGroup[]>([]);
  const [message, setMessage] = useState<string>("");
  const [workingDirectory, setWorkingDirectoryState] = useState("C:\\Memoria\\inbox");
  const [outputDirectory, setOutputDirectoryState] = useState("C:\\Memoria");
  const [openAiKey, setOpenAiKey] = useState("");
  const [anthropicKey, setAnthropicKeyState] = useState("");
  const [aiModels, setAiModels] = useState({
    dateEstimation: { provider: "anthropic", model: "claude-sonnet-4-6" },
    eventNaming: { provider: "anthropic", model: "claude-sonnet-4-6" }
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showResetPrompt, setShowResetPrompt] = useState(false);
  const [showAddGroupForm, setShowAddGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupError, setNewGroupError] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [activeGroupItems, setActiveGroupItems] = useState<EventGroupItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [eventMoveMode, setEventMoveMode] = useState<"existing" | "new">("existing");
  const [eventMoveTargetGroupId, setEventMoveTargetGroupId] = useState<number | null>(null);
  const [eventMoveNewGroupName, setEventMoveNewGroupName] = useState("");
  const [eventMoveError, setEventMoveError] = useState("");
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [previewItem, setPreviewItem] = useState<EventGroupItem | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [toolHealth, setToolHealth] = useState<ToolHealth | null>(null);
  const [pipelineStages, setPipelineStages] = useState<Record<PipelineStage, PipelineStageState>>(
    derivePipelineStages(DEFAULT_STATS)
  );

  async function refreshAll() {
    const [nextStats, nextDateItems, nextGroups] = await Promise.all([
      getDashboardStats(),
      getDateReviewQueue(),
      getEventGroups()
    ]);
    setStats(nextStats);
    setDateItems(nextDateItems);
    setGroups(nextGroups);
    setPipelineStages((prev) => {
      const derived = derivePipelineStages(nextStats);
      return {
        index: prev.index === "failed" ? "failed" : derived.index,
        date: prev.date === "failed" ? "failed" : derived.date,
        group: prev.group === "failed" ? "failed" : derived.group,
        finalize: prev.finalize === "failed" ? "failed" : derived.finalize
      };
    });
  }

  useEffect(() => {
    initializeApp()
      .then(async () => {
        try {
          const cfg = await getAppConfiguration();
          setWorkingDirectoryState(cfg.workingDirectory);
          setOutputDirectoryState(cfg.outputDirectory);
          setAiModels(cfg.aiTaskModels);
        } catch {
          // keep defaults
        }
        try {
          const health = await getToolHealth();
          setToolHealth(health);
        } catch {
          setToolHealth(null);
        }
        await refreshAll();
      })
      .catch((err) => setMessage(`Initialization failed: ${String(err)}`));
  }, []);

  useEffect(() => {
    if (DISABLE_UI_POLLING) return;
    const timer = setInterval(() => {
      refreshAll().catch(() => undefined);
    }, Math.max(POLL_INTERVAL_MS, 500));
    return () => clearInterval(timer);
  }, []);

  async function onStart() {
    setBusyAction("ingest");
    setPipelineStages((prev) => ({ ...prev, index: "running", date: "idle", group: "idle", finalize: "idle" }));
    try {
      await startDownloadSession({ workingDirectory, outputDirectory });
      await refreshAll();
      setMessage("Media indexed with metadata extraction and date validation.");
      setTab("dashboard");
    } catch (err) {
      setMessage(`Indexing failed: ${String(err)}`);
      setPipelineStages((prev) => ({ ...prev, index: "failed" }));
    } finally {
      setBusyAction(null);
    }
  }

  async function onRunGrouping() {
    setBusyAction("group");
    setPipelineStages((prev) => ({ ...prev, group: "running", finalize: "idle" }));
    try {
      await runEventGrouping();
      await refreshAll();
      setMessage("Event grouping complete.");
    } catch (err) {
      setMessage(`Grouping failed: ${String(err)}`);
      setPipelineStages((prev) => ({ ...prev, group: "failed" }));
    } finally {
      setBusyAction(null);
    }
  }

  async function onFinalize() {
    setBusyAction("finalize");
    setPipelineStages((prev) => ({ ...prev, finalize: "running" }));
    try {
      await finalizeOrganization();
      await refreshAll();
      setMessage("Organization finalized.");
    } catch (err) {
      setMessage(`Finalize failed: ${String(err)}`);
      setPipelineStages((prev) => ({ ...prev, finalize: "failed" }));
    } finally {
      setBusyAction(null);
    }
  }

  async function onResetSession(deleteGeneratedFiles: boolean) {
    setBusyAction("reset");
    try {
      const result = await resetSession(deleteGeneratedFiles);
      setShowResetPrompt(false);
      await refreshAll();
      if (result.deletedGeneratedFiles) {
        setMessage(`Session reset. Removed ${result.removedDirectories.length} generated directories.`);
      } else {
        setMessage("Session reset. Configuration was preserved.");
      }
    } catch (err) {
      setMessage(`Reset session failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const datePhaseLabel = useMemo(
    () => (stats.dateNeedsReview > 0 ? `2) Date Enforcement (${stats.dateNeedsReview} pending)` : "2) Date Enforcement"),
    [stats.dateNeedsReview]
  );

  const normalizedGroupNames = useMemo(() => new Set(groups.map((group) => normalizeName(group.name))), [groups]);
  const activeGroup = useMemo(
    () => (activeGroupId === null ? null : groups.find((group) => group.id === activeGroupId) ?? null),
    [activeGroupId, groups]
  );

  useEffect(() => {
    if (!activeGroupId) {
      return;
    }
    getEventGroupItems(activeGroupId)
      .then((items) => {
        setActiveGroupItems(items);
        setSelectedItemIds([]);
        setLastSelectedIndex(null);
      })
      .catch((err) => {
        setMessage(`Loading group detail failed: ${String(err)}`);
      });
  }, [activeGroupId]);

  useEffect(() => {
    if (!previewItem) {
      setPreviewSrc("");
      return;
    }
    getEventGroupMediaPreview(previewItem.id)
      .then((src) => setPreviewSrc(src ?? ""))
      .catch((err) => setMessage(`Preview failed: ${String(err)}`));
  }, [previewItem]);

  async function onCreateGroup() {
    const normalized = normalizeName(newGroupName);
    if (!normalized) {
      setNewGroupError("Group name is required");
      return;
    }
    if (normalizedGroupNames.has(normalized)) {
      setNewGroupError("A group with this name already exists");
      return;
    }
    setBusyAction("create-group");
    setNewGroupError("");
    try {
      await createEventGroup(newGroupName.trim());
      await refreshAll();
      setShowAddGroupForm(false);
      setNewGroupName("");
      setMessage("Event group created.");
    } catch (err) {
      setNewGroupError(String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function onDeleteGroup(group: EventGroup) {
    const confirmed = window.confirm(`Delete ${group.name}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    setBusyAction(`delete-group-${group.id}`);
    try {
      await deleteEventGroup(group.id);
      await refreshAll();
      setMessage(`Deleted group ${group.name}.`);
    } catch (err) {
      setMessage(`Delete failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  function openMoveDialog() {
    const defaultTarget = groups.find((group) => group.id !== activeGroupId)?.id ?? null;
    setEventMoveTargetGroupId(defaultTarget);
    setEventMoveMode("existing");
    setEventMoveError("");
    setEventMoveNewGroupName("");
    setShowMoveDialog(true);
  }

  async function onMoveSelectedItems() {
    if (!activeGroupId || selectedItemIds.length === 0) {
      return;
    }
    setBusyAction("move-group-items");
    setEventMoveError("");
    try {
      if (eventMoveMode === "existing") {
        if (!eventMoveTargetGroupId) {
          setEventMoveError("Choose a destination group");
          return;
        }
        await moveEventGroupItems(selectedItemIds, eventMoveTargetGroupId);
      } else {
        const normalized = normalizeName(eventMoveNewGroupName);
        if (!normalized) {
          setEventMoveError("Group name is required");
          return;
        }
        if (normalizedGroupNames.has(normalized)) {
          setEventMoveError("A group with this name already exists");
          return;
        }
        await createEventGroupAndMove(eventMoveNewGroupName.trim(), selectedItemIds);
      }
      const [nextGroups, nextItems] = await Promise.all([getEventGroups(), getEventGroupItems(activeGroupId)]);
      setGroups(nextGroups);
      setActiveGroupItems(nextItems);
      setSelectedItemIds([]);
      setLastSelectedIndex(null);
      setShowMoveDialog(false);
      setMessage("Moved selected items.");
    } catch (err) {
      setEventMoveError(String(err));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="layout" data-testid="layout-root">
      <div className="topbar">
        <div>
          <h1 className="title">Memoria</h1>
          <p className="subtitle">Local Media Organizer</p>
        </div>
        <div className="statusPill" data-testid="status-pill">{message || "Ready"}</div>
      </div>

      <div className="tabStrip" data-testid="tab-strip">
        <button data-testid="tab-dashboard" className={tab === "dashboard" ? "tab active" : "tab"} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button data-testid="tab-dates" className={tab === "dates" ? "tab active" : "tab"} onClick={() => setTab("dates")}>
          Date Approval
        </button>
        <button data-testid="tab-events" className={tab === "events" ? "tab active" : "tab"} onClick={() => setTab("events")}>
          Event Groups
        </button>
        <button data-testid="tab-settings" className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "dashboard" && (
        <>
          <div className="statsGrid" data-testid="dashboard-stats-grid">
            <StatCard label="Total" value={stats.total} testId="stat-total" />
            <StatCard label="Indexed" value={stats.indexed} testId="stat-indexed" />
            <StatCard label="Date Review" value={stats.dateNeedsReview} testId="stat-date-review" />
            <StatCard label="Date Verified" value={stats.dateVerified} testId="stat-date-verified" />
            <StatCard label="Grouped" value={stats.grouped} testId="stat-grouped" />
            <StatCard label="Filed" value={stats.filed} testId="stat-filed" />
            <StatCard label="Errors" value={stats.errors} danger={stats.errors > 0} testId="stat-errors" />
          </div>

          <div className="card" data-testid="dashboard-pipeline-card">
            <h3>Run Pipeline</h3>
            <div className="row">
              <button
                data-testid="pipeline-index"
                className={pipelineButtonClass(pipelineStages.index)}
                disabled={busyAction !== null}
                onClick={onStart}
              >
                {busyAction === "ingest" ? "Indexing..." : "1) Index Media"}
              </button>
              <button
                data-testid="pipeline-date-enforcement"
                className={pipelineButtonClass(pipelineStages.date)}
                disabled={busyAction !== null}
                onClick={() => setTab("dates")}
              >
                {datePhaseLabel}
              </button>
              <button
                data-testid="pipeline-group"
                className={pipelineButtonClass(pipelineStages.group)}
                disabled={busyAction !== null || stats.dateNeedsReview > 0}
                onClick={onRunGrouping}
              >
                {busyAction === "group" ? "Grouping..." : "3) Group"}
              </button>
              <button
                data-testid="pipeline-finalize"
                className={pipelineButtonClass(pipelineStages.finalize)}
                disabled={busyAction !== null || stats.dateNeedsReview > 0}
                onClick={onFinalize}
              >
                {busyAction === "finalize" ? "Finalizing..." : "4) Finalize"}
              </button>
              <button
                data-testid="pipeline-reset-session"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={() => setShowResetPrompt(true)}
              >
                {busyAction === "reset" ? "Resetting..." : "Reset Session"}
              </button>
            </div>
            <div className="muted" data-testid="pipeline-phase-help">
              Index Media now performs scanning, metadata extraction, and missing-date detection before grouping.
            </div>
          </div>
        </>
      )}

      {tab === "dates" && (
        <div className="card" data-testid="date-approval-card">
          <h3>Date Metadata Approval</h3>
          <div className="grid">
            {dateItems.map((item) => (
              <DateCard
                key={item.mediaItemId}
                item={item}
                onApply={async (date) => {
                  try {
                    await applyDateApproval(item.mediaItemId, date);
                    await refreshAll();
                    setMessage(
                      date
                        ? `Approved date ${date} for ${item.filename}.`
                        : `Skipped date approval for ${item.filename}.`
                    );
                  } catch (err) {
                    setMessage(`Date approval failed for ${item.filename}: ${String(err)}`);
                    throw err;
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "events" && (
        <div className="card" data-testid="event-groups-card">
          {activeGroup ? (
            <EventGroupDetailView
              group={activeGroup}
              groups={groups}
              items={activeGroupItems}
              selectedItemIds={selectedItemIds}
              setSelectedItemIds={setSelectedItemIds}
              lastSelectedIndex={lastSelectedIndex}
              setLastSelectedIndex={setLastSelectedIndex}
              onBack={() => setActiveGroupId(null)}
              onOpenPreview={(item) => setPreviewItem(item)}
              onMoveSelected={openMoveDialog}
            />
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Event Group Review</h3>
                <button
                  data-testid="event-add-group-button"
                  className="primaryBtn"
                  disabled={busyAction !== null}
                  onClick={() => setShowAddGroupForm((prev) => !prev)}
                >
                  Add Group
                </button>
              </div>
              {showAddGroupForm && (
                <div className="item" data-testid="event-add-group-form">
                  <div className="row">
                    <label className="fieldLabel" htmlFor="event-add-group-name">New Group Name</label>
                    <input
                      id="event-add-group-name"
                      data-testid="event-add-group-input"
                      value={newGroupName}
                      onChange={(e) => {
                        const next = e.target.value;
                        setNewGroupName(next);
                        const normalized = normalizeName(next);
                        if (!normalized) {
                          setNewGroupError("Group name is required");
                        } else if (normalizedGroupNames.has(normalized)) {
                          setNewGroupError("A group with this name already exists");
                        } else {
                          setNewGroupError("");
                        }
                      }}
                    />
                    <button
                      data-testid="event-add-group-save"
                      disabled={busyAction !== null || newGroupError.length > 0 || normalizeName(newGroupName).length === 0}
                      onClick={() => {
                        void onCreateGroup();
                      }}
                    >
                      Save
                    </button>
                  </div>
                  {newGroupError ? (
                    <div className="danger" data-testid="event-add-group-error">{newGroupError}</div>
                  ) : null}
                </div>
              )}
              <div className="grid">
                {groups.map((group) => (
                  <EventCard
                    key={group.id}
                    group={group}
                    allGroupNames={groups.map((entry) => entry.name)}
                    onOpen={() => setActiveGroupId(group.id)}
                    onRename={async (name) => {
                      await renameEventGroup(group.id, name);
                      await refreshAll();
                    }}
                    onDelete={group.itemCount === 0 ? async () => onDeleteGroup(group) : undefined}
                    busy={busyAction !== null}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div className="card" data-testid="settings-card">
          <h3>Settings</h3>
          <h4 className="settingsSectionTitle" data-testid="settings-section-tool-health">Dependency Health</h4>
          <div className="item" data-testid="settings-tool-health-card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Runtime Dependencies</strong>
              <button
                data-testid="settings-refresh-tool-health"
                className="secondaryBtn"
                onClick={async () => {
                  try {
                    const health = await getToolHealth();
                    setToolHealth(health);
                    setMessage("Dependency health refreshed.");
                  } catch (err) {
                    setMessage(`Dependency health refresh failed: ${String(err)}`);
                  }
                }}
              >
                Refresh
              </button>
            </div>
            <div className="row">
              <span className={toolHealth?.exiftoolAvailable ? "ok" : "warn"} data-testid="health-exiftool-status">
                ExifTool: {toolHealth?.exiftoolAvailable ? "available" : "missing"}
              </span>
              <span className="muted" data-testid="health-exiftool-path">{toolHealth?.exiftoolPath ?? "(path not resolved)"}</span>
            </div>
            <div className="row">
              <span className={toolHealth?.ffmpegAvailable ? "ok" : "warn"} data-testid="health-ffmpeg-status">
                FFmpeg: {toolHealth?.ffmpegAvailable ? "available" : "missing"}
              </span>
              <span className="muted" data-testid="health-ffmpeg-path">{toolHealth?.ffmpegPath ?? "(path not resolved)"}</span>
            </div>
          </div>

          <h4 className="settingsSectionTitle" data-testid="settings-section-directories">Directories</h4>
          <div className="row settingsDirectoriesRow">
            <div className="settingsField">
              <label className="fieldLabel" htmlFor="settings-working-directory">Working Directory</label>
              <input
                id="settings-working-directory"
                data-testid="settings-working-directory"
                style={{ minWidth: 320 }}
                placeholder="C:\\Memoria\\inbox"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectoryState(e.target.value)}
              />
            </div>
            <div className="settingsField">
              <label className="fieldLabel" htmlFor="settings-output-directory">Output Directory</label>
              <input
                id="settings-output-directory"
                data-testid="settings-output-directory"
                style={{ minWidth: 320 }}
                placeholder="C:\\Memoria"
                value={outputDirectory}
                onChange={(e) => setOutputDirectoryState(e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <button
              data-testid="settings-save-directories"
              className="primaryBtn"
              onClick={async () => {
                try {
                  await setWorkingDirectory(workingDirectory);
                  await setOutputDirectory(outputDirectory);
                  setMessage("Working and output directories saved.");
                } catch (err) {
                  setMessage(`Saving directories failed: ${String(err)}`);
                }
              }}
            >
              Save Directories
            </button>
          </div>

          <h4 className="settingsSectionTitle" data-testid="settings-section-api-keys">API Keys</h4>
          <div className="row">
            <label htmlFor="settings-openai-key" className="fieldLabel">OpenAI API Key</label>
            <input
              id="settings-openai-key"
              data-testid="settings-openai-key"
              type="password"
              style={{ minWidth: 420 }}
              placeholder="OpenAI API Key"
              value={openAiKey}
              onChange={(e) => setOpenAiKey(e.target.value)}
            />
            <button
              data-testid="settings-save-openai-key"
              className="secondaryBtn"
              onClick={async () => {
                if (!openAiKey) {
                  setMessage("Enter an OpenAI API key first.");
                  return;
                }
                try {
                  await setOpenAiKey(openAiKey);
                  setMessage("OpenAI API key saved in Windows Credential Manager.");
                } catch (err) {
                  setMessage(`Saving OpenAI key failed: ${String(err)}`);
                }
              }}
            >
              Save OpenAI Key
            </button>
            <label htmlFor="settings-anthropic-key" className="fieldLabel">Anthropic API Key</label>
            <input
              id="settings-anthropic-key"
              data-testid="settings-anthropic-key"
              type="password"
              style={{ minWidth: 420 }}
              placeholder="Anthropic API Key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKeyState(e.target.value)}
            />
            <button
              data-testid="settings-save-anthropic-key"
              className="secondaryBtn"
              onClick={async () => {
                if (!anthropicKey) {
                  setMessage("Enter an Anthropic API key first.");
                  return;
                }
                try {
                  await setAnthropicKey(anthropicKey);
                  setMessage("Anthropic API key saved.");
                } catch (err) {
                  setMessage(`Saving Anthropic key failed: ${String(err)}`);
                }
              }}
            >
              Save Anthropic Key
            </button>
          </div>

          <h4 className="settingsSectionTitle" data-testid="settings-section-ai-models">AI Task Models</h4>
          <div className="row">
            <ModelSelector
              label="Date Estimation"
              testPrefix="date-estimation"
              value={aiModels.dateEstimation}
              onChange={(next) => setAiModels((prev) => ({ ...prev, dateEstimation: next }))}
            />
            <ModelSelector
              label="Event Naming"
              testPrefix="event-naming"
              value={aiModels.eventNaming}
              onChange={(next) => setAiModels((prev) => ({ ...prev, eventNaming: next }))}
            />
            <button
              data-testid="settings-save-ai-models"
              className="secondaryBtn"
              onClick={async () => {
                try {
                  await setAiTaskModel("dateEstimation", aiModels.dateEstimation.provider as "openai" | "anthropic", aiModels.dateEstimation.model);
                  await setAiTaskModel("eventNaming", aiModels.eventNaming.provider as "openai" | "anthropic", aiModels.eventNaming.model);
                  setMessage("AI task models saved.");
                } catch (err) {
                  setMessage(`Saving AI models failed: ${String(err)}`);
                }
              }}
            >
              Save AI Models
            </button>
          </div>
        </div>
      )}

      {showMoveDialog && (
        <div className="lightboxOverlay" data-testid="event-move-overlay" onClick={() => setShowMoveDialog(false)}>
          <div
            className="lightboxCard"
            role="dialog"
            aria-label="Move selected items"
            data-testid="event-move-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Move to Group</h3>
            <div className="row">
              <label>
                <input
                  type="radio"
                  name="move-target"
                  checked={eventMoveMode === "existing"}
                  onChange={() => setEventMoveMode("existing")}
                />
                Existing Group
              </label>
              <label>
                <input
                  type="radio"
                  name="move-target"
                  checked={eventMoveMode === "new"}
                  onChange={() => setEventMoveMode("new")}
                />
                Create New Group
              </label>
            </div>
            {eventMoveMode === "existing" ? (
              <select
                data-testid="event-move-target-select"
                value={eventMoveTargetGroupId ?? ""}
                onChange={(e) => setEventMoveTargetGroupId(Number(e.target.value))}
              >
                <option value="" disabled>Select destination</option>
                {groups
                  .filter((group) => group.id !== activeGroupId)
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.folderName} ({group.itemCount})
                    </option>
                  ))}
              </select>
            ) : (
              <input
                data-testid="event-move-new-group-input"
                placeholder="New group name"
                value={eventMoveNewGroupName}
                onChange={(e) => setEventMoveNewGroupName(e.target.value)}
              />
            )}
            {eventMoveError ? (
              <div className="danger" data-testid="event-move-error">{eventMoveError}</div>
            ) : null}
            <div className="row">
              <button
                data-testid="event-move-confirm"
                className="primaryBtn"
                disabled={busyAction !== null}
                onClick={() => {
                  void onMoveSelectedItems();
                }}
              >
                {busyAction === "move-group-items" ? "Moving..." : "Move"}
              </button>
              <button data-testid="event-move-cancel" className="secondaryBtn" onClick={() => setShowMoveDialog(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {previewItem && (
        <div className="lightboxOverlay" data-testid="event-preview-overlay" onClick={() => setPreviewItem(null)}>
          <div className="lightboxCard" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{previewItem.filename}</strong>
              <button className="secondaryBtn" data-testid="event-preview-close" onClick={() => setPreviewItem(null)}>
                Close
              </button>
            </div>
            {previewSrc ? (
              previewItem.mimeType.startsWith("video/") ? (
                <video data-testid="event-preview-video" controls className="eventPreviewAsset" src={previewSrc} />
              ) : (
                <img data-testid="event-preview-image" className="eventPreviewAsset" src={previewSrc} alt={previewItem.filename} />
              )
            ) : (
              <div className="muted">Loading preview...</div>
            )}
          </div>
        </div>
      )}

      {showResetPrompt && (
        <div className="lightboxOverlay" data-testid="reset-session-overlay" onClick={() => setShowResetPrompt(false)}>
          <div className="lightboxCard" role="dialog" aria-label="Reset session confirmation" data-testid="reset-session-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Reset Session?</h3>
            <p className="muted">This clears pipeline data and keeps your configuration settings.</p>
            <p className="muted">Choose whether to also delete generated files in output folders (`staging`, `organized`, `recycle`).</p>
            <div className="row">
              <button data-testid="reset-session-delete-files" className="primaryBtn" disabled={busyAction !== null} onClick={() => void onResetSession(true)}>
                Reset and Delete Files
              </button>
              <button data-testid="reset-session-keep-files" className="secondaryBtn" disabled={busyAction !== null} onClick={() => void onResetSession(false)}>
                Reset App State Only
              </button>
              <button data-testid="reset-session-cancel" className="secondaryBtn" disabled={busyAction !== null} onClick={() => setShowResetPrompt(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pipelineButtonClass(state: PipelineStageState): string {
  switch (state) {
    case "running":
      return "stageBtn stageBtnRunning";
    case "completed":
      return "stageBtn stageBtnCompleted";
    case "failed":
      return "stageBtn stageBtnFailed";
    default:
      return "stageBtn stageBtnIdle";
  }
}

function StatCard({ label, value, danger, testId }: { label: string; value: number; danger?: boolean; testId?: string }) {
  return (
    <div className="card statCard" data-testid={testId}>
      <div className="muted">{label}</div>
      <div className={danger ? "statValue danger" : "statValue"}>{value}</div>
    </div>
  );
}

function DateCard({ item, onApply }: { item: DateEstimate; onApply: (date: string | null) => Promise<void> }) {
  const [value, setValue] = useState(item.aiDate ?? "");
  const [thumbSrc, setThumbSrc] = useState<string>("");
  const [busyAction, setBusyAction] = useState<"approve" | "skip" | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDateMediaThumbnail(item.mediaItemId)
      .then((src) => {
        if (!cancelled && src) {
          setThumbSrc(src);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbSrc("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item.mediaItemId]);

  async function handleApply(nextDate: string | null, action: "approve" | "skip") {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await onApply(nextDate);
    } catch {
      // Parent updates user-facing error state.
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="item" data-testid={`date-item-${item.mediaItemId}`}>
      <img
        className="dateThumb"
        data-testid={`date-thumb-${item.mediaItemId}`}
        src={thumbSrc || getDateThumbFallbackDataUrl(item.filename)}
        alt={item.filename}
        onError={(e) => {
          const img = e.currentTarget;
          const fallback = getDateThumbFallbackDataUrl(item.filename);
          if (img.src !== fallback) {
            img.src = fallback;
          }
        }}
      />
      <strong>{item.filename}</strong>
      <div className="muted">Current: {item.currentDate ?? "(missing)"}</div>
      <div className="muted">AI: {item.aiDate ?? "(none)"} ({Math.round(item.confidence * 100)}%)</div>
      <div className="muted">{item.reasoning}</div>
      <div className="row">
        <input type="date" data-testid={`date-input-${item.mediaItemId}`} value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          data-testid={`date-approve-${item.mediaItemId}`}
          disabled={busyAction !== null}
          onClick={() => {
            void handleApply(value || null, "approve");
          }}
        >
          {busyAction === "approve" ? "Approving..." : "Approve/Edit"}
        </button>
        <button
          data-testid={`date-skip-${item.mediaItemId}`}
          disabled={busyAction !== null}
          onClick={() => {
            void handleApply(null, "skip");
          }}
        >
          {busyAction === "skip" ? "Skipping..." : "Skip"}
        </button>
      </div>
    </div>
  );
}

function getDateThumbFallbackDataUrl(filename: string): string {
  const label = escapeSvgText(filename.split(".").pop()?.toUpperCase() ?? "FILE");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#f3f4f6"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#6b7280" font-family="Segoe UI, Arial, sans-serif" font-size="32">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string): string {
  return value.replace(/[<>&'"]/g, "_");
}

function EventCard({
  group,
  allGroupNames,
  onOpen,
  onRename,
  onDelete,
  busy
}: {
  group: EventGroup;
  allGroupNames: string[];
  onOpen: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  busy: boolean;
}) {
  const [value, setValue] = useState(group.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setValue(group.name);
  }, [group.name]);
  const normalizedCurrent = normalizeName(value);
  const duplicate = allGroupNames.some(
    (name) => normalizeName(name) === normalizedCurrent && normalizeName(name) !== normalizeName(group.name)
  );
  return (
    <div className="item eventGroupCard" data-testid={`event-group-${group.id}`}>
      <button
        className="eventGroupOpenButton"
        data-testid={`event-open-${group.id}`}
        onClick={onOpen}
      >
        <strong>{group.folderName}</strong>
      </button>
      <div className="muted">{group.itemCount} items</div>
      <div className="row">
        <input
          data-testid={`event-rename-input-${group.id}`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
        />
        <button
          data-testid={`event-rename-save-${group.id}`}
          disabled={busy || saving || duplicate || normalizeName(value).length === 0}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await onRename(value.trim());
            } catch (err) {
              setError(String(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving..." : "Rename"}
        </button>
      </div>
      {duplicate ? (
        <div className="danger" data-testid={`event-rename-error-${group.id}`}>A group with this name already exists</div>
      ) : null}
      {error ? <div className="danger">{error}</div> : null}
      {onDelete ? (
        <div className="row">
          <button
            data-testid={`event-delete-${group.id}`}
            className="secondaryBtn"
            disabled={busy}
            onClick={() => {
              void onDelete();
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EventGroupDetailView({
  group,
  groups,
  items,
  selectedItemIds,
  setSelectedItemIds,
  lastSelectedIndex,
  setLastSelectedIndex,
  onBack,
  onOpenPreview,
  onMoveSelected
}: {
  group: EventGroup;
  groups: EventGroup[];
  items: EventGroupItem[];
  selectedItemIds: number[];
  setSelectedItemIds: (next: number[] | ((prev: number[]) => number[])) => void;
  lastSelectedIndex: number | null;
  setLastSelectedIndex: (next: number | null) => void;
  onBack: () => void;
  onOpenPreview: (item: EventGroupItem) => void;
  onMoveSelected: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columns = 4;
  const rowHeight = 260;
  const rows = Math.ceil(items.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 5
  });
  const selected = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const selectableGroups = groups.filter((entry) => entry.id !== group.id);

  function toggleSelection(index: number, shiftKey: boolean) {
    const item = items[index];
    if (!item) return;
    if (shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = items.slice(start, end + 1).map((entry) => entry.id);
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        for (const id of rangeIds) {
          next.add(id);
        }
        return Array.from(next);
      });
    } else {
      setSelectedItemIds((prev) =>
        prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
      );
      setLastSelectedIndex(index);
    }
  }

  return (
    <div data-testid="event-group-detail-view">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <button data-testid="event-detail-back" className="secondaryBtn" onClick={onBack}>
            Back to Event Group Review
          </button>
          <h3 style={{ margin: "8px 0 0" }}>{group.folderName}</h3>
        </div>
        <div className="row">
          <button
            data-testid="event-select-all"
            className="secondaryBtn"
            onClick={() => setSelectedItemIds(items.map((item) => item.id))}
          >
            Select All
          </button>
          <button
            data-testid="event-deselect-all"
            className="secondaryBtn"
            onClick={() => setSelectedItemIds([])}
          >
            Deselect All
          </button>
        </div>
      </div>
      {selectedItemIds.length > 0 && (
        <div className="item eventSelectionToolbar" data-testid="event-selection-toolbar">
          <strong>{selectedItemIds.length} selected</strong>
          <button
            data-testid="event-move-selected"
            className="primaryBtn"
            onClick={onMoveSelected}
          >
            Move to Group
          </button>
        </div>
      )}
      <div className="eventVirtualGridViewport" ref={scrollRef} data-testid="event-virtual-grid">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const startIndex = virtualRow.index * columns;
            const rowItems = items.slice(startIndex, startIndex + columns);
            return (
              <div
                key={virtualRow.key}
                className="eventVirtualRow"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {rowItems.map((item, offset) => {
                  const index = startIndex + offset;
                  const isSelected = selected.has(item.id);
                  return (
                    <EventThumbCard
                      key={item.id}
                      item={item}
                      selected={isSelected}
                      onToggle={(shiftKey) => toggleSelection(index, shiftKey)}
                      onOpenPreview={() => onOpenPreview(item)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EventThumbCard({
  item,
  selected,
  onToggle,
  onOpenPreview
}: {
  item: EventGroupItem;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenPreview: () => void;
}) {
  const [thumbSrc, setThumbSrc] = useState("");
  useEffect(() => {
    let cancelled = false;
    getDateMediaThumbnail(item.id)
      .then((src) => {
        if (!cancelled && src) {
          setThumbSrc(src);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbSrc(getDateThumbFallbackDataUrl(item.filename));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.filename]);

  return (
    <div className={selected ? "eventThumbCard selected" : "eventThumbCard"} data-testid={`event-media-item-${item.id}`}>
      <button
        className="eventThumbSelectButton"
        data-testid={`event-media-select-${item.id}`}
        onClick={(event) => onToggle(event.shiftKey)}
      >
        {selected ? "Selected" : "Select"}
      </button>
      <button
        className="eventThumbPreviewButton"
        data-testid={`event-media-preview-${item.id}`}
        onClick={onOpenPreview}
      >
        <img className="eventThumbImage" src={thumbSrc || getDateThumbFallbackDataUrl(item.filename)} alt={item.filename} />
      </button>
      <div className="eventThumbMeta">
        <strong>{item.filename}</strong>
        <div className="muted">{item.dateTaken ?? "(missing date)"}</div>
      </div>
      {selected ? <div className="eventThumbCheckmark">✓</div> : null}
    </div>
  );
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function ModelSelector({
  label,
  testPrefix,
  value,
  onChange
}: {
  label: string;
  testPrefix: string;
  value: { provider: string; model: string };
  onChange: (value: { provider: string; model: string }) => void;
}) {
  const providerId = `${testPrefix}-provider`;
  const modelId = `${testPrefix}-model`;
  return (
    <div className="row" style={{ alignItems: "center", gap: 6 }} data-testid={`model-selector-${testPrefix}`}>
      <label className="muted" htmlFor={providerId}>{label}</label>
      <select
        id={providerId}
        data-testid={`model-provider-${testPrefix}`}
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value })}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input
        id={modelId}
        data-testid={`model-name-${testPrefix}`}
        style={{ minWidth: 180 }}
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="Model name"
      />
    </div>
  );
}

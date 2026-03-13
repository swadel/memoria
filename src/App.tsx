import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  applyDateApproval,
  completeVideoReviewAndRunGrouping,
  createEventGroup,
  createEventGroupAndMove,
  deleteEventGroup,
  excludeVideos,
  finalizeOrganization,
  getAppConfiguration,
  getDashboardStats,
  getDateMediaThumbnail,
  getDateReviewQueue,
  getEventGroupItems,
  getEventGroupMediaPreview,
  getEventGroups,
  getToolHealth,
  getVideoReviewItems,
  initializeApp,
  moveEventGroupItems,
  renameEventGroup,
  runEventGrouping,
  restoreVideos,
  setAiTaskModel,
  setAnthropicKey,
  setOpenAiKey,
  setOutputDirectory,
  setWorkingDirectory,
  startDownloadSession,
  resetSession,
  type ToolHealth
} from "./lib/api";
import {
  CARD_BUTTON_HEIGHT,
  CARD_GAP,
  CARD_LABEL_HEIGHT,
  CARD_PADDING,
  ITEM_HEIGHT,
  MIN_ITEM_WIDTH,
  THUMBNAIL_SIZE,
  calculateColumnCount,
  calculateEmptySlotsInRow,
  calculateRowCount
} from "./lib/responsiveGrid";
import type { DashboardStats, DateEstimate, EventGroup, EventGroupItem, VideoReviewItem } from "./types";

type Tab = "dashboard" | "dates" | "videos" | "events" | "settings";
type PipelineStage = "index" | "date" | "video" | "group" | "finalize";
type PipelineStageState = "idle" | "running" | "completed" | "failed";

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  downloading: 0,
  indexed: 0,
  dateNeedsReview: 0,
  dateVerified: 0,
  grouped: 0,
  filed: 0,
  errors: 0,
  videoTotal: 0,
  videoFlagged: 0,
  videoExcluded: 0,
  videoUnreviewedFlagged: 0,
  videoPhaseState: "pending"
};

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_REFRESH_INTERVAL_MS ?? "3000");
const DISABLE_UI_POLLING = import.meta.env.VITE_E2E_DISABLE_POLLING === "1";

function derivePipelineStages(stats: DashboardStats): Record<PipelineStage, PipelineStageState> {
  const dateCompleted =
    stats.total > 0 && stats.dateNeedsReview === 0 && (stats.dateVerified > 0 || stats.videoTotal > 0 || stats.grouped > 0 || stats.filed > 0);
  const videoCompleted = stats.videoPhaseState === "complete" || (stats.videoTotal === 0 && dateCompleted);
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
    video:
      !dateCompleted
        ? "idle"
        : videoCompleted
          ? "completed"
          : stats.videoTotal > 0
            ? "running"
            : "idle",
    group: stats.grouped > 0 || stats.filed > 0 ? "completed" : videoCompleted ? "idle" : "idle",
    finalize: stats.filed > 0 ? "completed" : "idle"
  };
}

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [dateItems, setDateItems] = useState<DateEstimate[]>([]);
  const [groups, setGroups] = useState<EventGroup[]>([]);
  const [videoItems, setVideoItems] = useState<VideoReviewItem[]>([]);
  const [showExcludedVideos, setShowExcludedVideos] = useState(false);
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
    const [nextStats, nextDateItems, nextGroups, nextVideoItems] = await Promise.all([
      getDashboardStats(),
      getDateReviewQueue(),
      getEventGroups(),
      getVideoReviewItems(showExcludedVideos)
    ]);
    setStats(nextStats);
    setDateItems(nextDateItems);
    setGroups(nextGroups);
    setVideoItems(nextVideoItems);
    setPipelineStages((prev) => {
      const derived = derivePipelineStages(nextStats);
      return {
        index: prev.index === "failed" ? "failed" : derived.index,
        date: prev.date === "failed" ? "failed" : derived.date,
        video: prev.video === "failed" ? "failed" : derived.video,
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

  useEffect(() => {
    refreshAll().catch(() => undefined);
  }, [showExcludedVideos]);

  async function onStart() {
    setBusyAction("ingest");
    setPipelineStages((prev) => ({ ...prev, index: "running", date: "idle", video: "idle", group: "idle", finalize: "idle" }));
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
        <button
          data-testid="tab-videos"
          className={tab === "videos" ? "tab active" : "tab"}
          onClick={() => setTab("videos")}
          disabled={stats.videoPhaseState === "pending" && stats.dateNeedsReview > 0}
        >
          Video Review {stats.videoUnreviewedFlagged > 0 ? `(${stats.videoUnreviewedFlagged})` : ""}
        </button>
        <button
          data-testid="tab-events"
          className={tab === "events" ? "tab active" : "tab"}
          onClick={() => setTab("events")}
          disabled={stats.videoTotal > 0 && stats.videoPhaseState !== "complete"}
        >
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
                data-testid="pipeline-video-review"
                className={pipelineButtonClass(pipelineStages.video)}
                disabled={busyAction !== null || stats.dateNeedsReview > 0}
                onClick={() => setTab("videos")}
              >
                3) Video Review ({stats.videoTotal} total, {stats.videoFlagged} flagged)
              </button>
              <button
                data-testid="pipeline-group"
                className={pipelineButtonClass(pipelineStages.group)}
                disabled={busyAction !== null || stats.dateNeedsReview > 0 || (stats.videoTotal > 0 && stats.videoPhaseState !== "complete")}
                onClick={onRunGrouping}
              >
                {busyAction === "group" ? "Grouping..." : "4) Group"}
              </button>
              <button
                data-testid="pipeline-finalize"
                className={pipelineButtonClass(pipelineStages.finalize)}
                disabled={busyAction !== null || stats.dateNeedsReview > 0 || (stats.videoTotal > 0 && stats.videoPhaseState !== "complete")}
                onClick={onFinalize}
              >
                {busyAction === "finalize" ? "Finalizing..." : "5) Finalize"}
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
          <div className="card" data-testid="dashboard-video-review-tile">
            <h3 style={{ marginTop: 0 }}>Video Review</h3>
            <div className="muted" data-testid="dashboard-video-review-status">Status: {stats.videoPhaseState}</div>
            <div className="row">
              <div data-testid="dashboard-video-total">Total: {stats.videoTotal}</div>
              <div data-testid="dashboard-video-flagged">Flagged: {stats.videoFlagged}</div>
              <div data-testid="dashboard-video-excluded">Excluded: {stats.videoExcluded}</div>
            </div>
            <button
              data-testid="dashboard-review-videos"
              className="primaryBtn"
              disabled={stats.videoPhaseState === "pending" && stats.dateNeedsReview > 0}
              onClick={() => setTab("videos")}
            >
              Review Videos
            </button>
          </div>
        </>
      )}

      {tab === "dates" && (
        <div className="card" data-testid="date-approval-card">
          <h3>Date Metadata Approval</h3>
          <div className="dateApprovalGrid">
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

      {tab === "videos" && (
        <div className="card" data-testid="video-review-card">
          <VideoReviewView
            items={videoItems}
            excludedCount={stats.videoExcluded}
            showExcluded={showExcludedVideos}
            onToggleShowExcluded={(next) => setShowExcludedVideos(next)}
            onRefresh={refreshAll}
            onBusy={(busy) => setBusyAction(busy ? "video-review" : null)}
            onMessage={setMessage}
            onProceed={async () => {
              await completeVideoReviewAndRunGrouping();
              await refreshAll();
              setTab("events");
              setMessage("Video review complete. Event grouping started.");
            }}
          />
        </div>
      )}

      {tab === "events" && (
        <div className="card" data-testid="event-groups-card">
          {activeGroup ? (
            <EventGroupDetailView
              group={activeGroup}
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
              <div className="eventGroupsGrid" data-testid="event-groups-review-grid">
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
                className="responsiveInput"
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
                className="responsiveInput"
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
              className="responsiveInput"
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
              className="responsiveInput"
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
    <div className="item dateItemCard" data-testid={`date-item-${item.mediaItemId}`}>
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
      <strong className="truncateOneLine">{item.filename}</strong>
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
  items: EventGroupItem[];
  selectedItemIds: number[];
  setSelectedItemIds: (next: number[] | ((prev: number[]) => number[])) => void;
  lastSelectedIndex: number | null;
  setLastSelectedIndex: (next: number | null) => void;
  onBack: () => void;
  onOpenPreview: (item: EventGroupItem) => void;
  onMoveSelected: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [scrollHeight, setScrollHeight] = useState(500);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const cols = calculateColumnCount(width, MIN_ITEM_WIDTH);
        setColumnCount(cols);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateHeight = () => {
      if (scrollWrapperRef.current) {
        const rect = scrollWrapperRef.current.getBoundingClientRect();
        setScrollHeight(Math.max(240, window.innerHeight - rect.top - 16));
      }
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const rowCount = calculateRowCount(items.length, columnCount);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 3
  });
  const selected = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);

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
      <div ref={scrollWrapperRef} style={{ flex: 1 }}>
        <div
          className="eventVirtualGridViewport"
          ref={containerRef}
          data-testid="event-virtual-grid"
          data-column-count={columnCount}
          data-row-count={rowCount}
          data-scroll-height={scrollHeight}
          style={{
            height: `${scrollHeight}px`,
            overflow: "auto",
            position: "relative"
          }}
        >
          <div
            data-testid="event-virtual-grid-inner"
            data-total-size={rowVirtualizer.getTotalSize()}
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%"
            }}
          >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const startIndex = virtualRow.index * columnCount;
            const rowItems = items.slice(startIndex, startIndex + columnCount);
            const emptySlotCount = calculateEmptySlotsInRow(rowItems.length, columnCount);
            return (
              <div
                key={virtualRow.key}
                data-testid={`event-virtual-row-${virtualRow.index}`}
                data-index={virtualRow.index}
                data-measure-element="true"
                className="eventVirtualRow"
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: virtualRow.start,
                  left: 0,
                  right: 0,
                  height: `${virtualRow.size}px`,
                  display: "flex",
                  gap: "8px",
                  padding: "0 8px",
                  boxSizing: "border-box"
                }}
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
                      style={{ flex: "1 1 0", minWidth: 0 }}
                    />
                  );
                })}
                {emptySlotCount > 0
                  ? Array.from({ length: emptySlotCount }).map((_, index) => (
                      <div
                        key={`empty-${virtualRow.index}-${index}`}
                        data-testid="event-empty-slot"
                        style={{ flex: "1 1 0", minWidth: 0 }}
                      />
                    ))
                  : null}
              </div>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
}

function EventThumbCard({
  item,
  selected,
  onToggle,
  onOpenPreview,
  style
}: {
  item: EventGroupItem;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenPreview: () => void;
  style?: CSSProperties;
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
    <div
      className={selected ? "eventThumbCard selected" : "eventThumbCard"}
      data-testid={`event-media-item-${item.id}`}
      data-thumbnail-card
      style={{
        ...style,
        minHeight: ITEM_HEIGHT - CARD_GAP,
        display: "flex",
        flexDirection: "column",
        overflow: "visible"
      }}
    >
      <button
        className="eventThumbPreviewButton"
        data-testid={`event-media-preview-${item.id}`}
        onClick={onOpenPreview}
      >
        <img
          className="eventThumbImage"
          src={thumbSrc || getDateThumbFallbackDataUrl(item.filename)}
          alt={item.filename}
          style={{
            width: "100%",
            height: THUMBNAIL_SIZE,
            objectFit: "cover",
            flexShrink: 0
          }}
        />
      </button>
      <div className="eventThumbMeta" style={{ padding: "6px 8px", flexShrink: 0, minHeight: CARD_LABEL_HEIGHT }}>
        <strong
          className="truncateOneLine"
          style={{ fontSize: 12, fontWeight: 500 }}
        >
          {item.filename}
        </strong>
        <div className="muted truncateOneLine" style={{ fontSize: 11 }}>
          {item.dateTaken ?? "(missing date)"}
        </div>
      </div>
      <div
        style={{
          padding: `0 8px ${CARD_PADDING - 12}px`,
          marginTop: "auto",
          flexShrink: 0
        }}
      >
        <button
          className="eventThumbSelectButton"
          data-testid={`event-media-select-${item.id}`}
          onClick={(event) => onToggle(event.shiftKey)}
          style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT }}
        >
          {selected ? "Selected" : "Select"}
        </button>
      </div>
      {selected ? <div className="eventThumbCheckmark">✓</div> : null}
    </div>
  );
}

function VideoReviewView({
  items,
  excludedCount,
  showExcluded,
  onToggleShowExcluded,
  onRefresh,
  onBusy,
  onMessage,
  onProceed
}: {
  items: VideoReviewItem[];
  excludedCount: number;
  showExcluded: boolean;
  onToggleShowExcluded: (next: boolean) => void;
  onRefresh: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onMessage: (message: string) => void;
  onProceed: () => Promise<void>;
}) {
  const [sizeThresholdMb, setSizeThresholdMb] = useState(5);
  const [durationThresholdSecs, setDurationThresholdSecs] = useState(10);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [previewById, setPreviewById] = useState<Record<number, string>>({});
  const [inlinePlayingId, setInlinePlayingId] = useState<number | null>(null);
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [scrollHeight, setScrollHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const underSize = item.fileSizeBytes <= sizeThresholdMb * 1024 * 1024;
        const underDuration = item.durationSecs <= durationThresholdSecs;
        return underSize || underDuration;
      }),
    [items, sizeThresholdMb, durationThresholdSecs]
  );

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => filtered.some((item) => item.id === id)));
  }, [filtered]);

  useEffect(() => {
    const pending = filtered
      .filter((item) => !thumbs[item.id])
      .slice(0, 12)
      .map((item) =>
        getDateMediaThumbnail(item.id)
          .then((src) => ({ id: item.id, src: src ?? "" }))
          .catch(() => ({ id: item.id, src: "" }))
      );
    if (pending.length === 0) return;
    Promise.all(pending).then((entries) => {
      setThumbs((prev) => {
        const next = { ...prev };
        for (const entry of entries) next[entry.id] = entry.src;
        return next;
      });
    });
  }, [filtered, thumbs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setColumnCount(calculateColumnCount(entry.contentRect.width, MIN_ITEM_WIDTH));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateHeight = () => {
      if (scrollWrapperRef.current) {
        const rect = scrollWrapperRef.current.getBoundingClientRect();
        setScrollHeight(Math.max(280, window.innerHeight - rect.top - 18));
      }
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const rowCount = calculateRowCount(filtered.length, columnCount);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ITEM_HEIGHT + 20,
    overscan: 3
  });

  const modalItems = filtered;
  const modalItem = modalIndex === null ? null : modalItems[modalIndex] ?? null;

  useEffect(() => {
    if (modalIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModalIndex(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalIndex]);

  async function ensurePreview(id: number) {
    if (previewById[id]) return previewById[id];
    const src = (await getEventGroupMediaPreview(id)) ?? "";
    setPreviewById((prev) => ({ ...prev, [id]: src }));
    return src;
  }

  async function handleOpen(item: VideoReviewItem, index: number) {
    await ensurePreview(item.id);
    if (item.durationSecs < 10) {
      setInlinePlayingId(item.id);
      return;
    }
    setModalIndex(index);
  }

  async function handleExclude(ids: number[]) {
    if (ids.length === 0) return;
    onBusy(true);
    try {
      const moved = await excludeVideos(ids);
      await onRefresh();
      setSelectedIds([]);
      onMessage(`${moved} video(s) moved to recycle`);
    } catch (err) {
      onMessage(`Exclude failed: ${String(err)}`);
    } finally {
      onBusy(false);
    }
  }

  async function handleRestore(ids: number[]) {
    if (ids.length === 0) return;
    onBusy(true);
    try {
      const moved = await restoreVideos(ids);
      await onRefresh();
      setSelectedIds([]);
      onMessage(`${moved} video(s) restored`);
    } catch (err) {
      onMessage(`Restore failed: ${String(err)}`);
    } finally {
      onBusy(false);
    }
  }

  return (
    <div data-testid="video-review-view">
      <h3 style={{ marginTop: 0 }}>Video Review</h3>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="row">
          <button data-testid="video-show-active" className={showExcluded ? "secondaryBtn" : "primaryBtn"} onClick={() => onToggleShowExcluded(false)}>
            Show active
          </button>
          <button data-testid="video-show-excluded" className={showExcluded ? "primaryBtn" : "secondaryBtn"} onClick={() => onToggleShowExcluded(true)}>
            Show excluded
          </button>
        </div>
        <div data-testid="video-filter-summary" className="muted">Showing {filtered.length} of {items.length} videos</div>
      </div>

      <div className="item" data-testid="video-filter-bar">
        <label htmlFor="video-size-slider">Show videos under {sizeThresholdMb} MB</label>
        <input
          id="video-size-slider"
          data-testid="video-size-slider"
          type="range"
          min={0}
          max={50}
          value={sizeThresholdMb}
          onChange={(e) => setSizeThresholdMb(Number(e.target.value))}
        />
        <label htmlFor="video-duration-slider">Show videos under {durationThresholdSecs} sec</label>
        <input
          id="video-duration-slider"
          data-testid="video-duration-slider"
          type="range"
          min={0}
          max={120}
          value={durationThresholdSecs}
          onChange={(e) => setDurationThresholdSecs(Number(e.target.value))}
        />
        <div className="row">
          <button data-testid="video-select-all-filtered" className="secondaryBtn" onClick={() => setSelectedIds(filtered.map((item) => item.id))}>
            Select All Filtered
          </button>
          {showExcluded ? (
            <button
              data-testid="video-restore-selected"
              className="primaryBtn"
              disabled={selectedIds.length === 0}
              onClick={() => void handleRestore(selectedIds)}
            >
              Restore Selected
            </button>
          ) : (
            <button
              data-testid="video-exclude-selected"
              className="primaryBtn"
              disabled={selectedIds.length === 0}
              onClick={() => void handleExclude(selectedIds)}
            >
              Exclude Selected
            </button>
          )}
        </div>
      </div>

      <div ref={scrollWrapperRef}>
        <div
          className="eventVirtualGridViewport"
          ref={containerRef}
          data-testid="video-virtual-grid"
          style={{ height: `${scrollHeight}px`, overflow: "auto", position: "relative" }}
        >
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const startIndex = virtualRow.index * columnCount;
              const rowItems = filtered.slice(startIndex, startIndex + columnCount);
              const emptySlotCount = calculateEmptySlotsInRow(rowItems.length, columnCount);
              return (
                <div
                  key={virtualRow.key}
                  style={{ position: "absolute", top: virtualRow.start, left: 0, right: 0, display: "flex", gap: "8px", padding: "0 8px", boxSizing: "border-box" }}
                >
                  {rowItems.map((item, offset) => {
                    const isSelected = selected.has(item.id);
                    const underSize = item.fileSizeBytes <= sizeThresholdMb * 1024 * 1024;
                    const underDuration = item.durationSecs <= durationThresholdSecs;
                    const flagged = underSize || underDuration;
                    const previewSrc = previewById[item.id] ?? "";
                    const thumbSrc = thumbs[item.id] || getDateThumbFallbackDataUrl(item.filename);
                    return (
                      <div
                        key={item.id}
                        className={isSelected ? "eventThumbCard selected" : "eventThumbCard"}
                        data-testid={`video-item-${item.id}`}
                        data-flagged={flagged ? "true" : "false"}
                        style={{ flex: "1 1 0", minWidth: 0, position: "relative", borderColor: flagged ? "#d97706" : undefined, background: flagged ? "#fffbeb" : undefined }}
                      >
                        {inlinePlayingId === item.id && previewSrc ? (
                          <video data-testid={`video-inline-player-${item.id}`} src={previewSrc} autoPlay muted controls style={{ width: "100%", height: THUMBNAIL_SIZE, objectFit: "cover" }} />
                        ) : (
                          <button data-testid={`video-open-${item.id}`} className="eventThumbPreviewButton" onClick={() => void handleOpen(item, startIndex + offset)}>
                            <img className="eventThumbImage" src={thumbSrc} alt={item.filename} style={{ width: "100%", height: THUMBNAIL_SIZE, objectFit: "cover" }} />
                            <span data-testid={`video-play-overlay-${item.id}`} className="eventThumbCheckmark" style={{ top: 10, right: 10 }}>▶</span>
                          </button>
                        )}
                        <div className="eventThumbMeta" style={{ padding: "6px 8px" }}>
                          <strong className="truncateOneLine" style={{ fontSize: 12, fontWeight: 500 }}>{item.filename}</strong>
                          <div className="muted truncateOneLine" style={{ fontSize: 11 }}>{formatFileSize(item.fileSizeBytes)} • {formatDuration(item.durationSecs)}</div>
                        </div>
                        <div style={{ padding: "0 8px 8px" }} className="row">
                          <button
                            data-testid={`video-select-${item.id}`}
                            className="eventThumbSelectButton"
                            onClick={() => setSelectedIds((prev) => prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id])}
                            style={{ width: "100%" }}
                          >
                            {isSelected ? "Selected" : "Select"}
                          </button>
                          {showExcluded ? (
                            <button data-testid={`video-restore-${item.id}`} className="secondaryBtn" onClick={() => void handleRestore([item.id])}>Restore</button>
                          ) : (
                            <button data-testid={`video-exclude-${item.id}`} className="secondaryBtn" onClick={() => void handleExclude([item.id])}>Exclude</button>
                          )}
                        </div>
                        {isSelected ? <div className="eventThumbCheckmark">✓</div> : null}
                      </div>
                    );
                  })}
                  {emptySlotCount > 0 ? Array.from({ length: emptySlotCount }).map((_, index) => <div key={`v-empty-${virtualRow.index}-${index}`} style={{ flex: "1 1 0", minWidth: 0 }} />) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {!showExcluded ? (
        <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <button
            data-testid="video-done-proceed"
            className="primaryBtn"
            onClick={() => {
              const groupedCount = items.length;
              const ok = window.confirm(`${groupedCount} videos will be grouped. ${excludedCount} videos have been excluded. Proceed?`);
              if (!ok) return;
              void onProceed();
            }}
          >
            Done - Proceed to Event Grouping
          </button>
        </div>
      ) : null}

      {modalItem ? (
        <div className="lightboxOverlay" data-testid="video-preview-modal-overlay" onClick={() => setModalIndex(null)}>
          <div className="lightboxCard" data-testid="video-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{modalItem.filename}</strong>
              <button className="secondaryBtn" data-testid="video-preview-close" onClick={() => setModalIndex(null)}>Close</button>
            </div>
            <video
              data-testid="video-preview-player"
              src={previewById[modalItem.id] ?? ""}
              controls
              style={{ width: "100%", maxHeight: "55vh", background: "#000" }}
            />
            <div className="muted" data-testid="video-preview-metadata">
              {formatFileSize(modalItem.fileSizeBytes)} • {formatDuration(modalItem.durationSecs)} • {modalItem.dateTaken ?? "(missing date)"}
            </div>
            <div className="row">
              <button data-testid="video-preview-prev" className="secondaryBtn" disabled={(modalIndex ?? 0) <= 0} onClick={() => setModalIndex((prev) => (prev === null ? prev : Math.max(0, prev - 1)))}>
                Previous
              </button>
              <button data-testid="video-preview-next" className="secondaryBtn" disabled={(modalIndex ?? 0) >= modalItems.length - 1} onClick={() => setModalIndex((prev) => (prev === null ? prev : Math.min(modalItems.length - 1, prev + 1)))}>
                Next
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
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
        className="responsiveInput"
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="Model name"
      />
    </div>
  );
}

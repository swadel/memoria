import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  applyDateApproval,
  confirmDuplicateKeep,
  applyReviewAction,
  finalizeOrganization,
  getAppConfiguration,
  getToolHealth,
  getDashboardStats,
  getDateReviewQueue,
  getEventGroups,
  getReviewQueue,
  initializeApp,
  renameEventGroup,
  runClassification,
  runEventGrouping,
  resetSession,
  setAiTaskModel,
  setAnthropicKey,
  setWorkingDirectory,
  setOpenAiKey,
  setOutputDirectory,
  startDownloadSession,
  type ToolHealth
} from "./lib/api";
import type { DashboardStats, DateEstimate, EventGroup, MediaItem } from "./types";

type Tab = "dashboard" | "review" | "dates" | "events" | "settings";
type PipelineStage = "index" | "classify" | "group" | "finalize";
type PipelineStageState = "idle" | "running" | "completed" | "failed";

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  downloading: 0,
  review: 0,
  legitimate: 0,
  dateNeedsReview: 0,
  grouped: 0,
  filed: 0,
  errors: 0
};

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_REFRESH_INTERVAL_MS ?? "3000");
const DISABLE_UI_POLLING = import.meta.env.VITE_E2E_DISABLE_POLLING === "1";

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [reviewItems, setReviewItems] = useState<MediaItem[]>([]);
  const [dateItems, setDateItems] = useState<DateEstimate[]>([]);
  const [groups, setGroups] = useState<EventGroup[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
  const [message, setMessage] = useState<string>("");

  const [workingDirectory, setWorkingDirectoryState] = useState("C:\\Memoria\\inbox");
  const [outputDirectory, setOutputDirectoryState] = useState("C:\\Memoria");
  const [openAiKey, setOpenAiKey] = useState("");
  const [anthropicKey, setAnthropicKeyState] = useState("");
  const [aiModels, setAiModels] = useState({
    classification: { provider: "openai", model: "gpt-4o-mini" },
    dateEstimation: { provider: "anthropic", model: "claude-sonnet-4-6" },
    eventNaming: { provider: "anthropic", model: "claude-sonnet-4-6" },
    duplicateRanking: { provider: "anthropic", model: "claude-sonnet-4-6" }
  });
  const [reviewReasonFilter, setReviewReasonFilter] = useState<string>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ items: MediaItem[]; index: number } | null>(null);
  const [showResetPrompt, setShowResetPrompt] = useState(false);
  const [toolHealth, setToolHealth] = useState<ToolHealth | null>(null);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [pipelineStages, setPipelineStages] = useState<Record<PipelineStage, PipelineStageState>>({
    index: "idle",
    classify: "idle",
    group: "idle",
    finalize: "idle"
  });

  const selectedCountLabel = useMemo(() => `${selectedReviewIds.length} selected`, [selectedReviewIds]);

  async function refreshAll() {
    const [s, rq, dq, eg] = await Promise.all([
      getDashboardStats(),
      getReviewQueue(),
      getDateReviewQueue(),
      getEventGroups()
    ]);
    setStats(s);
    setReviewItems(rq);
    setDateItems(dq);
    setGroups(eg);
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
          // Use defaults when config has not been written yet.
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
    if (DISABLE_UI_POLLING) {
      return;
    }
    const timer = setInterval(() => {
      refreshAll().catch(() => undefined);
    }, Math.max(POLL_INTERVAL_MS, 500));
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (tab !== "review") return;
      if (e.key.toLowerCase() === "i") {
        void onApplyReview("include");
      }
      if (e.key.toLowerCase() === "d") {
        void onApplyReview("delete");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, selectedReviewIds]);

  useEffect(() => {
    function onEscClose(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setLightbox(null);
        return;
      }
      if (!lightbox) return;
      if (e.key === "ArrowLeft") {
        setLightbox((prev) => {
          if (!prev) return prev;
          const nextIndex = (prev.index - 1 + prev.items.length) % prev.items.length;
          return { ...prev, index: nextIndex };
        });
      }
      if (e.key === "ArrowRight") {
        setLightbox((prev) => {
          if (!prev) return prev;
          const nextIndex = (prev.index + 1) % prev.items.length;
          return { ...prev, index: nextIndex };
        });
      }
    }
    window.addEventListener("keydown", onEscClose);
    return () => window.removeEventListener("keydown", onEscClose);
  }, [lightbox]);

  const lightboxCurrent = lightbox ? lightbox.items[lightbox.index] : null;

  function setStageState(stage: PipelineStage, state: PipelineStageState) {
    setPipelineStages((prev) => ({ ...prev, [stage]: state }));
  }

  function resetDownstreamStages(stage: PipelineStage) {
    setPipelineStages((prev) => {
      if (stage === "index") {
        return { ...prev, classify: "idle", group: "idle", finalize: "idle" };
      }
      if (stage === "classify") {
        return { ...prev, group: "idle", finalize: "idle" };
      }
      if (stage === "group") {
        return { ...prev, finalize: "idle" };
      }
      return prev;
    });
  }

  function openLightbox(items: MediaItem[], selected: MediaItem) {
    const idx = items.findIndex((x) => x.id === selected.id);
    setLightbox({ items, index: idx >= 0 ? idx : 0 });
  }

  function moveLightbox(delta: number) {
    setLightbox((prev) => {
      if (!prev) return prev;
      const nextIndex = (prev.index + delta + prev.items.length) % prev.items.length;
      return { ...prev, index: nextIndex };
    });
  }

  async function onStart() {
    setBusyAction("ingest");
    setStageState("index", "running");
    resetDownstreamStages("index");
    try {
      await setOutputDirectory(outputDirectory);
      await startDownloadSession({ workingDirectory, outputDirectory });
      setMessage("Local media indexed from working directory.");
      await refreshAll();
      setThumbVersion((v) => v + 1);
      setStageState("index", "completed");
    } catch (err) {
      setMessage(`Indexing failed: ${String(err)}`);
      setStageState("index", "failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function onClassify() {
    setBusyAction("classify");
    setStageState("classify", "running");
    resetDownstreamStages("classify");
    try {
      await runClassification();
      setMessage("Classification complete.");
      await refreshAll();
      setThumbVersion((v) => v + 1);
      setStageState("classify", "completed");
    } catch (err) {
      setMessage(`Classification failed: ${String(err)}`);
      setStageState("classify", "failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function onApplyReview(action: "include" | "delete") {
    if (selectedReviewIds.length === 0) return;
    try {
      await applyReviewAction(selectedReviewIds, action);
      setSelectedReviewIds([]);
      setMessage(`Applied '${action}' to ${selectedReviewIds.length} items.`);
      await refreshAll();
      setThumbVersion((v) => v + 1);
    } catch (err) {
      setMessage(`Review action failed: ${String(err)}`);
    }
  }

  async function onConfirmDuplicateKeep() {
    if (selectedReviewIds.length !== 1) {
      setMessage("Select exactly one duplicate candidate to confirm as keep.");
      return;
    }
    const selected = reviewItems.find((x) => x.id === selectedReviewIds[0]);
    if (!selected || !selected.duplicateClusterId) {
      setMessage("Selected item is not in a duplicate cluster.");
      return;
    }
    try {
      await confirmDuplicateKeep(selected.id);
      setSelectedReviewIds([]);
      setMessage(`Confirmed keep for duplicate cluster ${selected.duplicateClusterId}.`);
      await refreshAll();
      setThumbVersion((v) => v + 1);
    } catch (err) {
      setMessage(`Confirm duplicate keep failed: ${String(err)}`);
    }
  }

  async function onRunGrouping() {
    setBusyAction("group");
    setStageState("group", "running");
    resetDownstreamStages("group");
    try {
      await runEventGrouping();
      setMessage("Grouping generated.");
      await refreshAll();
      setThumbVersion((v) => v + 1);
      setStageState("group", "completed");
    } catch (err) {
      setMessage(`Grouping failed: ${String(err)}`);
      setStageState("group", "failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function onFinalize() {
    setBusyAction("finalize");
    setStageState("finalize", "running");
    try {
      await finalizeOrganization();
      setMessage("Organization finalized.");
      await refreshAll();
      setThumbVersion((v) => v + 1);
      setStageState("finalize", "completed");
    } catch (err) {
      setMessage(`Finalize failed: ${String(err)}`);
      setStageState("finalize", "failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function onResetSession(deleteGeneratedFiles: boolean) {
    setBusyAction("reset");
    try {
      const result = await resetSession(deleteGeneratedFiles);
      setSelectedReviewIds([]);
      setReviewReasonFilter("all");
      setLightbox(null);
      setShowResetPrompt(false);
      setPipelineStages({
        index: "idle",
        classify: "idle",
        group: "idle",
        finalize: "idle"
      });
      await refreshAll();
      setThumbVersion((v) => v + 1);
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

  async function onSaveOpenAiKey() {
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
  }

  const filteredReviewItems = useMemo(
    () =>
      reviewItems.filter((item) =>
        reviewReasonFilter === "all" ? true : (item.reviewReason ?? "unknown") === reviewReasonFilter
      ),
    [reviewItems, reviewReasonFilter]
  );

  const reviewReasonCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of reviewItems) {
      const key = item.reviewReason ?? "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [reviewItems]);

  const duplicateClusters = useMemo(() => {
    const grouped: Record<string, MediaItem[]> = {};
    for (const item of filteredReviewItems) {
      if (!item.duplicateClusterId) continue;
      if (
        item.reviewReason !== "duplicate_non_best" &&
        item.reviewReason !== "duplicate_keep_suggestion"
      ) {
        continue;
      }
      grouped[item.duplicateClusterId] = grouped[item.duplicateClusterId] ?? [];
      grouped[item.duplicateClusterId].push(item);
    }
    const entries = Object.entries(grouped).map(([clusterId, items]) => ({
      clusterId,
      items: items.sort((a, b) => {
        const rankA = extractDuplicateRank(a.reviewReasonDetails);
        const rankB = extractDuplicateRank(b.reviewReasonDetails);
        return rankA - rankB;
      })
    }));
    return entries.sort((a, b) => b.items.length - a.items.length);
  }, [filteredReviewItems]);

  const nonDuplicateReviewItems = useMemo(
    () =>
      filteredReviewItems.filter(
        (item) =>
          !item.duplicateClusterId ||
          (item.reviewReason !== "duplicate_non_best" && item.reviewReason !== "duplicate_keep_suggestion")
      ),
    [filteredReviewItems]
  );

  return (
    <div className="layout" data-testid="layout-root">
      <div className="topbar">
        <div>
          <h1 className="title">Memoria</h1>
          <p className="subtitle">Local Media Organizer</p>
        </div>
        <div className="statusPill" data-testid="status-pill">
          {message || "Ready"}
        </div>
      </div>
      <div className="tabStrip" data-testid="tab-strip">
        <button
          data-testid="tab-dashboard"
          className={tab === "dashboard" ? "tab active" : "tab"}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
        <button data-testid="tab-review" className={tab === "review" ? "tab active" : "tab"} onClick={() => setTab("review")}>
          Review Queue
        </button>
        <button data-testid="tab-dates" className={tab === "dates" ? "tab active" : "tab"} onClick={() => setTab("dates")}>
          Date Approval
        </button>
        <button data-testid="tab-events" className={tab === "events" ? "tab active" : "tab"} onClick={() => setTab("events")}>
          Event Groups
        </button>
        <button
          data-testid="tab-settings"
          className={tab === "settings" ? "tab active" : "tab"}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
      </div>

      {tab === "dashboard" && (
        <>
          <div className="statsGrid" data-testid="dashboard-stats-grid">
            <StatCard label="Total" value={stats.total} testId="stat-total" />
            <StatCard label="Review Queue" value={stats.review} testId="stat-review" />
            <StatCard label="Legitimate" value={stats.legitimate} testId="stat-legitimate" />
            <StatCard label="Date Review" value={stats.dateNeedsReview} testId="stat-date-review" />
            <StatCard label="Grouped" value={stats.grouped} testId="stat-grouped" />
            <StatCard label="Filed" value={stats.filed} testId="stat-filed" />
            <StatCard label="Errors" value={stats.errors} danger={stats.errors > 0} testId="stat-errors" />
          </div>

          <div className="card" data-testid="dashboard-pipeline-card">
            <h3>Run Pipeline</h3>
            <div className="row">
              <label className="settingsField" htmlFor="dashboard-working-directory">
                <span className="fieldLabel">Working Directory</span>
              <input
                id="dashboard-working-directory"
                data-testid="dashboard-working-directory"
                className="wideInput"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectoryState(e.target.value)}
                placeholder="Working directory containing your media"
              />
              </label>
              <label className="settingsField" htmlFor="dashboard-output-directory">
                <span className="fieldLabel">Output Directory</span>
              <input
                id="dashboard-output-directory"
                data-testid="dashboard-output-directory"
                className="wideInput"
                value={outputDirectory}
                onChange={(e) => setOutputDirectoryState(e.target.value)}
                placeholder="Output directory for organized/review/recycle/staging"
              />
              </label>
            </div>
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
                data-testid="pipeline-classify"
                className={pipelineButtonClass(pipelineStages.classify)}
                disabled={busyAction !== null}
                onClick={onClassify}
              >
                {busyAction === "classify" ? "Classifying..." : "2) Classify"}
              </button>
              <button
                data-testid="pipeline-group"
                className={pipelineButtonClass(pipelineStages.group)}
                disabled={busyAction !== null}
                onClick={onRunGrouping}
              >
                {busyAction === "group" ? "Grouping..." : "3) Group"}
              </button>
              <button
                data-testid="pipeline-finalize"
                className={pipelineButtonClass(pipelineStages.finalize)}
                disabled={busyAction !== null}
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
            <div className="progressTrack" data-testid="pipeline-progress-track">
              <div
                className="progressFill"
                data-testid="pipeline-progress-fill"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(((stats.filed + stats.grouped + stats.legitimate) / Math.max(stats.total, 1)) * 100)
                  )}%`
                }}
              />
            </div>
            <div className="muted">Pipeline progress timeline updates every 3 seconds.</div>
          </div>
        </>
      )}

      {tab === "review" && (
        <div className="card" data-testid="review-card">
          <h3>Review Queue</h3>
          <div className="row">
            <span className="muted" data-testid="review-selected-count">{selectedCountLabel}</span>
            <label htmlFor="review-reason-filter" className="fieldLabel">Review Reason</label>
            <select
              id="review-reason-filter"
              data-testid="review-reason-filter"
              value={reviewReasonFilter}
              onChange={(e) => setReviewReasonFilter(e.target.value)}
            >
              <option value="all">All reasons</option>
              {Object.entries(reviewReasonCounts).map(([reason, count]) => (
                <option key={reason} value={reason}>
                  {reason} ({count})
                </option>
              ))}
            </select>
            <button data-testid="review-include" className="secondaryBtn" onClick={() => onApplyReview("include")}>
              Include
            </button>
            <button data-testid="review-confirm-duplicate-keep" className="secondaryBtn" onClick={onConfirmDuplicateKeep}>
              Confirm Keep (Duplicate)
            </button>
            <button data-testid="review-delete" className="secondaryBtn" onClick={() => onApplyReview("delete")}>
              Delete (to recycle)
            </button>
          </div>
          <div className="grid" data-testid="review-grid">
            {nonDuplicateReviewItems.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                thumbVersion={thumbVersion}
                selectedReviewIds={selectedReviewIds}
                setSelectedReviewIds={setSelectedReviewIds}
                onOpenPreview={(i) => openLightbox([i], i)}
              />
            ))}
          </div>
          {duplicateClusters.length > 0 && (
            <div style={{ marginTop: 16 }} data-testid="duplicate-clusters">
              <h4 style={{ marginBottom: 8 }}>Duplicate Clusters</h4>
              {duplicateClusters.map((cluster) => (
                <div
                  key={cluster.clusterId}
                  className="item"
                  style={{ marginBottom: 10 }}
                  data-testid={`duplicate-cluster-${cluster.clusterId}`}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Cluster {cluster.clusterId}</strong>
                    <span className="muted">{cluster.items.length} candidates</span>
                  </div>
                  <div className="duplicateClusterGrid">
                    {cluster.items.map((item) => (
                      <div key={item.id} className="duplicateCandidateCard" data-testid={`duplicate-item-${item.id}`}>
                        <img
                          className="thumbPreview"
                          data-testid={`review-thumb-${item.id}`}
                          src={getReviewThumbnailUrl(item, thumbVersion)}
                          alt={item.filename}
                          onClick={() => openLightbox(cluster.items, item)}
                          onError={(e) => {
                            const img = e.currentTarget as HTMLImageElement;
                            const step = Number(img.dataset.fallbackStep ?? "0");
                            if (step === 0) {
                              img.dataset.fallbackStep = "1";
                              img.src = getReviewThumbnailFileUrl(item, thumbVersion);
                              return;
                            }
                            if (step === 1) {
                              img.dataset.fallbackStep = "2";
                              img.src = getReviewOriginalUrl(item, thumbVersion);
                              return;
                            }
                            if (step === 2) {
                              img.dataset.fallbackStep = "3";
                              img.src = getReviewOriginalFileUrl(item, thumbVersion);
                              return;
                            }
                            if (img.dataset.fallbackApplied === "1") {
                              img.src = getThumbFallbackDataUrl(item.filename);
                              return;
                            }
                            img.dataset.fallbackApplied = "1";
                            img.src = getThumbFallbackDataUrl(item.filename);
                          }}
                        />
                        <strong>{item.filename}</strong>
                        <div className="muted">Reason: {item.reviewReason ?? "unknown"}</div>
                        <div className="muted">Rank: {extractDuplicateRank(item.reviewReasonDetails)}</div>
                        <div className="muted">{item.currentPath}</div>
                        <div className="row">
                          <button
                            data-testid={`duplicate-keep-${item.id}`}
                            className="secondaryBtn"
                            onClick={async () => {
                              try {
                                await confirmDuplicateKeep(item.id);
                                setMessage(`Confirmed keep for duplicate cluster ${cluster.clusterId}.`);
                                setSelectedReviewIds([]);
                                await refreshAll();
                              } catch (err) {
                                setMessage(`Confirm duplicate keep failed: ${String(err)}`);
                              }
                            }}
                          >
                            Keep This
                          </button>
                          <button
                            data-testid={`duplicate-delete-${item.id}`}
                            className="secondaryBtn"
                            onClick={async () => {
                              try {
                                await applyReviewAction([item.id], "delete");
                                setMessage(`Marked ${item.filename} for deletion.`);
                                await refreshAll();
                              } catch (err) {
                                setMessage(`Delete failed: ${String(err)}`);
                              }
                            }}
                          >
                            Delete This
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
                  await applyDateApproval(item.mediaItemId, date);
                  await refreshAll();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "events" && (
        <div className="card" data-testid="event-groups-card">
          <h3>Event Group Review</h3>
          <div className="grid">
            {groups.map((group) => (
              <EventCard
                key={group.id}
                group={group}
                onRename={async (name) => {
                  await renameEventGroup(group.id, name);
                  await refreshAll();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="card" data-testid="settings-card">
          <h3>Settings</h3>
          <p className="muted">Configuration only needs a working directory and your OpenAI API key.</p>
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
              <span className="muted" data-testid="health-exiftool-path">
                {toolHealth?.exiftoolPath ?? "(path not resolved)"}
              </span>
            </div>
            <div className="row">
              <span className={toolHealth?.ffmpegAvailable ? "ok" : "warn"} data-testid="health-ffmpeg-status">
                FFmpeg: {toolHealth?.ffmpegAvailable ? "available" : "missing"}
              </span>
              <span className="muted" data-testid="health-ffmpeg-path">
                {toolHealth?.ffmpegPath ?? "(path not resolved)"}
              </span>
            </div>
            {toolHealth && (!toolHealth.exiftoolAvailable || !toolHealth.ffmpegAvailable) && (
              <div className="warn" data-testid="health-warning">
                Missing dependencies can block metadata extraction and video thumbnails.
              </div>
            )}
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
                  setWorkingDirectoryState(workingDirectory);
                  setOutputDirectoryState(outputDirectory);
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
            <button data-testid="settings-save-openai-key" className="secondaryBtn" onClick={onSaveOpenAiKey}>
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
              label="Classification"
              testPrefix="classification"
              value={aiModels.classification}
              onChange={(next) => setAiModels((prev) => ({ ...prev, classification: next }))}
            />
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
            <ModelSelector
              label="Duplicate Ranking"
              testPrefix="duplicate-ranking"
              value={aiModels.duplicateRanking}
              onChange={(next) => setAiModels((prev) => ({ ...prev, duplicateRanking: next }))}
            />
            <button
              data-testid="settings-save-ai-models"
              className="secondaryBtn"
              onClick={async () => {
                try {
                  await setAiTaskModel(
                    "classification",
                    aiModels.classification.provider as "openai" | "anthropic",
                    aiModels.classification.model
                  );
                  await setAiTaskModel(
                    "dateEstimation",
                    aiModels.dateEstimation.provider as "openai" | "anthropic",
                    aiModels.dateEstimation.model
                  );
                  await setAiTaskModel(
                    "eventNaming",
                    aiModels.eventNaming.provider as "openai" | "anthropic",
                    aiModels.eventNaming.model
                  );
                  await setAiTaskModel(
                    "duplicateRanking",
                    aiModels.duplicateRanking.provider as "openai" | "anthropic",
                    aiModels.duplicateRanking.model
                  );
                  setMessage("AI task models saved.");
                } catch (err) {
                  setMessage(`Saving AI models failed: ${String(err)}`);
                }
              }}
            >
              Save AI Models
            </button>
          </div>
          <div className="muted">
            Tip: set both directories once, then run Index Media → Classify → Group → Finalize.
          </div>
        </div>
      )}
      {lightbox && lightboxCurrent && (
        <div className="lightboxOverlay" data-testid="lightbox-overlay" onClick={() => setLightbox(null)}>
          <div
            className="lightboxCard"
            role="dialog"
            aria-label="Image preview"
            data-testid="lightbox-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                {lightboxCurrent.filename}
                {lightbox.items.length > 1 ? ` (${lightbox.index + 1}/${lightbox.items.length})` : ""}
              </strong>
              <div className="row">
                <button
                  data-testid="lightbox-keep"
                  className="primaryBtn"
                  disabled={!lightboxCurrent.duplicateClusterId}
                  onClick={async () => {
                    if (!lightboxCurrent.duplicateClusterId) return;
                    try {
                      await confirmDuplicateKeep(lightboxCurrent.id);
                      setMessage(`Confirmed keep for duplicate cluster ${lightboxCurrent.duplicateClusterId}.`);
                      setSelectedReviewIds([]);
                      setLightbox(null);
                      await refreshAll();
                    } catch (err) {
                      setMessage(`Confirm duplicate keep failed: ${String(err)}`);
                    }
                  }}
                >
                  Keep This
                </button>
                <button
                  data-testid="lightbox-delete"
                  className="secondaryBtn"
                  onClick={async () => {
                    try {
                      await applyReviewAction([lightboxCurrent.id], "delete");
                      setMessage(`Marked ${lightboxCurrent.filename} for deletion.`);
                      setLightbox(null);
                      await refreshAll();
                    } catch (err) {
                      setMessage(`Delete failed: ${String(err)}`);
                    }
                  }}
                >
                  Delete This
                </button>
                <button
                  data-testid="lightbox-prev"
                  className="secondaryBtn"
                  disabled={lightbox.items.length <= 1}
                  onClick={() => moveLightbox(-1)}
                >
                  Prev
                </button>
                <button
                  data-testid="lightbox-next"
                  className="secondaryBtn"
                  disabled={lightbox.items.length <= 1}
                  onClick={() => moveLightbox(1)}
                >
                  Next
                </button>
                <button data-testid="lightbox-close" className="secondaryBtn" onClick={() => setLightbox(null)}>
                  Close
                </button>
              </div>
            </div>
            <img
              className="lightboxImage"
              data-testid="lightbox-image"
              src={getReviewOriginalUrl(lightboxCurrent, thumbVersion)}
              alt={lightboxCurrent.filename}
            />
            <div className="muted" style={{ marginTop: 8 }}>
              Use ←/→ keys to navigate duplicates.
            </div>
          </div>
        </div>
      )}
      {showResetPrompt && (
        <div className="lightboxOverlay" data-testid="reset-session-overlay" onClick={() => setShowResetPrompt(false)}>
          <div
            className="lightboxCard"
            role="dialog"
            aria-label="Reset session confirmation"
            data-testid="reset-session-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Reset Session?</h3>
            <p className="muted">
              This clears pipeline data (review queue, date approvals, groups, sessions) and keeps your configuration settings.
            </p>
            <p className="muted">
              Choose whether to also delete generated files in output folders (`staging`, `review`, `organized`, `recycle`).
            </p>
            <div className="row">
              <button
                data-testid="reset-session-delete-files"
                className="primaryBtn"
                disabled={busyAction !== null}
                onClick={() => void onResetSession(true)}
              >
                Reset and Delete Files
              </button>
              <button
                data-testid="reset-session-keep-files"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={() => void onResetSession(false)}
              >
                Reset App State Only
              </button>
              <button
                data-testid="reset-session-cancel"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={() => setShowResetPrompt(false)}
              >
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

function ReviewItemCard({
  item,
  thumbVersion,
  selectedReviewIds,
  setSelectedReviewIds,
  onOpenPreview
}: {
  item: MediaItem;
  thumbVersion: number;
  selectedReviewIds: number[];
  setSelectedReviewIds: React.Dispatch<React.SetStateAction<number[]>>;
  onOpenPreview: (item: MediaItem) => void;
}) {
  return (
    <div className="item" data-testid={`review-item-${item.id}`}>
      <img
        className="thumbPreview"
        data-testid={`review-thumb-${item.id}`}
        src={getReviewThumbnailUrl(item, thumbVersion)}
        alt={item.filename}
        onClick={() => onOpenPreview(item)}
        onError={(e) => {
          const img = e.currentTarget as HTMLImageElement;
          const step = Number(img.dataset.fallbackStep ?? "0");
          if (step === 0) {
            img.dataset.fallbackStep = "1";
            img.src = getReviewThumbnailFileUrl(item, thumbVersion);
            return;
          }
          if (step === 1) {
            img.dataset.fallbackStep = "2";
            img.src = getReviewOriginalUrl(item, thumbVersion);
            return;
          }
          if (step === 2) {
            img.dataset.fallbackStep = "3";
            img.src = getReviewOriginalFileUrl(item, thumbVersion);
            return;
          }
          if (img.dataset.fallbackApplied === "1") {
            img.src = getThumbFallbackDataUrl(item.filename);
            return;
          }
          img.dataset.fallbackApplied = "1";
          img.src = getThumbFallbackDataUrl(item.filename);
        }}
      />
      <label className="row" htmlFor={`review-select-${item.id}`}>
        <input
          id={`review-select-${item.id}`}
          data-testid={`review-select-${item.id}`}
          type="checkbox"
          checked={selectedReviewIds.includes(item.id)}
          onChange={(e) => {
            setSelectedReviewIds((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)));
          }}
        />
        <span>{item.filename}</span>
      </label>
      <div className="muted">{item.currentPath}</div>
      <div className="muted">Reason: {item.reviewReason ?? "unknown"}</div>
      {item.reviewReasonDetails && <div className="muted">{item.reviewReasonDetails}</div>}
    </div>
  );
}

function extractDuplicateRank(details: string | null): number {
  if (!details) return 999;
  try {
    const parsed = JSON.parse(details);
    const rank = Number(parsed.rank);
    return Number.isFinite(rank) && rank > 0 ? rank : 999;
  } catch {
    return 999;
  }
}

function getReviewThumbnailUrl(item: MediaItem, version: number): string {
  const p = item.currentPath;
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (idx < 0) return getReviewOriginalUrl(item, version);
  const sep = p[idx];
  const dir = p.slice(0, idx);
  const thumb = `${dir}${sep}.thumbnails${sep}${item.id}.jpg`;
  return withCacheBust(safeConvertFileSrc(thumb), version);
}

function getReviewThumbnailFileUrl(item: MediaItem, version: number): string {
  const p = item.currentPath;
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (idx < 0) return getReviewOriginalFileUrl(item, version);
  const sep = p[idx];
  const dir = p.slice(0, idx);
  const thumb = `${dir}${sep}.thumbnails${sep}${item.id}.jpg`;
  return withCacheBust(toFileUrl(thumb), version);
}

function getReviewOriginalUrl(item: MediaItem, version: number): string {
  return withCacheBust(safeConvertFileSrc(item.currentPath), version);
}

function getReviewOriginalFileUrl(item: MediaItem, version: number): string {
  return withCacheBust(toFileUrl(item.currentPath), version);
}

function safeConvertFileSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return toFileUrl(path);
  }
}

function withCacheBust(url: string, version: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(normalized) ? `file:///${normalized}` : `file://${normalized}`;
}

function getThumbFallbackDataUrl(filename: string): string {
  const label = escapeSvgText(filename.split(".").pop()?.toUpperCase() ?? "FILE");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#f3f4f6"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#6b7280" font-family="Segoe UI, Arial, sans-serif" font-size="32">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string): string {
  return value.replace(/[<>&'"]/g, "_");
}

function StatCard({
  label,
  value,
  danger,
  testId
}: {
  label: string;
  value: number;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <div className="card statCard" data-testid={testId}>
      <div className="muted">{label}</div>
      <div className={danger ? "statValue danger" : "statValue"}>{value}</div>
    </div>
  );
}

function DateCard({
  item,
  onApply
}: {
  item: DateEstimate;
  onApply: (date: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(item.aiDate ?? "");
  return (
    <div className="item" data-testid={`date-item-${item.mediaItemId}`}>
      <strong>{item.filename}</strong>
      <div className="muted">Current: {item.currentDate ?? "(missing)"}</div>
      <div className="muted">AI: {item.aiDate ?? "(none)"} ({Math.round(item.confidence * 100)}%)</div>
      <div className="muted">{item.reasoning}</div>
      <div className="row">
        <input
          type="date"
          data-testid={`date-input-${item.mediaItemId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button data-testid={`date-approve-${item.mediaItemId}`} onClick={() => onApply(value || null)}>
          Approve/Edit
        </button>
        <button data-testid={`date-skip-${item.mediaItemId}`} onClick={() => onApply(null)}>
          Skip
        </button>
      </div>
    </div>
  );
}

function EventCard({
  group,
  onRename
}: {
  group: EventGroup;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(group.name);
  return (
    <div className="item" data-testid={`event-group-${group.id}`}>
      <strong>{group.folderName}</strong>
      <div className="muted">{group.itemCount} items</div>
      <div className="row">
        <input
          data-testid={`event-rename-input-${group.id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button data-testid={`event-rename-save-${group.id}`} onClick={() => onRename(value)}>
          Rename
        </button>
      </div>
    </div>
  );
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

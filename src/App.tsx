import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  applyDateApproval,
  confirmDuplicateKeep,
  applyReviewAction,
  finalizeOrganization,
  getAppConfiguration,
  getDashboardStats,
  getDateReviewQueue,
  getEventGroups,
  getReviewQueue,
  initializeApp,
  renameEventGroup,
  runClassification,
  runEventGrouping,
  setAiTaskModel,
  setAnthropicKey,
  setWorkingDirectory,
  setOpenAiKey,
  setOutputDirectory,
  startDownloadSession
} from "./lib/api";
import type { DashboardStats, DateEstimate, EventGroup, MediaItem } from "./types";

type Tab = "dashboard" | "review" | "dates" | "events" | "settings";

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
        await refreshAll();
      })
      .catch((err) => setMessage(`Initialization failed: ${String(err)}`));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshAll().catch(() => undefined);
    }, 3000);
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
    try {
      await setOutputDirectory(outputDirectory);
      await startDownloadSession({ workingDirectory, outputDirectory });
      setMessage("Local media indexed from working directory.");
      await refreshAll();
    } catch (err) {
      setMessage(`Indexing failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onClassify() {
    setBusyAction("classify");
    try {
      await runClassification();
      setMessage("Classification complete.");
      await refreshAll();
    } catch (err) {
      setMessage(`Classification failed: ${String(err)}`);
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
    } catch (err) {
      setMessage(`Confirm duplicate keep failed: ${String(err)}`);
    }
  }

  async function onRunGrouping() {
    setBusyAction("group");
    try {
      await runEventGrouping();
      setMessage("Grouping generated.");
      await refreshAll();
    } catch (err) {
      setMessage(`Grouping failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onFinalize() {
    setBusyAction("finalize");
    try {
      await finalizeOrganization();
      setMessage("Organization finalized.");
      await refreshAll();
    } catch (err) {
      setMessage(`Finalize failed: ${String(err)}`);
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
    <div className="layout">
      <div className="topbar">
        <div>
          <h1 className="title">Memoria</h1>
          <p className="subtitle">Local Media Organizer</p>
        </div>
        <div className="statusPill">{message || "Ready"}</div>
      </div>
      <div className="tabStrip">
        <button className={tab === "dashboard" ? "tab active" : "tab"} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button className={tab === "review" ? "tab active" : "tab"} onClick={() => setTab("review")}>
          Review Queue
        </button>
        <button className={tab === "dates" ? "tab active" : "tab"} onClick={() => setTab("dates")}>
          Date Approval
        </button>
        <button className={tab === "events" ? "tab active" : "tab"} onClick={() => setTab("events")}>
          Event Groups
        </button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "dashboard" && (
        <>
          <div className="statsGrid">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Downloading" value={stats.downloading} />
            <StatCard label="Review Queue" value={stats.review} />
            <StatCard label="Legitimate" value={stats.legitimate} />
            <StatCard label="Date Review" value={stats.dateNeedsReview} />
            <StatCard label="Grouped" value={stats.grouped} />
            <StatCard label="Filed" value={stats.filed} />
            <StatCard label="Errors" value={stats.errors} danger={stats.errors > 0} />
          </div>

          <div className="card">
            <h3>Run Pipeline</h3>
            <div className="row">
              <input
                className="wideInput"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectoryState(e.target.value)}
                placeholder="Working directory containing your media"
              />
              <input
                className="wideInput"
                value={outputDirectory}
                onChange={(e) => setOutputDirectoryState(e.target.value)}
                placeholder="Output directory for organized/review/recycle/staging"
              />
            </div>
            <div className="row">
              <button className="primaryBtn" disabled={busyAction !== null} onClick={onStart}>
                {busyAction === "ingest" ? "Indexing..." : "1) Index Media"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onClassify}>
                {busyAction === "classify" ? "Classifying..." : "2) Classify"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onRunGrouping}>
                {busyAction === "group" ? "Grouping..." : "3) Group"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onFinalize}>
                {busyAction === "finalize" ? "Finalizing..." : "4) Finalize"}
              </button>
            </div>
            <div className="progressTrack">
              <div
                className="progressFill"
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
        <div className="card">
          <h3>Review Queue</h3>
          <div className="row">
            <span className="muted">{selectedCountLabel}</span>
            <select value={reviewReasonFilter} onChange={(e) => setReviewReasonFilter(e.target.value)}>
              <option value="all">All reasons</option>
              {Object.entries(reviewReasonCounts).map(([reason, count]) => (
                <option key={reason} value={reason}>
                  {reason} ({count})
                </option>
              ))}
            </select>
            <button className="secondaryBtn" onClick={() => onApplyReview("include")}>
              Include
            </button>
            <button className="secondaryBtn" onClick={onConfirmDuplicateKeep}>
              Confirm Keep (Duplicate)
            </button>
            <button className="secondaryBtn" onClick={() => onApplyReview("delete")}>
              Delete (to recycle)
            </button>
          </div>
          <div className="grid">
            {nonDuplicateReviewItems.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                selectedReviewIds={selectedReviewIds}
                setSelectedReviewIds={setSelectedReviewIds}
                onOpenPreview={(i) => openLightbox([i], i)}
              />
            ))}
          </div>
          {duplicateClusters.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginBottom: 8 }}>Duplicate Clusters</h4>
              {duplicateClusters.map((cluster) => (
                <div key={cluster.clusterId} className="item" style={{ marginBottom: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Cluster {cluster.clusterId}</strong>
                    <span className="muted">{cluster.items.length} candidates</span>
                  </div>
                  <div className="duplicateClusterGrid">
                    {cluster.items.map((item) => (
                      <div key={item.id} className="duplicateCandidateCard">
                        <img
                          className="thumbPreview"
                          src={getReviewThumbnailUrl(item)}
                          alt={item.filename}
                          onClick={() => openLightbox(cluster.items, item)}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src = getReviewOriginalUrl(item);
                          }}
                        />
                        <strong>{item.filename}</strong>
                        <div className="muted">Reason: {item.reviewReason ?? "unknown"}</div>
                        <div className="muted">Rank: {extractDuplicateRank(item.reviewReasonDetails)}</div>
                        <div className="muted">{item.currentPath}</div>
                        <div className="row">
                          <button
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
        <div className="card">
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
        <div className="card">
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
        <div className="card">
          <h3>Settings</h3>
          <p className="muted">Configuration only needs a working directory and your OpenAI API key.</p>
          <h4 className="settingsSectionTitle">Directories</h4>
          <div className="row settingsDirectoriesRow">
            <div className="settingsField">
              <label className="fieldLabel">Working Directory</label>
              <input
                style={{ minWidth: 320 }}
                placeholder="C:\\Memoria\\inbox"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectoryState(e.target.value)}
              />
            </div>
            <div className="settingsField">
              <label className="fieldLabel">Output Directory</label>
              <input
                style={{ minWidth: 320 }}
                placeholder="C:\\Memoria"
                value={outputDirectory}
                onChange={(e) => setOutputDirectoryState(e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <button
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
          <h4 className="settingsSectionTitle">API Keys</h4>
          <div className="row">
            <input
              type="password"
              style={{ minWidth: 420 }}
              placeholder="OpenAI API Key"
              value={openAiKey}
              onChange={(e) => setOpenAiKey(e.target.value)}
            />
            <button className="secondaryBtn" onClick={onSaveOpenAiKey}>
              Save OpenAI Key
            </button>
            <input
              type="password"
              style={{ minWidth: 420 }}
              placeholder="Anthropic API Key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKeyState(e.target.value)}
            />
            <button
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
          <h4 className="settingsSectionTitle">AI Task Models</h4>
          <div className="row">
            <ModelSelector
              label="Classification"
              value={aiModels.classification}
              onChange={(next) => setAiModels((prev) => ({ ...prev, classification: next }))}
            />
            <ModelSelector
              label="Date Estimation"
              value={aiModels.dateEstimation}
              onChange={(next) => setAiModels((prev) => ({ ...prev, dateEstimation: next }))}
            />
            <ModelSelector
              label="Event Naming"
              value={aiModels.eventNaming}
              onChange={(next) => setAiModels((prev) => ({ ...prev, eventNaming: next }))}
            />
            <ModelSelector
              label="Duplicate Ranking"
              value={aiModels.duplicateRanking}
              onChange={(next) => setAiModels((prev) => ({ ...prev, duplicateRanking: next }))}
            />
            <button
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
        <div className="lightboxOverlay" onClick={() => setLightbox(null)}>
          <div className="lightboxCard" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                {lightboxCurrent.filename}
                {lightbox.items.length > 1 ? ` (${lightbox.index + 1}/${lightbox.items.length})` : ""}
              </strong>
              <div className="row">
                <button
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
                  className="secondaryBtn"
                  disabled={lightbox.items.length <= 1}
                  onClick={() => moveLightbox(-1)}
                >
                  Prev
                </button>
                <button
                  className="secondaryBtn"
                  disabled={lightbox.items.length <= 1}
                  onClick={() => moveLightbox(1)}
                >
                  Next
                </button>
                <button className="secondaryBtn" onClick={() => setLightbox(null)}>
                  Close
                </button>
              </div>
            </div>
            <img
              className="lightboxImage"
              src={getReviewOriginalUrl(lightboxCurrent)}
              alt={lightboxCurrent.filename}
            />
            <div className="muted" style={{ marginTop: 8 }}>
              Use ←/→ keys to navigate duplicates.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewItemCard({
  item,
  selectedReviewIds,
  setSelectedReviewIds,
  onOpenPreview
}: {
  item: MediaItem;
  selectedReviewIds: number[];
  setSelectedReviewIds: React.Dispatch<React.SetStateAction<number[]>>;
  onOpenPreview: (item: MediaItem) => void;
}) {
  return (
    <div className="item">
      <img
        className="thumbPreview"
        src={getReviewThumbnailUrl(item)}
        alt={item.filename}
        onClick={() => onOpenPreview(item)}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).src = getReviewOriginalUrl(item);
        }}
      />
      <label className="row">
        <input
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

function getReviewThumbnailUrl(item: MediaItem): string {
  const p = item.currentPath;
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (idx < 0) return getReviewOriginalUrl(item);
  const sep = p[idx];
  const dir = p.slice(0, idx);
  const thumb = `${dir}${sep}.thumbnails${sep}${item.id}.jpg`;
  return convertFileSrc(thumb);
}

function getReviewOriginalUrl(item: MediaItem): string {
  return convertFileSrc(item.currentPath);
}

function StatCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="card statCard">
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
    <div className="item">
      <strong>{item.filename}</strong>
      <div className="muted">Current: {item.currentDate ?? "(missing)"}</div>
      <div className="muted">AI: {item.aiDate ?? "(none)"} ({Math.round(item.confidence * 100)}%)</div>
      <div className="muted">{item.reasoning}</div>
      <div className="row">
        <input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
        <button onClick={() => onApply(value || null)}>Approve/Edit</button>
        <button onClick={() => onApply(null)}>Skip</button>
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
    <div className="item">
      <strong>{group.folderName}</strong>
      <div className="muted">{group.itemCount} items</div>
      <div className="row">
        <input value={value} onChange={(e) => setValue(e.target.value)} />
        <button onClick={() => onRename(value)}>Rename</button>
      </div>
    </div>
  );
}

function ModelSelector({
  label,
  value,
  onChange
}: {
  label: string;
  value: { provider: string; model: string };
  onChange: (value: { provider: string; model: string }) => void;
}) {
  return (
    <div className="row" style={{ alignItems: "center", gap: 6 }}>
      <span className="muted">{label}</span>
      <select value={value.provider} onChange={(e) => onChange({ ...value, provider: e.target.value })}>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input
        style={{ minWidth: 180 }}
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="Model name"
      />
    </div>
  );
}

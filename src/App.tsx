import { type CSSProperties, type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import { AppShell } from "./components/AppShell";
import { ProgressHero } from "./components/Dashboard/ProgressHero";
import { LoadingState } from "./components/UI/LoadingState";
import { SuccessToast } from "./components/UI/SuccessToast";
import { PageHeader } from "./components/PageHeader";
import { ReviewToolbar } from "./components/ReviewToolbar";
import { WorkflowStepper, type WorkflowStepState } from "./components/WorkflowStepper";
import logoImage from "./assets/logo.png";
import {
  applyDateApproval,
  completeImageReviewAndStartVideoReview,
  completeVideoReviewAndRunGrouping,
  createEventGroup,
  createEventGroupAndMove,
  deleteEventGroup,
  excludeMediaItem,
  excludeMediaItems,
  excludeVideos,
  finalizeOrganization,
  getAppConfiguration,
  getDashboardStats,
  getDateMediaThumbnail,
  getDateReviewQueue,
  getEventGroupItems,
  getEventGroupMediaPreview,
  getEventGroups,
  getImageReviewItems,
  getToolHealth,
  getVideoReviewItems,
  initializeApp,
  moveEventGroupItems,
  renameEventGroup,
  runEventGrouping,
  runDateEnforcement,
  runImageReviewScan,
  restoreVideos,
  restoreMediaItem,
  keepAllBurst,
  keepBestOnly,
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
import type { DashboardStats, DateEstimate, EventGroup, EventGroupItem, ImageReviewItem, VideoReviewItem } from "./types";

type Tab = "dashboard" | "images" | "videos" | "dates" | "events" | "settings";
type PipelineStage = "index" | "image" | "video" | "date" | "group" | "finalize";
type PipelineStageState = "idle" | "running" | "completed" | "failed";

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  indexed: 0,
  imageReview: 0,
  imageVerified: 0,
  dateReview: 0,
  dateNeedsReview: 0,
  dateVerified: 0,
  grouped: 0,
  filed: 0,
  imageFlaggedPending: 0,
  imagePhaseState: "pending",
  videoTotal: 0,
  videoFlagged: 0,
  videoExcluded: 0,
  videoUnreviewedFlagged: 0,
  videoPhaseState: "pending"
};

const POLL_INTERVAL_MS = Number(import.meta.env.VITE_REFRESH_INTERVAL_MS ?? "3000");
const DISABLE_UI_POLLING = import.meta.env.VITE_E2E_DISABLE_POLLING === "1";
const PHASE_VIEW_VARIANTS = {
  initial: { y: 20, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: 8, opacity: 0 }
};
const GRID_CONTAINER_VARIANTS = {
  hidden: { opacity: 0.98 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.02 }
  }
};
const GRID_ITEM_VARIANTS = {
  hidden: { opacity: 0, scale: 0.9, y: 8 },
  show: { opacity: 1, scale: 1, y: 0 }
};

function derivePipelineStages(stats: DashboardStats): Record<PipelineStage, PipelineStageState> {
  const indexCompleted = stats.total > 0;
  const imageCompleted = stats.imagePhaseState === "complete" || (indexCompleted && stats.imageReview === 0);
  const videoCompleted = stats.videoPhaseState === "complete" || (imageCompleted && stats.videoTotal === 0);
  const dateCompleted = videoCompleted && stats.dateNeedsReview === 0;
  return {
    index: indexCompleted ? "completed" : "idle",
    image: !indexCompleted ? "idle" : imageCompleted ? "completed" : "running",
    video: !imageCompleted ? "idle" : videoCompleted ? "completed" : "running",
    date: !videoCompleted ? "idle" : dateCompleted ? "completed" : "running",
    group: stats.grouped > 0 || stats.filed > 0 ? "completed" : dateCompleted ? "idle" : "idle",
    finalize: stats.filed > 0 ? "completed" : "idle"
  };
}

function deriveWorkflowStepStates(
  pipelineStages: Record<PipelineStage, PipelineStageState>,
  activeTab: Tab
): Array<{ id: PipelineStage; label: string; state: WorkflowStepState }> {
  const tabToStage: Record<Tab, PipelineStage> = {
    dashboard: "index",
    images: "image",
    videos: "video",
    dates: "date",
    events: "group",
    settings: "finalize"
  };
  const activeStage = tabToStage[activeTab];
  const ordered: Array<{ id: PipelineStage; label: string }> = [
    { id: "index", label: "Index" },
    { id: "image", label: "Images" },
    { id: "video", label: "Videos" },
    { id: "date", label: "Dates" },
    { id: "group", label: "Groups" },
    { id: "finalize", label: "Finalize" }
  ];
  return ordered.map((step) => {
    const stage = pipelineStages[step.id];
    if (stage === "completed") return { ...step, state: "complete" as const };
    if (step.id === activeStage || stage === "running") return { ...step, state: "current" as const };
    return { ...step, state: "pending" as const };
  });
}

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [dateItems, setDateItems] = useState<DateEstimate[]>([]);
  const [groups, setGroups] = useState<EventGroup[]>([]);
  const [imageItems, setImageItems] = useState<ImageReviewItem[]>([]);
  const [showExcludedImages, setShowExcludedImages] = useState(false);
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
  const [showFinalizeToast, setShowFinalizeToast] = useState(false);
  const [completionToastTotal, setCompletionToastTotal] = useState<number | null>(null);
  const [showResetPrompt, setShowResetPrompt] = useState(false);
  const [resetError, setResetError] = useState<string>("");
  const [resetMode, setResetMode] = useState<"delete" | "state" | null>(null);
  const [showAddGroupForm, setShowAddGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupError, setNewGroupError] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [activeGroupShowExcluded, setActiveGroupShowExcluded] = useState(false);
  const [activeGroupItems, setActiveGroupItems] = useState<EventGroupItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [eventMoveMode, setEventMoveMode] = useState<"existing" | "new">("existing");
  const [eventMoveTargetGroupId, setEventMoveTargetGroupId] = useState<number | null>(null);
  const [eventMoveNewGroupName, setEventMoveNewGroupName] = useState("");
  const [eventMoveError, setEventMoveError] = useState("");
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [movingItemIds, setMovingItemIds] = useState<number[]>([]);
  const [moveSuccessTick, setMoveSuccessTick] = useState(0);
  const [previewItem, setPreviewItem] = useState<EventGroupItem | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [toolHealth, setToolHealth] = useState<ToolHealth | null>(null);
  const [pipelineStages, setPipelineStages] = useState<Record<PipelineStage, PipelineStageState>>(
    derivePipelineStages(DEFAULT_STATS)
  );

  async function refreshAll() {
    const [nextStats, nextDateItems, nextGroups, nextImageItems, nextVideoItems] = await Promise.all([
      getDashboardStats(),
      getDateReviewQueue(),
      getEventGroups(),
      getImageReviewItems(showExcludedImages),
      getVideoReviewItems(showExcludedVideos)
    ]);
    setStats(nextStats);
    setDateItems(nextDateItems);
    setGroups(nextGroups);
    setImageItems(nextImageItems);
    setVideoItems(nextVideoItems);
    setPipelineStages((prev) => {
      const derived = derivePipelineStages(nextStats);
      return {
        index: prev.index === "failed" ? "failed" : derived.index,
        image: prev.image === "failed" ? "failed" : derived.image,
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
  }, [showExcludedVideos, showExcludedImages]);

  useEffect(() => {
    if (stats.total > 0 && stats.filed >= stats.total && completionToastTotal !== stats.total) {
      setShowFinalizeToast(true);
      setCompletionToastTotal(stats.total);
      return;
    }
    if (stats.total === 0 || stats.filed < stats.total) {
      setCompletionToastTotal(null);
    }
  }, [stats.total, stats.filed, completionToastTotal]);

  const [dashboardStackThumbs, setDashboardStackThumbs] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadDashboardThumbs() {
      if (stats.filed <= 0 || groups.length === 0) {
        if (!cancelled) setDashboardStackThumbs([]);
        return;
      }
      const groupCandidates = [...groups]
        .sort((a, b) => b.itemCount - a.itemCount)
        .slice(0, 3);
      const itemIds: number[] = [];
      for (const group of groupCandidates) {
        const groupItems = await getEventGroupItems(group.id, false);
        for (const item of groupItems) {
          itemIds.push(item.id);
          if (itemIds.length >= 3) break;
        }
        if (itemIds.length >= 3) break;
      }
      if (itemIds.length === 0) {
        if (!cancelled) setDashboardStackThumbs([]);
        return;
      }
      const previews = await Promise.all(itemIds.map((id) => getEventGroupMediaPreview(id).catch(() => null)));
      if (!cancelled) {
        setDashboardStackThumbs(previews.filter((value): value is string => Boolean(value)));
      }
    }
    loadDashboardThumbs().catch(() => {
      if (!cancelled) setDashboardStackThumbs([]);
    });
    return () => {
      cancelled = true;
    };
  }, [stats.filed, groups]);

  async function onStart() {
    setBusyAction("ingest");
    setPipelineStages((prev) => ({ ...prev, index: "running", image: "idle", video: "idle", date: "idle", group: "idle", finalize: "idle" }));
    try {
      await startDownloadSession({ workingDirectory, outputDirectory });
      await refreshAll();
      setMessage("Media indexed. Run Image Review next.");
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

  async function onRunImageReviewScan() {
    setBusyAction("image-review-scan");
    try {
      await runImageReviewScan();
      await refreshAll();
      setTab("images");
      setMessage("Image review scan complete.");
    } catch (err) {
      setMessage(`Image review scan failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onRunDateEnforcement() {
    setBusyAction("date-enforcement");
    try {
      await runDateEnforcement();
      await refreshAll();
      setTab("dates");
      setMessage("Date enforcement complete. Review pending items if any.");
    } catch (err) {
      setMessage(`Date enforcement failed: ${String(err)}`);
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
      setShowFinalizeToast(true);
    } catch (err) {
      setMessage(`Finalize failed: ${String(err)}`);
      setPipelineStages((prev) => ({ ...prev, finalize: "failed" }));
    } finally {
      setBusyAction(null);
    }
  }

  async function onResetSession(deleteGeneratedFiles: boolean) {
    setResetError("");
    setResetMode(deleteGeneratedFiles ? "delete" : "state");
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
      setResetError(`Reset failed: ${String(err)}. Please try again or restart the app.`);
    } finally {
      setResetMode(null);
      setBusyAction(null);
    }
  }

  const dashboardPrimaryAction = useMemo(() => {
    if (stats.total === 0) {
      return {
        label: "Start Indexing",
        onClick: () => void onStart(),
        disabled: busyAction !== null
      };
    }
    if (stats.imagePhaseState !== "complete") {
      return {
        label: "Resume Image Review",
        onClick: () => setTab("images"),
        disabled: busyAction !== null
      };
    }
    if (stats.videoPhaseState !== "complete") {
      return {
        label: "Continue Video Review",
        onClick: () => setTab("videos"),
        disabled: busyAction !== null
      };
    }
    if (stats.dateNeedsReview > 0) {
      return {
        label: "Review Dates",
        onClick: () => setTab("dates"),
        disabled: busyAction !== null
      };
    }
    return {
      label: "Open Event Groups",
      onClick: () => setTab("events"),
      disabled: busyAction !== null
    };
  }, [stats.total, stats.imagePhaseState, stats.videoPhaseState, stats.dateNeedsReview, busyAction]);
  const workflowSteps = useMemo(() => {
    const states = deriveWorkflowStepStates(pipelineStages, tab);
    const stateById = Object.fromEntries(states.map((step) => [step.id, step.state])) as Record<PipelineStage, WorkflowStepState>;
    return [
      {
        id: "index",
        label: "Index",
        state: stateById.index,
        testId: "tab-dashboard",
        disabled: busyAction !== null,
        onClick: () => {
          if (stats.total === 0) {
            void onStart();
            return;
          }
          setTab("dashboard");
        }
      },
      {
        id: "image",
        label: "Image Review",
        state: stateById.image,
        pendingCount: stats.imageReview,
        testId: "tab-images",
        disabled: busyAction !== null || stats.total === 0,
        onClick: () => {
          if (stats.total > 0 && stats.imagePhaseState !== "complete" && stats.imageReview === 0) {
            void onRunImageReviewScan();
            return;
          }
          setTab("images");
        }
      },
      {
        id: "video",
        label: "Video Review",
        state: stateById.video,
        testId: "tab-videos",
        disabled: busyAction !== null || stats.imagePhaseState !== "complete",
        onClick: () => setTab("videos")
      },
      {
        id: "date",
        label: "Date Approval",
        state: stateById.date,
        pendingCount: stats.dateNeedsReview,
        testId: "tab-dates",
        disabled: busyAction !== null || stats.videoPhaseState !== "complete",
        onClick: () => {
          void onRunDateEnforcement();
        }
      },
      {
        id: "group",
        label: "Event Groups",
        state: stateById.group,
        testId: "tab-events",
        disabled: busyAction !== null || stats.dateNeedsReview > 0 || stats.videoPhaseState !== "complete",
        onClick: () => {
          void onRunGrouping();
          setTab("events");
        }
      },
      {
        id: "finalize",
        label: "Finalize",
        state: stateById.finalize,
        disabled: busyAction !== null || stats.dateNeedsReview > 0 || (stats.videoTotal > 0 && stats.videoPhaseState !== "complete"),
        onClick: () => {
          void onFinalize();
        }
      }
    ];
  }, [pipelineStages, tab, busyAction, stats.total, stats.imagePhaseState, stats.imageReview, stats.videoPhaseState, stats.dateNeedsReview, stats.videoTotal]);
  const globalProgressPct = useMemo(() => {
    const completeCount = workflowSteps.filter((step) => step.state === "complete").length;
    return (completeCount / 6) * 100;
  }, [workflowSteps]);
  const loadingMessage = useMemo(() => {
    if (busyAction === "ingest") return "Indexing your media...";
    if (busyAction === "date-enforcement") return "Estimating dates with AI...";
    if (busyAction === "group") return "Generating event names with AI...";
    if (busyAction === "finalize") return "Finalizing folders and organizing files...";
    return null;
  }, [busyAction]);

  const normalizedGroupNames = useMemo(() => new Set(groups.map((group) => normalizeName(group.name))), [groups]);
  const activeGroup = useMemo(
    () => (activeGroupId === null ? null : groups.find((group) => group.id === activeGroupId) ?? null),
    [activeGroupId, groups]
  );

  useEffect(() => {
    if (!activeGroupId) {
      return;
    }
    getEventGroupItems(activeGroupId, activeGroupShowExcluded)
      .then((items) => {
        setActiveGroupItems(items);
        setSelectedItemIds([]);
        setLastSelectedIndex(null);
      })
      .catch((err) => {
        setMessage(`Loading group detail failed: ${String(err)}`);
      });
  }, [activeGroupId, activeGroupShowExcluded]);

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
    const idsToMove = [...selectedItemIds];
    setMovingItemIds(idsToMove);
    setBusyAction("move-group-items");
    setEventMoveError("");
    try {
      await new Promise((resolve) => setTimeout(resolve, 240));
      if (eventMoveMode === "existing") {
        if (!eventMoveTargetGroupId) {
          setEventMoveError("Choose a destination group");
          setMovingItemIds([]);
          return;
        }
        await moveEventGroupItems(idsToMove, eventMoveTargetGroupId);
      } else {
        const normalized = normalizeName(eventMoveNewGroupName);
        if (!normalized) {
          setEventMoveError("Group name is required");
          setMovingItemIds([]);
          return;
        }
        if (normalizedGroupNames.has(normalized)) {
          setEventMoveError("A group with this name already exists");
          setMovingItemIds([]);
          return;
        }
        await createEventGroupAndMove(eventMoveNewGroupName.trim(), idsToMove);
      }
      const [nextGroups, nextItems] = await Promise.all([getEventGroups(), getEventGroupItems(activeGroupId, false)]);
      setGroups(nextGroups);
      setActiveGroupItems(nextItems);
      setSelectedItemIds([]);
      setLastSelectedIndex(null);
      setShowMoveDialog(false);
      setMoveSuccessTick((prev) => prev + 1);
      setMessage("Moved selected items.");
    } catch (err) {
      setEventMoveError(String(err));
    } finally {
      setMovingItemIds([]);
      setBusyAction(null);
    }
  }

  return (
    <AppShell
      title="Memoria"
      subtitle="Local Media Organizer"
      status={message || "Ready"}
      progress={globalProgressPct}
      onHomeClick={() => setTab("dashboard")}
      stepper={<WorkflowStepper steps={workflowSteps} />}
      settingsAction={
        <button data-testid="tab-settings" className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
          Settings
        </button>
      }
    >
      {loadingMessage ? (
        <div className="loadingStateOverlay mica-surface bg-white/40 backdrop-blur-md" data-testid="global-loading-state">
          <LoadingState message={loadingMessage} />
        </div>
      ) : null}
      <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={tab}
        variants={PHASE_VIEW_VARIANTS}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={{ duration: 0.22, ease: "easeOut" }}
      >
      <AnimatePresence mode="wait">
        {tab === "dashboard" && (
          <motion.div
            key="dashboard-phase"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="dashboardCanvas bg-slate-50"
          >
            <div className="dashboardHeroShell">
              <ProgressHero
                total={stats.total}
                filed={stats.filed}
                needingReview={{ images: stats.imageReview, dates: stats.dateNeedsReview }}
                previewThumbnails={dashboardStackThumbs}
                onAction={() => {
                  if (dashboardPrimaryAction.disabled) return;
                  dashboardPrimaryAction.onClick();
                }}
              />
            </div>
            <div className="row dashboardResetRow">
              <button
                data-testid="pipeline-reset-session"
                className="textBtn dashboardGhostReset"
                disabled={busyAction !== null}
                onClick={() => {
                  setResetError("");
                  setShowResetPrompt(true);
                }}
              >
                {busyAction === "reset" ? "Resetting..." : "Reset Session"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      {tab === "dates" && (
        <motion.div
          key="dates-phase"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
        <div className="card pageTransition" data-testid="date-approval-card">
          <PageHeader
            title="Date Approval"
            summary={`${dateItems.length} items are awaiting approval. Confirm, edit, or skip each date estimate.`}
          />
          {dateItems.length === 0 ? (
            <EmptyStateBanner />
          ) : (
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
          )}
          {dateItems.length === 0 ? (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <MotionPrimaryButton
                data-testid="date-done-proceed-events"
                className="primaryBtn"
                disabled={busyAction !== null}
                onClick={() => {
                  void onRunGrouping();
                  setTab("events");
                }}
              >
                Done - Proceed to Event Grouping
              </MotionPrimaryButton>
            </div>
          ) : null}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      {tab === "images" && (
        <motion.div
          key="images-phase"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
        <div className="card pageTransition" data-testid="image-review-card">
          <PageHeader
            title="Image Review"
            summary={`${imageItems.filter((item) => item.status !== "excluded").length} active images in review.`}
          />
          <ImageReviewView
            items={imageItems}
            showExcluded={showExcludedImages}
            onToggleShowExcluded={setShowExcludedImages}
            onKeepBestOnly={async (burstGroupId) => {
              await keepBestOnly(burstGroupId);
              await refreshAll();
            }}
            onKeepAll={async (burstGroupId) => {
              await keepAllBurst(burstGroupId);
              await refreshAll();
            }}
            onExcludeSelected={async (ids) => {
              const moved = await excludeMediaItems(ids);
              await refreshAll();
              setMessage(`${moved} items moved to recycle`);
            }}
            onExcludeSingle={async (id) => {
              await excludeMediaItem(id);
              await refreshAll();
              setMessage("Item moved to recycle");
            }}
            onRestoreSingle={async (id) => {
              await restoreMediaItem(id);
              await refreshAll();
              setMessage("Item restored");
            }}
            onDone={async () => {
              await completeImageReviewAndStartVideoReview();
              await refreshAll();
              setTab("videos");
              setMessage("Image review complete. Proceeding to Video Review.");
            }}
          />
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      {tab === "videos" && (
        <motion.div
          key="videos-phase"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
        <div className="card pageTransition" data-testid="video-review-card">
          <PageHeader
            title="Video Review"
            summary={`${videoItems.filter((item) => item.status !== "excluded").length} active videos in this stage.`}
          />
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
              setTab("dates");
              setMessage("Video review complete. Run Date Enforcement next.");
            }}
          />
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      {tab === "events" && (
        <motion.div
          key="events-phase"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
        <div className="card pageTransition" data-testid="event-groups-card">
          <PageHeader
            title="Event Groups"
            summary={activeGroup ? `${activeGroup.itemCount} active items in this group.` : `${groups.length} groups in review.`}
          />
          {activeGroup ? (
            <EventGroupDetailView
              group={activeGroup}
              items={activeGroupItems}
              showExcluded={activeGroupShowExcluded}
              setShowExcluded={setActiveGroupShowExcluded}
              selectedItemIds={selectedItemIds}
              setSelectedItemIds={setSelectedItemIds}
              lastSelectedIndex={lastSelectedIndex}
              setLastSelectedIndex={setLastSelectedIndex}
              onBack={() => setActiveGroupId(null)}
              onOpenPreview={(item) => setPreviewItem(item)}
              onMoveSelected={openMoveDialog}
              movingItemIds={movingItemIds}
              moveSuccessTick={moveSuccessTick}
              onDeleteEmptyGroup={activeGroup.itemCount === 0 ? async () => onDeleteGroup(activeGroup) : undefined}
              onExcludeItem={async (id) => {
                await excludeMediaItem(id);
                if (activeGroupId) {
                  const [nextItems, nextGroups] = await Promise.all([
                    getEventGroupItems(activeGroupId, activeGroupShowExcluded),
                    getEventGroups()
                  ]);
                  setActiveGroupItems(nextItems);
                  setGroups(nextGroups);
                }
                setMessage("Item moved to recycle");
              }}
              onBulkExclude={async (ids) => {
                const moved = await excludeMediaItems(ids);
                if (activeGroupId) {
                  const [nextItems, nextGroups] = await Promise.all([
                    getEventGroupItems(activeGroupId, activeGroupShowExcluded),
                    getEventGroups()
                  ]);
                  setActiveGroupItems(nextItems);
                  setGroups(nextGroups);
                }
                setSelectedItemIds([]);
                setLastSelectedIndex(null);
                setMessage(`${moved} items moved to recycle`);
              }}
              onRestoreItem={async (id) => {
                await restoreMediaItem(id);
                if (activeGroupId) {
                  const [nextItems, nextGroups] = await Promise.all([
                    getEventGroupItems(activeGroupId, activeGroupShowExcluded),
                    getEventGroups()
                  ]);
                  setActiveGroupItems(nextItems);
                  setGroups(nextGroups);
                }
                setMessage("Item restored to group");
              }}
            />
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Event Group Review</h3>
                <MotionPrimaryButton
                  data-testid="event-add-group-button"
                  className="primaryBtn"
                  disabled={busyAction !== null}
                  onClick={() => setShowAddGroupForm((prev) => !prev)}
                >
                  Add Group
                </MotionPrimaryButton>
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
              <motion.div
                className="eventGroupsGrid"
                data-testid="event-groups-review-grid"
                variants={GRID_CONTAINER_VARIANTS}
                initial="hidden"
                animate="show"
                layout
              >
                {groups.map((group, index) => (
                  <motion.div
                    key={group.id}
                    variants={GRID_ITEM_VARIANTS}
                    layout
                    transition={{ delay: Math.min(index * 0.05, 0.35), duration: 0.2 }}
                  >
                    <EventCard
                      group={group}
                      allGroupNames={groups.map((entry) => entry.name)}
                      onOpen={() => {
                        setActiveGroupShowExcluded(false);
                        setActiveGroupId(group.id);
                      }}
                      onRename={async (name) => {
                        await renameEventGroup(group.id, name);
                        await refreshAll();
                      }}
                      onDelete={group.itemCount === 0 ? async () => onDeleteGroup(group) : undefined}
                      busy={busyAction !== null}
                    />
                  </motion.div>
                ))}
              </motion.div>
            </>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
      {tab === "settings" && (
        <motion.div
          key="settings-phase"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
        <div className="card pageTransition" data-testid="settings-card">
          <PageHeader title="Settings" summary="Manage directories, API keys, AI models, and dependency health." />
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

          <section className="settingsSectionCard" data-testid="settings-section-directories">
            <h4 className="settingsSectionTitle">Directories</h4>
            <div className="settingsFormGrid">
              <div className="settingsField">
                <label className="fieldLabel settingsFieldLabel" htmlFor="settings-working-directory">Working Directory</label>
                <input
                  id="settings-working-directory"
                  data-testid="settings-working-directory"
                  className="settingsInput"
                  placeholder="C:\\Memoria\\inbox"
                  value={workingDirectory}
                  onChange={(e) => setWorkingDirectoryState(e.target.value)}
                />
              </div>
              <div className="settingsField">
                <label className="fieldLabel settingsFieldLabel" htmlFor="settings-output-directory">Output Directory</label>
                <input
                  id="settings-output-directory"
                  data-testid="settings-output-directory"
                  className="settingsInput"
                  placeholder="C:\\Memoria"
                  value={outputDirectory}
                  onChange={(e) => setOutputDirectoryState(e.target.value)}
                />
              </div>
            </div>
            <div className="settingsActionRow">
              <MotionPrimaryButton
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
              </MotionPrimaryButton>
            </div>
          </section>

          <section className="settingsSectionCard" data-testid="settings-section-api-keys">
            <h4 className="settingsSectionTitle">API Keys</h4>
            <div className="settingsFormGrid">
              <div className="settingsField">
                <label htmlFor="settings-openai-key" className="fieldLabel settingsFieldLabel">OpenAI API Key</label>
                <input
                  id="settings-openai-key"
                  data-testid="settings-openai-key"
                  type="password"
                  className="settingsInput"
                  placeholder="OpenAI API Key"
                  value={openAiKey}
                  onChange={(e) => setOpenAiKey(e.target.value)}
                />
                <button
                  data-testid="settings-save-openai-key"
                  className="secondaryBtn settingsInlineAction"
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
              </div>
              <div className="settingsField">
                <label htmlFor="settings-anthropic-key" className="fieldLabel settingsFieldLabel">Anthropic API Key</label>
                <input
                  id="settings-anthropic-key"
                  data-testid="settings-anthropic-key"
                  type="password"
                  className="settingsInput"
                  placeholder="Anthropic API Key"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKeyState(e.target.value)}
                />
                <button
                  data-testid="settings-save-anthropic-key"
                  className="secondaryBtn settingsInlineAction"
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
            </div>
          </section>

          <section className="settingsSectionCard" data-testid="settings-section-ai-models">
            <h4 className="settingsSectionTitle">AI Task Models</h4>
            <div className="settingsFormGrid">
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
            </div>
            <div className="settingsActionRow">
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
          </section>
        </div>
        </motion.div>
      )}
      </AnimatePresence>
      </motion.div>
      </AnimatePresence>

      {showMoveDialog && (
        <div className="lightboxOverlay" data-testid="event-move-overlay" onClick={() => setShowMoveDialog(false)}>
          <div
            className="lightboxCard eventMoveDialog mica-surface bg-white/40 backdrop-blur-md"
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
        <div className="lightboxOverlay" data-testid="reset-session-overlay" onClick={() => (busyAction === "reset" ? undefined : setShowResetPrompt(false))}>
          <motion.div
            className="lightboxCard resetModalCard"
            role="dialog"
            aria-label="Reset session confirmation"
            data-testid="reset-session-dialog"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="resetModalTitle">Reset Session?</h3>
            <p className="resetModalDescription">This clears pipeline data and keeps your configuration settings.</p>
            <p className="resetModalDescription">Choose whether to also delete generated files in output folders (`staging`, `organized`, `recycle`).</p>
            {resetError ? (
              <div className="danger" data-testid="reset-session-error" style={{ marginBottom: 8 }}>
                {resetError}
              </div>
            ) : null}
            {busyAction === "reset" ? (
              <div className="muted" data-testid="reset-session-loading" style={{ marginBottom: 8 }}>
                ⏳ Reset in progress...
              </div>
            ) : null}
            <div className="row resetModalActions">
              <button data-testid="reset-session-delete-files" className="resetDeleteBtn" disabled={busyAction !== null} onClick={() => void onResetSession(true)}>
                {resetMode === "delete" && busyAction === "reset" ? "Resetting..." : "Reset and Delete Files"}
              </button>
              <button data-testid="reset-session-keep-files" className="resetStateBtn" disabled={busyAction !== null} onClick={() => void onResetSession(false)}>
                {resetMode === "state" && busyAction === "reset" ? "Resetting..." : "Reset App State Only"}
              </button>
              <button data-testid="reset-session-cancel" className="resetCancelBtn" disabled={busyAction !== null} onClick={() => setShowResetPrompt(false)}>
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}
      <SuccessToast show={showFinalizeToast} onClose={() => setShowFinalizeToast(false)} />
    </AppShell>
  );
}

function MotionPrimaryButton({
  className,
  children,
  ...props
}: ComponentProps<typeof motion.button>) {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={className}
      {...props}
    >
      {children}
    </motion.button>
  );
}

function DateCard({ item, onApply }: { item: DateEstimate; onApply: (date: string | null) => Promise<void> }) {
  const [value, setValue] = useState(item.aiDate ?? "");
  const [thumbSrc, setThumbSrc] = useState<string>("");
  const [busyAction, setBusyAction] = useState<"approve" | "skip" | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [removing, setRemoving] = useState(false);

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
    if (action === "approve") {
      setRemoving(true);
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    setBusyAction(action);
    try {
      await onApply(nextDate);
    } catch {
      // Parent updates user-facing error state.
      setRemoving(false);
    } finally {
      setBusyAction(null);
    }
  }

  const confidencePct = Math.round(item.confidence * 100);
  const confidenceClass = confidencePct >= 80 ? "dateConfidenceHigh" : confidencePct >= 55 ? "dateConfidenceMedium" : "dateConfidenceLow";

  return (
    <div className={`item dateItemCard ${removing ? "itemRemoving" : ""}`} data-testid={`date-item-${item.mediaItemId}`}>
      <div className="dateApprovalCardGrid">
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
        <div className="dateMetaStack">
          <strong className="truncateOneLine">{item.filename}</strong>
          <div className="muted">Current date: {item.currentDate ?? "(missing)"}</div>
          <div className="dateSuggestedLabel">AI Suggested Date</div>
          <div className="dateSuggestedValue">{item.aiDate ?? "(none)"}</div>
          <div className="row">
            <span className={`dateConfidenceBadge ${confidenceClass}`}>Confidence {confidencePct}%</span>
            <button
              type="button"
              data-testid={`date-why-${item.mediaItemId}`}
              className="dateWhyButton"
              onMouseEnter={() => setShowWhy(true)}
              onMouseLeave={() => setShowWhy(false)}
              onFocus={() => setShowWhy(true)}
              onBlur={() => setShowWhy(false)}
            >
              Why?
            </button>
          </div>
          {showWhy ? <div className="dateWhyTooltip">{item.reasoning}</div> : null}
        </div>
      </div>
      <div className="row dateActionRow">
        <input type="date" data-testid={`date-input-${item.mediaItemId}`} value={value} onChange={(e) => setValue(e.target.value)} />
        <MotionPrimaryButton
          data-testid={`date-approve-${item.mediaItemId}`}
          className="primaryBtn"
          disabled={busyAction !== null}
          onClick={() => {
            void handleApply(value || item.aiDate || null, "approve");
          }}
        >
          {busyAction === "approve" ? "Approving..." : "Approve"}
        </MotionPrimaryButton>
        <button
          data-testid={`date-edit-${item.mediaItemId}`}
          className="secondaryBtn"
          disabled={busyAction !== null || value.trim().length === 0}
          onClick={() => {
            void handleApply(value || null, "approve");
          }}
        >
          {busyAction === "approve" ? "Saving..." : "Edit Date"}
        </button>
        <button
          data-testid={`date-skip-${item.mediaItemId}`}
          className="secondaryBtn"
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
        <div className="eventGroupCoverPlaceholder" aria-hidden="true">
          <img src={logoImage} alt="" className="eventGroupFlowerLogo" />
        </div>
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
  showExcluded,
  setShowExcluded,
  selectedItemIds,
  setSelectedItemIds,
  lastSelectedIndex,
  setLastSelectedIndex,
  onBack,
  onOpenPreview,
  onMoveSelected,
  movingItemIds,
  moveSuccessTick,
  onDeleteEmptyGroup,
  onExcludeItem,
  onBulkExclude,
  onRestoreItem
}: {
  group: EventGroup;
  items: EventGroupItem[];
  showExcluded: boolean;
  setShowExcluded: (next: boolean) => void;
  selectedItemIds: number[];
  setSelectedItemIds: (next: number[] | ((prev: number[]) => number[])) => void;
  lastSelectedIndex: number | null;
  setLastSelectedIndex: (next: number | null) => void;
  onBack: () => void;
  onOpenPreview: (item: EventGroupItem) => void;
  onMoveSelected: () => void;
  movingItemIds: number[];
  moveSuccessTick: number;
  onDeleteEmptyGroup?: () => Promise<void>;
  onExcludeItem: (id: number) => Promise<void>;
  onBulkExclude: (ids: number[]) => Promise<void>;
  onRestoreItem: (id: number) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [scrollHeight, setScrollHeight] = useState(500);
  const [confirmBulkExclude, setConfirmBulkExclude] = useState(false);
  const [pulseIds, setPulseIds] = useState<number[]>([]);
  const [showMoveSuccess, setShowMoveSuccess] = useState(false);

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
  const movingSet = useMemo(() => new Set(movingItemIds), [movingItemIds]);
  const pulseSet = useMemo(() => new Set(pulseIds), [pulseIds]);

  useEffect(() => {
    if (!moveSuccessTick) return;
    setShowMoveSuccess(true);
    const timer = window.setTimeout(() => setShowMoveSuccess(false), 900);
    return () => window.clearTimeout(timer);
  }, [moveSuccessTick]);

  function toggleSelection(index: number, shiftKey: boolean) {
    if (showExcluded) return;
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
      setPulseIds(rangeIds);
      window.setTimeout(() => setPulseIds([]), 260);
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
          {showMoveSuccess ? <span className="eventMoveSuccessPill">Moved</span> : null}
          <h3 style={{ margin: "8px 0 0" }}>{group.folderName}</h3>
        </div>
        <div className="row">
          <button
            data-testid="event-show-active"
            className={showExcluded ? "secondaryBtn" : "primaryBtn"}
            onClick={() => {
              setShowExcluded(false);
              setConfirmBulkExclude(false);
            }}
          >
            Show active
          </button>
          <button
            data-testid="event-show-excluded"
            className={showExcluded ? "primaryBtn" : "secondaryBtn"}
            onClick={() => {
              setShowExcluded(true);
              setSelectedItemIds([]);
              setLastSelectedIndex(null);
              setConfirmBulkExclude(false);
            }}
          >
            Show excluded
          </button>
        </div>
        <div className="row">
          <button
            data-testid="event-select-all"
            className="secondaryBtn"
            disabled={showExcluded}
            onClick={() => setSelectedItemIds(items.map((item) => item.id))}
          >
            Select All
          </button>
          <button
            data-testid="event-deselect-all"
            className="secondaryBtn"
            disabled={showExcluded}
            onClick={() => setSelectedItemIds([])}
          >
            Deselect All
          </button>
        </div>
      </div>
      {selectedItemIds.length > 0 && !showExcluded && (
        <div data-testid="event-selection-toolbar">
          <FloatingSelectionBar>
            <strong className="eventFloatingSelectedText">{selectedItemIds.length} selected</strong>
            <button
              data-testid="event-move-selected"
              className="selectionBarButton"
              onClick={onMoveSelected}
            >
              Move to Group
            </button>
            <button
              data-testid="event-exclude-selected"
              className="selectionBarButton"
              onClick={() => setConfirmBulkExclude(true)}
            >
              Exclude Selected
            </button>
            <button data-testid="event-cancel-selected" className="selectionBarButton" onClick={() => setSelectedItemIds([])}>
              Cancel
            </button>
          </FloatingSelectionBar>
        </div>
      )}
      {confirmBulkExclude && selectedItemIds.length > 0 && !showExcluded ? (
        <div className="item" data-testid="event-exclude-selected-confirmation">
          <div className="danger">Move {selectedItemIds.length} items to recycle? This will remove them from this group.</div>
          <div className="row">
            <button
              data-testid="event-exclude-selected-confirm"
              className="secondaryBtn"
              onClick={() => {
                void onBulkExclude(selectedItemIds);
                setConfirmBulkExclude(false);
              }}
            >
              Confirm
            </button>
            <button
              data-testid="event-exclude-selected-cancel"
              className="secondaryBtn"
              onClick={() => setConfirmBulkExclude(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {!showExcluded && items.length === 0 ? (
        <div className="eventGroupDetailEmptyState" data-testid="event-group-detail-empty">
          <img src={logoImage} alt="" aria-hidden="true" className="emptyStateFlower" />
          <p className="eventGroupDetailEmptyMessage">This group is empty. You can delete it or add new items.</p>
          {onDeleteEmptyGroup ? (
            <button
              data-testid="event-delete-empty-group"
              className="textBtn eventDeleteEmptyGhost"
              onClick={() => {
                void onDeleteEmptyGroup();
              }}
            >
              Delete Empty Group
            </button>
          ) : null}
        </div>
      ) : null}
      <div ref={scrollWrapperRef} style={{ flex: 1 }} data-hidden={!showExcluded && items.length === 0 ? "true" : "false"}>
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
          <motion.div
            data-testid="event-virtual-grid-inner"
            data-total-size={rowVirtualizer.getTotalSize()}
            layout
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
              <motion.div
                key={virtualRow.key}
                data-testid={`event-virtual-row-${virtualRow.index}`}
                data-index={virtualRow.index}
                data-measure-element="true"
                className="eventVirtualRow"
                ref={rowVirtualizer.measureElement}
                layout
                variants={GRID_CONTAINER_VARIANTS}
                initial="hidden"
                animate="show"
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
                    <motion.div
                      key={item.id}
                      variants={GRID_ITEM_VARIANTS}
                      initial="hidden"
                      animate="show"
                      transition={{ delay: Math.min(index * 0.05, 0.35), duration: 0.2 }}
                      layout
                      style={{ flex: "1 1 0", minWidth: 0 }}
                    >
                      <EventThumbCard
                        item={item}
                        muted={showExcluded}
                        showExcluded={showExcluded}
                        selected={isSelected}
                        pulsing={pulseSet.has(item.id)}
                        moving={movingSet.has(item.id)}
                        onToggle={(shiftKey) => toggleSelection(index, shiftKey)}
                        onOpenPreview={() => onOpenPreview(item)}
                        onExclude={async () => onExcludeItem(item.id)}
                        onRestore={async () => onRestoreItem(item.id)}
                        style={{ flex: "1 1 0", minWidth: 0 }}
                      />
                    </motion.div>
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
              </motion.div>
            );
          })}
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function EventThumbCard({
  item,
  muted,
  showExcluded,
  selected,
  pulsing,
  moving,
  onToggle,
  onOpenPreview,
  onExclude,
  onRestore,
  style
}: {
  item: EventGroupItem;
  muted: boolean;
  showExcluded: boolean;
  selected: boolean;
  pulsing: boolean;
  moving: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenPreview: () => void;
  onExclude: () => Promise<void>;
  onRestore: () => Promise<void>;
  style?: CSSProperties;
}) {
  const [thumbSrc, setThumbSrc] = useState("");
  const [confirmExclude, setConfirmExclude] = useState(false);
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
      className={`${selected ? "eventThumbCard selected" : "eventThumbCard"} ${pulsing ? "eventThumbPulse" : ""} ${moving ? "eventThumbFlyAway" : ""}`}
      data-testid={`event-media-item-${item.id}`}
      data-muted={muted ? "true" : "false"}
      data-thumbnail-card
      style={{
        ...style,
        minHeight: ITEM_HEIGHT - CARD_GAP,
        display: "flex",
        flexDirection: "column",
        overflow: "visible",
        opacity: muted ? 0.65 : 1
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
        {showExcluded ? (
          <button
            className="secondaryBtn"
            data-testid={`event-media-restore-${item.id}`}
            onClick={() => {
              void onRestore();
            }}
            style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT }}
          >
            Restore
          </button>
        ) : confirmExclude ? (
          <div data-testid={`event-media-exclude-confirm-${item.id}`}>
            <div className="danger" style={{ fontSize: 11, marginBottom: 6 }}>Move this item to recycle?</div>
            <div className="row" style={{ gap: 6 }}>
              <button
                data-testid={`event-media-exclude-confirm-yes-${item.id}`}
                className="secondaryBtn"
                onClick={() => {
                  void onExclude();
                  setConfirmExclude(false);
                }}
                style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT }}
              >
                Confirm
              </button>
              <button
                data-testid={`event-media-exclude-confirm-cancel-${item.id}`}
                className="secondaryBtn"
                onClick={() => setConfirmExclude(false)}
                style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: 6 }}>
            <button
              className="eventThumbSelectButton"
              data-testid={`event-media-select-${item.id}`}
              onClick={(event) => onToggle(event.shiftKey)}
              style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT }}
            >
              {selected ? "Selected" : "Select"}
            </button>
            <button
              className="secondaryBtn"
              data-testid={`event-media-exclude-${item.id}`}
              onClick={() => setConfirmExclude(true)}
              style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT, borderColor: "#b91c1c", color: "#b91c1c" }}
            >
              Exclude
            </button>
          </div>
        )}
      </div>
      {selected ? <div className="eventThumbCheckmark">✓</div> : null}
    </div>
  );
}

function ImageReviewView({
  items,
  showExcluded,
  onToggleShowExcluded,
  onKeepBestOnly,
  onKeepAll,
  onExcludeSelected,
  onExcludeSingle,
  onRestoreSingle,
  onDone
}: {
  items: ImageReviewItem[];
  showExcluded: boolean;
  onToggleShowExcluded: (next: boolean) => void;
  onKeepBestOnly: (burstGroupId: string) => Promise<void>;
  onKeepAll: (burstGroupId: string) => Promise<void>;
  onExcludeSelected: (ids: number[]) => Promise<void>;
  onExcludeSingle: (id: number) => Promise<void>;
  onRestoreSingle: (id: number) => Promise<void>;
  onDone: () => Promise<void>;
}) {
  const [viewMode, setViewMode] = useState<"all" | "flagged" | "burst">("flagged");
  const [sortMode, setSortMode] = useState<"date" | "size" | "sharpness">("date");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [previewById, setPreviewById] = useState<Record<number, string>>({});
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const baseItems = useMemo(
    () => items.filter((item) => (showExcluded ? item.status === "excluded" : item.status !== "excluded")),
    [items, showExcluded]
  );
  const sortedItems = useMemo(() => {
    const cloned = [...baseItems];
    cloned.sort((a, b) => {
      if (sortMode === "size") return b.fileSizeBytes - a.fileSizeBytes;
      if (sortMode === "sharpness") return (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0);
      return (a.dateTaken ?? "").localeCompare(b.dateTaken ?? "");
    });
    return cloned;
  }, [baseItems, sortMode]);
  const visibleItems = useMemo(() => {
    if (viewMode === "all") return sortedItems;
    if (viewMode === "flagged") return sortedItems.filter((item) => item.imageFlags.length > 0);
    return sortedItems.filter((item) => item.burstGroupId);
  }, [sortedItems, viewMode]);

  const burstGroups = useMemo(() => {
    const map = new Map<string, ImageReviewItem[]>();
    for (const item of visibleItems) {
      if (!item.burstGroupId) continue;
      const current = map.get(item.burstGroupId) ?? [];
      current.push(item);
      map.set(item.burstGroupId, current);
    }
    return map;
  }, [visibleItems]);

  useEffect(() => {
    const pending = visibleItems
      .filter((item) => !thumbs[item.id])
      .slice(0, 20)
      .map((item) =>
        getDateMediaThumbnail(item.id).then((src) => ({ id: item.id, src: src ?? getDateThumbFallbackDataUrl(item.filename) }))
      );
    if (!pending.length) return;
    Promise.all(pending).then((rows) => {
      setThumbs((prev) => {
        const next = { ...prev };
        for (const row of rows) next[row.id] = row.src;
        return next;
      });
    });
  }, [visibleItems, thumbs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setColumnCount(calculateColumnCount(entry.contentRect.width, 180));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rowCount = calculateRowCount(visibleItems.length, columnCount);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ITEM_HEIGHT + 16,
    overscan: 3
  });
  const modalItems = viewMode === "burst" ? visibleItems : visibleItems;
  const modalItem = modalIndex === null ? null : modalItems[modalIndex] ?? null;

  async function openModal(index: number) {
    const item = modalItems[index];
    if (!item) return;
    if (!previewById[item.id]) {
      const src = (await getEventGroupMediaPreview(item.id)) ?? "";
      setPreviewById((prev) => ({ ...prev, [item.id]: src }));
    }
    setModalIndex(index);
  }

  const flaggedCount = baseItems.filter((item) => item.imageFlags.length > 0).length;
  const unflaggedCount = baseItems.filter((item) => item.imageFlags.length === 0).length;

  return (
    <div data-testid="image-review-view">
      <ReviewToolbar
        testId="image-mode-toolbar"
        left={
          <div className="row">
            <button data-testid="image-show-active" className={showExcluded ? "secondaryBtn" : "primaryBtn"} onClick={() => onToggleShowExcluded(false)}>
              Active
            </button>
            <button data-testid="image-show-excluded" className={showExcluded ? "primaryBtn" : "secondaryBtn"} onClick={() => onToggleShowExcluded(true)}>
              Excluded
            </button>
          </div>
        }
        right={<div className="muted" data-testid="image-filter-summary">Showing {flaggedCount} flagged, {unflaggedCount} unflagged - {baseItems.length} total</div>}
      />

      <ReviewToolbar
        testId="image-filter-bar"
        left={
          <div className="row">
            <button data-testid="image-filter-all" className={viewMode === "all" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("all")}>All Images</button>
            <button data-testid="image-filter-flagged" className={viewMode === "flagged" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("flagged")}>Flagged Only</button>
            <button data-testid="image-filter-burst" className={viewMode === "burst" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("burst")}>Burst Groups</button>
            <select data-testid="image-sort" value={sortMode} onChange={(e) => setSortMode(e.target.value as "date" | "size" | "sharpness")}>
              <option value="date">Date</option>
              <option value="size">File Size</option>
              <option value="sharpness">Sharpness Score</option>
            </select>
          </div>
        }
        right={
          <div className="row">
            <button data-testid="image-select-all-flagged" className="secondaryBtn" onClick={() => setSelectedIds(visibleItems.filter((i) => i.imageFlags.length > 0).map((i) => i.id))}>
              Select All Flagged
            </button>
          </div>
        }
      />

      {viewMode === "burst" ? (
        <div data-testid="image-burst-groups-view">
          {Array.from(burstGroups.entries()).map(([groupId, groupItems]) => (
            <div key={groupId} className="item" data-testid={`image-burst-group-${groupId}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">Burst group - {groupItems.length} shots, best auto-selected</div>
                <div className="row">
                  <button data-testid={`image-keep-best-only-${groupId}`} className="secondaryBtn" onClick={() => void onKeepBestOnly(groupId)}>Keep Best Only</button>
                  <button data-testid={`image-keep-all-${groupId}`} className="secondaryBtn" onClick={() => void onKeepAll(groupId)}>Keep All</button>
                </div>
              </div>
              <motion.div className="eventGroupsGrid" variants={GRID_CONTAINER_VARIANTS} initial="hidden" animate="show" layout>
                {groupItems.map((item, index) => (
                  <motion.div
                    key={item.id}
                    variants={GRID_ITEM_VARIANTS}
                    layout
                    transition={{ delay: Math.min(index * 0.05, 0.35), duration: 0.2 }}
                    style={{ flex: "1 1 0", minWidth: 0 }}
                  >
                    <ImageCard
                      item={item}
                      selected={selected.has(item.id)}
                      thumbnail={thumbs[item.id] || getDateThumbFallbackDataUrl(item.filename)}
                      onToggle={() => setSelectedIds((prev) => prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id])}
                      onOpen={() => void openModal(visibleItems.findIndex((entry) => entry.id === item.id))}
                      onExclude={() => void onExcludeSingle(item.id)}
                      onRestore={() => void onRestoreSingle(item.id)}
                      muted={showExcluded}
                    />
                  </motion.div>
                ))}
              </motion.div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="eventVirtualGridViewport"
          ref={containerRef}
          data-testid="image-virtual-grid"
          style={{ height: "56vh", overflow: "auto", position: "relative" }}
        >
          <motion.div layout style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const startIndex = virtualRow.index * columnCount;
              const rowItems = visibleItems.slice(startIndex, startIndex + columnCount);
              return (
                <div key={virtualRow.key} style={{ position: "absolute", top: virtualRow.start, left: 0, right: 0, display: "flex", gap: "8px", padding: "0 8px" }}>
                  {rowItems.map((item, offset) => (
                    <motion.div
                      key={item.id}
                      variants={GRID_ITEM_VARIANTS}
                      initial="hidden"
                      animate="show"
                      layout
                      transition={{ delay: Math.min((startIndex + offset) * 0.05, 0.35), duration: 0.2 }}
                      style={{ flex: "1 1 0", minWidth: 0 }}
                    >
                      <ImageCard
                        item={item}
                        selected={selected.has(item.id)}
                        thumbnail={thumbs[item.id] || getDateThumbFallbackDataUrl(item.filename)}
                        onToggle={() => setSelectedIds((prev) => prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id])}
                        onOpen={() => void openModal(visibleItems.findIndex((entry) => entry.id === item.id))}
                        onExclude={() => void onExcludeSingle(item.id)}
                        onRestore={() => void onRestoreSingle(item.id)}
                        muted={showExcluded}
                      />
                    </motion.div>
                  ))}
                </div>
              );
            })}
          </motion.div>
        </div>
      )}

      {!showExcluded ? (
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <MotionPrimaryButton
            data-testid="image-done-proceed"
            className="primaryBtn"
            onClick={() => {
              const continuing = items.filter((item) => item.status !== "excluded").length;
              const excluded = items.filter((item) => item.status === "excluded").length;
              const pending = items.filter((item) => item.status === "indexed" && item.imageFlags.length > 0).length;
              const ok = window.confirm(
                `${continuing} images will continue to pipeline. ${excluded} images have been excluded. ${pending} flagged images have not been reviewed. Proceed?`
              );
              if (!ok) return;
              void onDone();
            }}
          >
            Done - Proceed to Video Review
          </MotionPrimaryButton>
        </div>
      ) : null}

      {selectedIds.length > 0 && !showExcluded ? (
        <FloatingSelectionBar>
          <button
            data-testid="image-exclude-selected"
            className="selectionBarButton"
            onClick={() => {
              void onExcludeSelected(selectedIds);
              setSelectedIds([]);
            }}
          >
            Exclude Selected
          </button>
          <button
            data-testid="image-move-selected"
            className="selectionBarButton"
            onClick={() => window.alert("Move to Group is available in Event Groups.")}
          >
            Move to Group
          </button>
          <button data-testid="image-cancel-selected" className="selectionBarButton" onClick={() => setSelectedIds([])}>
            Cancel
          </button>
        </FloatingSelectionBar>
      ) : null}

      {baseItems.length === 0 ? <EmptyStateBanner /> : null}

      {modalItem ? (
        <div className="lightboxOverlay" data-testid="image-preview-modal-overlay" onClick={() => setModalIndex(null)}>
          <div className="lightboxCard" data-testid="image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{modalItem.filename}</strong>
              <button data-testid="image-preview-close" className="secondaryBtn" onClick={() => setModalIndex(null)}>Close</button>
            </div>
            {previewById[modalItem.id] ? (
              <img data-testid="image-preview-asset" src={previewById[modalItem.id]} alt={modalItem.filename} style={{ width: "100%", maxHeight: "55vh", objectFit: "contain" }} />
            ) : (
              <div className="muted">Loading...</div>
            )}
            <div className="muted" data-testid="image-preview-meta">
              {formatFileSize(modalItem.fileSizeBytes)} • {modalItem.dateTaken ?? "(missing date)"} • sharpness {(modalItem.sharpnessScore ?? 0).toFixed(1)}
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {modalItem.imageFlags.map((flag) => <span key={flag} className="muted">{flag}</span>)}
            </div>
            {modalItem.burstGroupId ? (
              <div className="row" data-testid="image-preview-filmstrip">
                {visibleItems
                  .filter((item) => item.burstGroupId === modalItem.burstGroupId)
                  .map((item) => (
                    <button
                      key={item.id}
                      data-testid={`image-filmstrip-item-${item.id}`}
                      className="secondaryBtn"
                      onClick={() => setModalIndex(visibleItems.findIndex((entry) => entry.id === item.id))}
                    >
                      {item.filename}
                    </button>
                  ))}
              </div>
            ) : null}
            <div className="row">
              <button data-testid="image-preview-prev" className="secondaryBtn" disabled={(modalIndex ?? 0) <= 0} onClick={() => setModalIndex((prev) => (prev === null ? prev : Math.max(0, prev - 1)))}>
                Previous
              </button>
              <button data-testid="image-preview-next" className="secondaryBtn" disabled={(modalIndex ?? 0) >= modalItems.length - 1} onClick={() => setModalIndex((prev) => (prev === null ? prev : Math.min(modalItems.length - 1, prev + 1)))}>
                Next
              </button>
              <button
                data-testid="image-preview-exclude"
                className="secondaryBtn"
                onClick={async () => {
                  await onExcludeSingle(modalItem.id);
                  setModalIndex((prev) => {
                    if (prev === null) return prev;
                    return Math.min(prev, Math.max(0, modalItems.length - 2));
                  });
                }}
              >
                Exclude
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImageCard({
  item,
  selected,
  thumbnail,
  onToggle,
  onOpen,
  onExclude,
  onRestore,
  muted
}: {
  item: ImageReviewItem;
  selected: boolean;
  thumbnail: string;
  onToggle: () => void;
  onOpen: () => void;
  onExclude: () => void;
  onRestore: () => void;
  muted: boolean;
}) {
  const [removing, setRemoving] = useState(false);
  async function handleExcludeClick() {
    setRemoving(true);
    await new Promise((resolve) => setTimeout(resolve, 140));
    onExclude();
  }
  return (
    <div className={`${selected ? "mediaTile mediaTileSelected" : "mediaTile"} ${removing ? "itemRemoving" : ""}`} data-testid={`image-item-${item.id}`} style={{ flex: "1 1 0", minWidth: 0, opacity: muted ? 0.65 : 1 }}>
      <button data-testid={`image-open-${item.id}`} className="mediaTileOpen" onClick={onOpen}>
        <img className="mediaTileImage mediaTileImageSquare" src={thumbnail} alt={item.filename} />
      </button>
      <div className="mediaTileOverlay">
        <div className="mediaTileOverlayTop">
          <button data-testid={`image-select-${item.id}`} className="mediaTileIconButton" onClick={onToggle} aria-label={selected ? "Deselect" : "Select"}>
            <IconCheckCircle filled={selected} />
          </button>
          {item.status === "excluded" ? (
            <button data-testid={`image-restore-${item.id}`} className="mediaTileIconButton" onClick={onRestore} aria-label="Restore">
              ↺
            </button>
          ) : (
              <button data-testid={`image-exclude-${item.id}`} className="mediaTileIconButton mediaTileIconButtonDanger" onClick={() => void handleExcludeClick()} aria-label="Exclude">
              <IconXCircle />
            </button>
          )}
        </div>
        <div className="mediaTileOverlayBottom">
          <strong className="truncateOneLine">{item.filename}</strong>
          <div className="mediaTileMeta truncateOneLine">{formatFileSize(item.fileSizeBytes)} • {item.dateTaken ?? "(missing date)"}</div>
          <div className="mediaTileBadges">
            {item.imageFlags.includes("small_file") ? <span data-testid={`image-flag-small-${item.id}`} className="mediaTileBadge">small_file</span> : null}
            {item.imageFlags.includes("blurry") ? <span data-testid={`image-flag-blurry-${item.id}`} className="mediaTileBadge">blurry</span> : null}
            {item.imageFlags.includes("burst_shot") ? <span data-testid={`image-flag-burst-${item.id}`} className="mediaTileBadge">burst_shot</span> : null}
            {item.isBurstPrimary ? <span data-testid={`image-flag-best-${item.id}`} className="mediaTileBadge mediaTileBadgeBest">Best</span> : null}
          </div>
        </div>
      </div>
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
  const [activeFilter, setActiveFilter] = useState<"size" | "duration">("size");
  const [sizeThresholdMb, setSizeThresholdMb] = useState(5);
  const [durationThresholdSecs, setDurationThresholdSecs] = useState(10);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [removingIds, setRemovingIds] = useState<number[]>([]);
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
        return activeFilter === "size" ? underSize : underDuration;
      }),
    [items, sizeThresholdMb, durationThresholdSecs, activeFilter]
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

  async function animateAndExclude(id: number) {
    setRemovingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    await new Promise((resolve) => setTimeout(resolve, 140));
    await handleExclude([id]);
    setRemovingIds((prev) => prev.filter((entry) => entry !== id));
  }

  return (
    <div data-testid="video-review-view">
      <ReviewToolbar
        testId="video-mode-toolbar"
        left={
          <div className="row">
            <button data-testid="video-show-active" className={showExcluded ? "secondaryBtn" : "primaryBtn"} onClick={() => onToggleShowExcluded(false)}>
              Active
            </button>
            <button data-testid="video-show-excluded" className={showExcluded ? "primaryBtn" : "secondaryBtn"} onClick={() => onToggleShowExcluded(true)}>
              Excluded
            </button>
          </div>
        }
        right={
          <div data-testid="video-filter-summary" className="muted">
            {activeFilter === "size"
              ? `Showing videos under ${sizeThresholdMb} MB`
              : `Showing videos under ${durationThresholdSecs} sec`}
          </div>
        }
      />

      <ReviewToolbar
        testId="video-filter-bar"
        left={
          <div className="row">
            <label>
              <input
                data-testid="video-filter-mode-size"
                type="radio"
                checked={activeFilter === "size"}
                onChange={() => setActiveFilter("size")}
              />
              Filter by Size
            </label>
            <label>
              <input
                data-testid="video-filter-mode-duration"
                type="radio"
                checked={activeFilter === "duration"}
                onChange={() => setActiveFilter("duration")}
              />
              Filter by Duration
            </label>
          </div>
        }
        right={
          <div className="row">
            <button data-testid="video-select-all-filtered" className="secondaryBtn" onClick={() => setSelectedIds(filtered.map((item) => item.id))}>
              Select All Filtered
            </button>
          </div>
        }
      />
      <div className="item mediaControlsStack">
        <label htmlFor="video-size-slider">Show videos under {sizeThresholdMb} MB</label>
        <input
          id="video-size-slider"
          data-testid="video-size-slider"
          type="range"
          min={0}
          max={50}
          value={sizeThresholdMb}
          disabled={activeFilter !== "size"}
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
          disabled={activeFilter !== "duration"}
          onChange={(e) => setDurationThresholdSecs(Number(e.target.value))}
        />
      </div>

      <div ref={scrollWrapperRef}>
        <div
          className="eventVirtualGridViewport"
          ref={containerRef}
          data-testid="video-virtual-grid"
          style={{ height: `${scrollHeight}px`, overflow: "auto", position: "relative" }}
        >
          <motion.div layout style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
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
                    const flagged = activeFilter === "size" ? underSize : underDuration;
                    const previewSrc = previewById[item.id] ?? "";
                    const thumbSrc = thumbs[item.id] || getDateThumbFallbackDataUrl(item.filename);
                    return (
                      <motion.div
                        key={item.id}
                        className={`${isSelected ? "mediaTile mediaTileVideo mediaTileSelected" : "mediaTile mediaTileVideo"} ${removingIds.includes(item.id) ? "itemRemoving" : ""}`}
                        data-testid={`video-item-${item.id}`}
                        data-flagged={flagged ? "true" : "false"}
                        variants={GRID_ITEM_VARIANTS}
                        initial="hidden"
                        animate="show"
                        layout
                        transition={{ delay: Math.min((startIndex + offset) * 0.05, 0.35), duration: 0.2 }}
                        style={{ flex: "1 1 0", minWidth: 0, position: "relative" }}
                      >
                        {inlinePlayingId === item.id && previewSrc ? (
                          <video data-testid={`video-inline-player-${item.id}`} src={previewSrc} autoPlay muted controls className="mediaTileVideoAsset" />
                        ) : (
                          <button data-testid={`video-open-${item.id}`} className="mediaTileOpen" onClick={() => void handleOpen(item, startIndex + offset)}>
                            <img className="mediaTileImage mediaTileImageVideo" src={thumbSrc} alt={item.filename} />
                            <span data-testid={`video-play-overlay-${item.id}`} className="mediaTilePlayGlyph">▶</span>
                          </button>
                        )}
                        <div className="mediaTileOverlay">
                          <div className="mediaTileOverlayTop">
                            <button
                              data-testid={`video-select-${item.id}`}
                              className="mediaTileIconButton"
                              onClick={() => setSelectedIds((prev) => prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id])}
                              aria-label={isSelected ? "Deselect" : "Select"}
                            >
                              <IconCheckCircle filled={isSelected} />
                            </button>
                            {showExcluded ? (
                              <button data-testid={`video-restore-${item.id}`} className="mediaTileIconButton" onClick={() => void handleRestore([item.id])} aria-label="Restore">↺</button>
                            ) : (
                              <button data-testid={`video-exclude-${item.id}`} className="mediaTileIconButton mediaTileIconButtonDanger" onClick={() => void animateAndExclude(item.id)} aria-label="Exclude">
                                <IconXCircle />
                              </button>
                            )}
                          </div>
                          <div className="mediaTileOverlayBottom">
                            <strong className="truncateOneLine">{item.filename}</strong>
                            <div className="mediaTileMeta truncateOneLine">{formatFileSize(item.fileSizeBytes)} • {formatDuration(item.durationSecs)}</div>
                            {flagged ? <span className="mediaTileBadge">candidate</span> : null}
                          </div>
                        </div>
                        <span className="mediaTileDuration">{formatDuration(item.durationSecs)}</span>
                        {inlinePlayingId !== item.id ? (
                          <span className="mediaTilePlayGlyphStatic">▶</span>
                        ) : null}
                      </motion.div>
                    );
                  })}
                  {emptySlotCount > 0 ? Array.from({ length: emptySlotCount }).map((_, index) => <div key={`v-empty-${virtualRow.index}-${index}`} style={{ flex: "1 1 0", minWidth: 0 }} />) : null}
                </div>
              );
            })}
          </motion.div>
        </div>
      </div>

      {selectedIds.length > 0 && !showExcluded ? (
        <FloatingSelectionBar>
          <button data-testid="video-exclude-selected" className="selectionBarButton" onClick={() => void handleExclude(selectedIds)}>
            Exclude Selected
          </button>
          <button
            data-testid="video-move-selected"
            className="selectionBarButton"
            onClick={() => window.alert("Move to Group is available in Event Groups.")}
          >
            Move to Group
          </button>
          <button data-testid="video-cancel-selected" className="selectionBarButton" onClick={() => setSelectedIds([])}>
            Cancel
          </button>
        </FloatingSelectionBar>
      ) : null}

      {!showExcluded ? (
        <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <MotionPrimaryButton
            data-testid="video-done-proceed"
            className="primaryBtn"
            onClick={() => {
              const groupedCount = items.length;
              const ok = window.confirm(`${groupedCount} videos will continue to Date Enforcement. ${excludedCount} videos have been excluded. Proceed?`);
              if (!ok) return;
              void onProceed();
            }}
          >
            Done - Proceed to Date Enforcement
          </MotionPrimaryButton>
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

function FloatingSelectionBar({ children }: { children: ReactNode }) {
  return <div className="floatingSelectionBar">{children}</div>;
}

function IconCheckCircle({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill={filled ? "rgba(34,197,94,0.9)" : "rgba(255,255,255,0.1)"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M8.5 12.2l2.4 2.4 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconXCircle() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="rgba(255,255,255,0.1)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function EmptyStateBanner() {
  return (
    <div className="emptyStateSurface" data-testid="empty-state-banner">
      <img src={logoImage} alt="" aria-hidden="true" className="emptyStateFlower" />
      <div className="emptyStateMessage">All caught up! Your library is looking great.</div>
    </div>
  );
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
    <div className="settingsField settingsModelCard" data-testid={`model-selector-${testPrefix}`}>
      <label className="fieldLabel settingsFieldLabel" htmlFor={providerId}>{label}</label>
      <select
        id={providerId}
        data-testid={`model-provider-${testPrefix}`}
        className="settingsInput"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value })}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input
        id={modelId}
        data-testid={`model-name-${testPrefix}`}
        className="settingsInput"
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        placeholder="Model name"
      />
    </div>
  );
}

import { type CSSProperties, type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { AppShell } from "./components/AppShell";
import { ProgressHero } from "./components/Dashboard/ProgressHero";
import { LoadingState, type PipelineProgress } from "./components/UI/LoadingState";
import { SuccessToast } from "./components/UI/SuccessToast";
import { PageHeader } from "./components/PageHeader";
import { ReviewToolbar } from "./components/ReviewToolbar";
import { WorkflowStepper, type WorkflowStepState } from "./components/WorkflowStepper";
import logoImage from "./assets/logo.png";
import {
  applyDateApproval,
  clearAiTaskModel,
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
  clearHomeLocation,
  setAnthropicKey,
  setHomeLocation,
  setOpenAiKey,
  setOutputDirectory,
  setWorkingDirectory,
  startDownloadSession,
  resetSession,
  getImageReviewSettings,
  setImageReviewSettings,
  getVideoSrcUrl,
  type OptionalAiTaskName,
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
import type { DashboardStats, DateEstimate, EventGroup, EventGroupItem, ImageReviewItem, ImageReviewSettings, VideoReviewItem } from "./types";

type Tab = "dashboard" | "images" | "videos" | "dates" | "events" | "settings";
type PipelineStage = "index" | "image" | "video" | "date" | "group" | "finalize";
type PipelineStageState = "idle" | "running" | "completed" | "failed";
type AiModelSelection = { provider: string; model: string };
type AiModelsState = {
  dateEstimation: AiModelSelection;
  dateEstimationFallback: AiModelSelection | null;
  eventNaming: AiModelSelection;
  eventNamingFallback: AiModelSelection | null;
  groupingPass1: AiModelSelection | null;
  imageReview: AiModelSelection | null;
};

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
  const [aiModels, setAiModels] = useState<AiModelsState>(createDefaultAiModels);
  const savedAiModelsRef = useRef<AiModelsState>(createDefaultAiModels());
  const [homeAddressInput, setHomeAddressInput] = useState("");
  const [homeLabelInput, setHomeLabelInput] = useState("");
  const [homeRadiusInput, setHomeRadiusInput] = useState("25");
  const [homeLocationStatus, setHomeLocationStatus] = useState("");
  const [reviewSettings, setReviewSettings] = useState<ImageReviewSettings | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
  const [showFinalizeToast, setShowFinalizeToast] = useState(false);
  const [completionToastTotal, setCompletionToastTotal] = useState<number | null>(null);
  const [showResetPrompt, setShowResetPrompt] = useState(false);
  const [resetError, setResetError] = useState<string>("");
  const [resetMode, setResetMode] = useState<"delete" | "state" | null>(null);
  const [hasFinalizedSession, setHasFinalizedSession] = useState(false);
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
      getImageReviewItems(true),
      getVideoReviewItems(true)
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
          const loadedAiModels = normalizeAiTaskModels(
            (cfg as { aiTaskModels?: Partial<AiModelsState> }).aiTaskModels
          );
          setAiModels(loadedAiModels);
          savedAiModelsRef.current = loadedAiModels;
          if (cfg.homeLocation) {
            setHomeAddressInput(cfg.homeLocation.addressRaw);
            setHomeLabelInput(cfg.homeLocation.label ?? "");
            setHomeRadiusInput(String(cfg.homeLocation.radiusMiles));
            setHomeLocationStatus(
              `Saved: ${cfg.homeLocation.addressRaw} (${cfg.homeLocation.latitude.toFixed(2)}, ${cfg.homeLocation.longitude.toFixed(2)})`
            );
          }
        } catch {
          // keep defaults
        }
        try {
          const health = await getToolHealth();
          setToolHealth(health);
        } catch {
          setToolHealth(null);
        }
        try {
          const rs = await getImageReviewSettings();
          setReviewSettings(rs);
        } catch {
          // keep null
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
    if (window.__MEMORIA_TEST_API__) return;
    let unlisten: (() => void) | undefined;
    listen<{ phase: string; message: string; current: number; total: number }>(
      "pipeline-progress",
      (event) => {
        setPipelineProgress({
          current: event.payload.current,
          total: event.payload.total,
          detail: event.payload.message
        });
      }
    )
      .then((fn) => { unlisten = fn; })
      .catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (busyAction === null) {
      setPipelineProgress(null);
    }
  }, [busyAction]);

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
          if (!item.mimeType.startsWith("image/")) continue;
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
    setHasFinalizedSession(false);
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

  async function onRunGrouping(navigateToEvents = true) {
    setBusyAction("group");
    setPipelineStages((prev) => ({ ...prev, group: "running", finalize: "idle" }));
    try {
      // If no date-verified items are available yet, run date enforcement first.
      // This prevents entering Event Groups with zero generated groups.
      if (stats.total > 0 && stats.dateVerified === 0) {
        await runDateEnforcement();
        await refreshAll();
        const postDateStats = await getDashboardStats();
        if (postDateStats.dateNeedsReview > 0) {
          setMessage("Date enforcement found items requiring approval before grouping.");
          setTab("dates");
          return;
        }
      }
      await runEventGrouping();
      await refreshAll();
      setMessage("Event grouping complete.");
      if (navigateToEvents) {
        setTab("events");
      }
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
      setHasFinalizedSession(true);
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
      setHasFinalizedSession(false);
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
    if (hasFinalizedSession || (stats.total > 0 && stats.filed >= stats.total)) {
      return {
        label: "Start New Session",
        onClick: () => {
          setResetError("");
          setShowResetPrompt(true);
        },
        disabled: busyAction !== null
      };
    }
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
  }, [hasFinalizedSession, stats.total, stats.filed, stats.imagePhaseState, stats.videoPhaseState, stats.dateNeedsReview, busyAction]);
  const hasInitiatedIndexing = stats.total > 0 || pipelineStages.index !== "idle" || busyAction === "ingest";
  const dashboardActionLabel = hasFinalizedSession || (stats.total > 0 && stats.filed >= stats.total)
    ? "Start New Session"
    : hasInitiatedIndexing
      ? "Resume Organizing"
      : "Start Organizing";
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
  const loadingStateCopy = useMemo(() => {
    if (busyAction === "ingest") {
      return {
        message: "Indexing your media...",
        hint: "We are scanning and staging your files so the review phases can begin."
      };
    }
    if (busyAction === "image-review-scan") {
      return {
        message: "Preparing image review...",
        hint: "We are checking image quality and burst candidates."
      };
    }
    if (busyAction === "image-review-complete") {
      return {
        message: "Advancing to video review...",
        hint: "Saving image decisions and preparing the next phase."
      };
    }
    if (busyAction === "video-review") {
      return {
        message: "Updating video review...",
        hint: "Applying your include/exclude changes now."
      };
    }
    if (busyAction === "date-enforcement") {
      return {
        message: "Enforcing dates...",
        hint: "We are estimating and validating capture dates."
      };
    }
    if (busyAction === "group") {
      return {
        message: "Building event groups...",
        hint: "We are clustering items and preparing group names."
      };
    }
    if (busyAction === "finalize") {
      return {
        message: "Finalizing organization...",
        hint: "Moving files into final folders and wrapping up."
      };
    }
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
    if (previewItem.mimeType.startsWith("video/")) {
      setPreviewSrc(getVideoSrcUrl(previewItem.currentPath));
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
      {loadingStateCopy ? (
        <div className="loadingStateOverlay mica-surface bg-white/40 backdrop-blur-md" data-testid="global-loading-state">
          <LoadingState message={loadingStateCopy.message} hint={loadingStateCopy.hint} progress={pipelineProgress} />
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
                progressPercent={globalProgressPct}
                actionLabel={dashboardActionLabel}
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
            summary={`${dateItems.length} items are awaiting approval. Confirm the right date or skip to keep progress moving.`}
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
            summary={`${imageItems.filter((item) => item.status !== "excluded").length} active images in review. Keep the best shots and exclude anything you do not want grouped.`}
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
              setBusyAction("image-review-complete");
              try {
                await completeImageReviewAndStartVideoReview();
                await refreshAll();
                setTab("videos");
                setMessage("Image review complete. Proceeding to Video Review.");
              } finally {
                setBusyAction(null);
              }
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
            summary={`${videoItems.filter((item) => item.status !== "excluded").length} active videos in review. Remove unwanted clips before continuing to date checks.`}
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
              await onRunDateEnforcement();
              setMessage("Video review complete. Date enforcement complete.");
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
            summary={
              activeGroup
                ? `${activeGroup.itemCount} active items in this group. Move, exclude, or restore items before finalizing this event.`
                : `${groups.length} groups in review. Open each group to confirm the story and clean up outliers.`
            }
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
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
                <MotionPrimaryButton
                  data-testid="event-done-proceed-finalize"
                  className="primaryBtn"
                  disabled={busyAction !== null}
                  onClick={() => {
                    if (hasFinalizedSession) {
                      setTab("dashboard");
                      return;
                    }
                    void onFinalize();
                  }}
                >
                  {hasFinalizedSession ? "Back to Dashboard" : "Done - Proceed to Finalize"}
                </MotionPrimaryButton>
              </div>
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

          <section className="settingsSectionCard" data-testid="settings-section-home-location">
            <h4 className="settingsSectionTitle">Home Location</h4>
            <p className="settingsDescription">
              Setting a home location improves grouping by distinguishing local events from travel/vacation clusters.
            </p>
            <div className="settingsFormGrid">
              <div className="settingsField">
                <label htmlFor="home-address-input" className="fieldLabel settingsFieldLabel">Home Address / Area</label>
                <input
                  id="home-address-input"
                  data-testid="home-address-input"
                  className="settingsInput"
                  placeholder="Nashville, TN"
                  value={homeAddressInput}
                  onChange={(e) => setHomeAddressInput(e.target.value)}
                />
              </div>
              <div className="settingsField">
                <label htmlFor="home-label-input" className="fieldLabel settingsFieldLabel">Home Label (optional)</label>
                <input
                  id="home-label-input"
                  data-testid="home-label-input"
                  className="settingsInput"
                  placeholder="Home"
                  value={homeLabelInput}
                  onChange={(e) => setHomeLabelInput(e.target.value)}
                />
              </div>
              <div className="settingsField">
                <label htmlFor="home-radius-input" className="fieldLabel settingsFieldLabel">Home Radius (miles)</label>
                <input
                  id="home-radius-input"
                  data-testid="home-radius-input"
                  className="settingsInput"
                  type="number"
                  min="1"
                  placeholder="25"
                  value={homeRadiusInput}
                  onChange={(e) => setHomeRadiusInput(e.target.value)}
                />
              </div>
            </div>
            <div className="settingsActionRow">
              <MotionPrimaryButton
                data-testid="home-location-save-btn"
                className="primaryBtn"
                disabled={busyAction !== null}
                onClick={async () => {
                  if (!homeAddressInput.trim()) {
                    setHomeLocationStatus("Please enter an address or area.");
                    return;
                  }
                  setBusyAction("save-home-location");
                  try {
                    const result = await setHomeLocation(
                      homeAddressInput.trim(),
                      homeLabelInput.trim() || undefined,
                      homeRadiusInput ? Number(homeRadiusInput) : undefined
                    );
                    setHomeLocationStatus(
                      `Saved: ${result.addressRaw} (${result.latitude.toFixed(2)}, ${result.longitude.toFixed(2)})`
                    );
                    setMessage("Home location saved.");
                  } catch (err) {
                    setHomeLocationStatus(String(err));
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                {busyAction === "save-home-location" ? "Saving..." : "Save Home Location"}
              </MotionPrimaryButton>
              <button
                data-testid="home-location-clear-btn"
                className="secondaryBtn settingsModelClearBtn"
                disabled={busyAction !== null}
                onClick={async () => {
                  setBusyAction("clear-home-location");
                  try {
                    await clearHomeLocation();
                    setHomeAddressInput("");
                    setHomeLabelInput("");
                    setHomeRadiusInput("25");
                    setHomeLocationStatus("Not configured");
                    setMessage("Home location cleared.");
                  } catch (err) {
                    setHomeLocationStatus(`Clear failed: ${String(err)}`);
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                Clear
              </button>
            </div>
            <div className="settingsHomeLocationStatus" data-testid="home-location-status">
              {homeLocationStatus || "Not configured — grouping will work without home/away detection"}
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
              <h5 className="settingsSubgroupTitle">Date Estimation</h5>
              <ModelSelector
                label="Primary Model — Analyzes photos to estimate when they were taken"
                testPrefix="date-estimation"
                value={aiModels.dateEstimation}
                onChange={(next) => setAiModels((prev) => ({ ...prev, dateEstimation: next }))}
              />
              <ModelSelector
                label="Fallback Model — Used when the primary model fails or returns low confidence"
                testPrefix="date-estimation-fallback"
                value={aiModels.dateEstimationFallback}
                optional
                onChange={(next) => setAiModels((prev) => ({ ...prev, dateEstimationFallback: next }))}
                onClear={() => setAiModels((prev) => ({ ...prev, dateEstimationFallback: null }))}
              />
              <h5 className="settingsSubgroupTitle">Event Grouping and Naming</h5>
              <ModelSelector
                label="Cluster Analysis Model — Extracts scene, activity, and location clues from sample photos"
                testPrefix="grouping-pass1"
                value={aiModels.groupingPass1}
                optional
                onChange={(next) => setAiModels((prev) => ({ ...prev, groupingPass1: next }))}
                onClear={() => setAiModels((prev) => ({ ...prev, groupingPass1: null }))}
              />
              <ModelSelector
                label="Event Naming Model — Generates descriptive folder names from cluster analysis and photo context"
                testPrefix="event-naming"
                value={aiModels.eventNaming}
                onChange={(next) => setAiModels((prev) => ({ ...prev, eventNaming: next }))}
              />
              <ModelSelector
                label="Naming Fallback Model — Used when the naming model fails or returns a generic name"
                testPrefix="event-naming-fallback"
                value={aiModels.eventNamingFallback}
                optional
                onChange={(next) => setAiModels((prev) => ({ ...prev, eventNamingFallback: next }))}
                onClear={() => setAiModels((prev) => ({ ...prev, eventNamingFallback: null }))}
              />
              <h5 className="settingsSubgroupTitle">Image Review Quality</h5>
              <ModelSelector
                label="Quality Assessment Model — Evaluates borderline blur, classifies screenshots and memes"
                testPrefix="image-review"
                value={aiModels.imageReview}
                optional
                onChange={(next) => setAiModels((prev) => ({ ...prev, imageReview: next }))}
                onClear={() => setAiModels((prev) => ({ ...prev, imageReview: null }))}
              />
              <p className="settingsHelpText" data-testid="image-review-fallback-text">
                Falls back to Naming Fallback Model, then Event Naming Model when not configured.
              </p>
            </div>
            <div className="settingsActionRow">
              <button
                data-testid="settings-save-ai-models"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={async () => {
                  setBusyAction("save-ai-models");
                  try {
                    await setAiTaskModel("dateEstimation", aiModels.dateEstimation.provider as "openai" | "anthropic", aiModels.dateEstimation.model);
                    await setAiTaskModel("eventNaming", aiModels.eventNaming.provider as "openai" | "anthropic", aiModels.eventNaming.model);
                    const optionalSlots: Array<{
                      task: OptionalAiTaskName;
                      current: AiModelSelection | null;
                      previous: AiModelSelection | null;
                    }> = [
                      {
                        task: "dateEstimationFallback",
                        current: aiModels.dateEstimationFallback,
                        previous: savedAiModelsRef.current.dateEstimationFallback
                      },
                      {
                        task: "groupingPass1",
                        current: aiModels.groupingPass1,
                        previous: savedAiModelsRef.current.groupingPass1
                      },
                      {
                        task: "eventNamingFallback",
                        current: aiModels.eventNamingFallback,
                        previous: savedAiModelsRef.current.eventNamingFallback
                      },
                      {
                        task: "imageReview",
                        current: aiModels.imageReview,
                        previous: savedAiModelsRef.current.imageReview
                      }
                    ];
                    for (const slot of optionalSlots) {
                      if (slot.current) {
                        await setAiTaskModel(
                          slot.task,
                          slot.current.provider as "openai" | "anthropic",
                          slot.current.model
                        );
                      } else if (slot.previous) {
                        await clearAiTaskModel(slot.task);
                      }
                    }
                    savedAiModelsRef.current = normalizeAiTaskModels(aiModels);
                    setMessage("AI task models saved.");
                  } catch (err) {
                    setMessage(`Saving AI models failed: ${String(err)}`);
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                {busyAction === "save-ai-models" ? "Saving..." : "Save AI Models"}
              </button>
            </div>
          </section>

          {reviewSettings && (
          <section className="settingsSectionCard" data-testid="settings-section-image-review-thresholds">
            <h4 className="settingsSectionTitle">Image Review Thresholds</h4>
            <div className="settingsFormGrid">
              <label className="settingsLabel" htmlFor="threshold-blur">
                Blur Threshold (Laplacian variance below this = blurry)
              </label>
              <input
                id="threshold-blur"
                data-testid="threshold-blur"
                type="number"
                step="1"
                min="0"
                className="settingsInput"
                value={reviewSettings.blurThreshold}
                onChange={(e) => setReviewSettings({ ...reviewSettings, blurThreshold: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-blur-borderline">
                Blur Borderline % (± range sent to AI for confirmation)
              </label>
              <input
                id="threshold-blur-borderline"
                data-testid="threshold-blur-borderline"
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="settingsInput"
                value={reviewSettings.blurBorderlinePct}
                onChange={(e) => setReviewSettings({ ...reviewSettings, blurBorderlinePct: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-exposure-dark">
                Exposure Dark Pixel % (above this = underexposed)
              </label>
              <input
                id="threshold-exposure-dark"
                data-testid="threshold-exposure-dark"
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="settingsInput"
                value={reviewSettings.exposureDarkPct}
                onChange={(e) => setReviewSettings({ ...reviewSettings, exposureDarkPct: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-exposure-bright">
                Exposure Bright Pixel % (above this = overexposed)
              </label>
              <input
                id="threshold-exposure-bright"
                data-testid="threshold-exposure-bright"
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="settingsInput"
                value={reviewSettings.exposureBrightPct}
                onChange={(e) => setReviewSettings({ ...reviewSettings, exposureBrightPct: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-burst-window">
                Burst Time Window (seconds between consecutive shots)
              </label>
              <input
                id="threshold-burst-window"
                data-testid="threshold-burst-window"
                type="number"
                step="1"
                min="1"
                className="settingsInput"
                value={reviewSettings.burstTimeWindowSecs}
                onChange={(e) => setReviewSettings({ ...reviewSettings, burstTimeWindowSecs: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-burst-hash">
                Burst Hash Distance (max hamming distance for visual similarity)
              </label>
              <input
                id="threshold-burst-hash"
                data-testid="threshold-burst-hash"
                type="number"
                step="1"
                min="0"
                max="64"
                className="settingsInput"
                value={reviewSettings.burstHashDistance}
                onChange={(e) => setReviewSettings({ ...reviewSettings, burstHashDistance: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-duplicate-hash">
                Duplicate Hash Distance (max hamming distance for duplicates)
              </label>
              <input
                id="threshold-duplicate-hash"
                data-testid="threshold-duplicate-hash"
                type="number"
                step="1"
                min="0"
                max="64"
                className="settingsInput"
                value={reviewSettings.duplicateHashDistance}
                onChange={(e) => setReviewSettings({ ...reviewSettings, duplicateHashDistance: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-small-file">
                Minimum File Size (bytes)
              </label>
              <input
                id="threshold-small-file"
                data-testid="threshold-small-file"
                type="number"
                step="1024"
                min="0"
                className="settingsInput"
                value={reviewSettings.smallFileMinBytes}
                onChange={(e) => setReviewSettings({ ...reviewSettings, smallFileMinBytes: Number(e.target.value) })}
              />
              <label className="settingsLabel" htmlFor="threshold-screenshot">
                Screenshot Heuristic Threshold (score above this triggers AI classification)
              </label>
              <input
                id="threshold-screenshot"
                data-testid="threshold-screenshot"
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="settingsInput"
                value={reviewSettings.screenshotHeuristicThreshold}
                onChange={(e) => setReviewSettings({ ...reviewSettings, screenshotHeuristicThreshold: Number(e.target.value) })}
              />
            </div>
            <div className="settingsActionRow">
              <button
                data-testid="settings-save-review-thresholds"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={async () => {
                  setBusyAction("save-review-thresholds");
                  try {
                    await setImageReviewSettings(reviewSettings);
                    setMessage("Image review thresholds saved.");
                  } catch (err) {
                    setMessage(`Saving thresholds failed: ${String(err)}`);
                  } finally {
                    setBusyAction(null);
                  }
                }}
              >
                {busyAction === "save-review-thresholds" ? "Saving..." : "Save Thresholds"}
              </button>
              <button
                data-testid="settings-reset-review-thresholds"
                className="secondaryBtn"
                disabled={busyAction !== null}
                onClick={() => {
                  setReviewSettings({
                    blurThreshold: 50.0,
                    blurBorderlinePct: 0.2,
                    exposureDarkPct: 0.6,
                    exposureBrightPct: 0.6,
                    burstTimeWindowSecs: 3,
                    burstHashDistance: 10,
                    duplicateHashDistance: 5,
                    smallFileMinBytes: 512000,
                    screenshotHeuristicThreshold: 0.6,
                  });
                }}
              >
                Reset to Defaults
              </button>
            </div>
          </section>
          )}
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
  const [showPreview, setShowPreview] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const isVideo = item.mimeType.startsWith("video/");

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
        <button
          className="dateThumbButton"
          data-testid={`date-preview-btn-${item.mediaItemId}`}
          onClick={() => {
            if (isVideo && item.currentPath) {
              setPreviewSrc(getVideoSrcUrl(item.currentPath));
            } else {
              getEventGroupMediaPreview(item.mediaItemId)
                .then((src) => setPreviewSrc(src))
                .catch(() => setPreviewSrc(thumbSrc));
            }
            setShowPreview(true);
          }}
        >
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
          {isVideo && <span className="dateThumbPlayGlyph">▶</span>}
        </button>
        <div className="dateMetaStack">
          <strong className="truncateOneLine">{item.filename}</strong>
          <div className="muted">Current date: {item.currentDate ?? "(missing)"}</div>
          <div className="dateSuggestedLabel">{item.aiDate ? "AI Suggested Date" : "AI Could Not Determine Date"}</div>
          <div className="dateSuggestedValue">{item.aiDate ?? "Enter a date manually below"}</div>
          <div className="row">
            {item.aiDate && <span className={`dateConfidenceBadge ${confidenceClass}`}>Confidence {confidencePct}%</span>}
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
      {showPreview && (
        <div className="lightboxOverlay" data-testid={`date-preview-overlay-${item.mediaItemId}`} onClick={() => setShowPreview(false)}>
          <div className="lightboxCard" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{item.filename}</strong>
              <button className="secondaryBtn" data-testid={`date-preview-close-${item.mediaItemId}`} onClick={() => setShowPreview(false)}>Close</button>
            </div>
            {isVideo ? (
              <video data-testid={`date-preview-video-${item.mediaItemId}`} controls src={previewSrc ?? ""} style={{ width: "100%", maxHeight: "55vh", background: "#000" }} />
            ) : previewSrc ? (
              <img data-testid={`date-preview-image-${item.mediaItemId}`} src={previewSrc} alt={item.filename} style={{ width: "100%", maxHeight: "55vh", objectFit: "contain" }} />
            ) : (
              <div className="muted">Loading preview...</div>
            )}
          </div>
        </div>
      )}
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
      <div className="eventThumbImageWrap">
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
          {item.mimeType.startsWith("video/") && (
            <span data-testid={`event-media-play-glyph-${item.id}`} className="eventThumbPlayGlyph">▶</span>
          )}
        </button>
        {!showExcluded && (
          <div className="eventThumbOverlay">
            <button
              className="mediaTileIconButton"
              data-testid={`event-media-select-overlay-${item.id}`}
              onClick={(event) => onToggle(event.shiftKey)}
              aria-label={selected ? "Deselect" : "Select"}
            >
              <IconCheckCircle filled={selected} />
            </button>
            <button
              className="mediaTileIconButton mediaTileIconButtonDanger"
              data-testid={`event-media-remove-overlay-${item.id}`}
              onClick={() => setConfirmExclude(true)}
              aria-label="Remove"
            >
              <IconXCircle />
            </button>
          </div>
        )}
      </div>
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
            <div className="danger" style={{ fontSize: 11, marginBottom: 6 }}>Remove and move to recycle?</div>
            <div className="row" style={{ gap: 6 }}>
              <button
                data-testid={`event-media-exclude-confirm-yes-${item.id}`}
                className="secondaryBtn"
                onClick={() => {
                  void onExclude();
                  setConfirmExclude(false);
                }}
                style={{ width: "100%", minHeight: CARD_BUTTON_HEIGHT, borderColor: "#b91c1c", color: "#b91c1c" }}
              >
                Remove
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
              Remove
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
  const [viewMode, setViewMode] = useState<"all" | "flagged" | "burst" | "duplicate" | "screenshot">("flagged");
  const [sortMode, setSortMode] = useState<"date" | "size" | "sharpness">("date");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [previewById, setPreviewById] = useState<Record<number, string>>({});
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [showHelp, setShowHelp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [gridWidth, setGridWidth] = useState(0);
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
    if (viewMode === "duplicate") return sortedItems.filter((item) => item.duplicateGroupId);
    if (viewMode === "screenshot") return sortedItems.filter((item) => item.imageFlags.includes("screenshot_or_meme"));
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

  const duplicateGroups = useMemo(() => {
    const map = new Map<string, ImageReviewItem[]>();
    for (const item of visibleItems) {
      if (!item.duplicateGroupId) continue;
      const current = map.get(item.duplicateGroupId) ?? [];
      current.push(item);
      map.set(item.duplicateGroupId, current);
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
        setGridWidth(entry.contentRect.width);
        setColumnCount(calculateColumnCount(entry.contentRect.width, 180));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const imageTileSize = useMemo(() => {
    if (columnCount <= 0 || !Number.isFinite(gridWidth) || gridWidth <= 0) {
      return THUMBNAIL_SIZE;
    }
    const horizontalPadding = 24;
    const rowGap = 12;
    const usableWidth = Math.max(0, gridWidth - horizontalPadding - rowGap * Math.max(0, columnCount - 1));
    return Math.max(140, Math.floor(usableWidth / columnCount));
  }, [columnCount, gridWidth]);

  const rowCount = calculateRowCount(visibleItems.length, columnCount);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => imageTileSize + 12,
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

      <div className="reviewHelpSection" data-testid="image-review-help">
        <button className="reviewHelpToggle" data-testid="image-review-help-toggle" onClick={() => setShowHelp((prev) => !prev)}>
          {showHelp ? "Hide guide" : "How does this work?"}
        </button>
        {showHelp && (
          <div className="reviewHelpContent" data-testid="image-review-help-content">
            <p><strong>Active</strong> photos continue to the next pipeline stage. <strong>Excluded</strong> photos are moved to the recycle folder.</p>
            <ul>
              <li><strong>All Images</strong> &mdash; Everything currently in review.</li>
              <li><strong>Flagged Only</strong> &mdash; Items the AI flagged for your attention (blurry, too small, burst shots, duplicates, or screenshots).</li>
              <li><strong>Burst Groups</strong> &mdash; Rapid-fire shots grouped together. Pick the best from each burst.</li>
              <li><strong>Duplicates</strong> &mdash; Near-identical images detected by visual similarity.</li>
              <li><strong>Screenshots</strong> &mdash; Items classified as screenshots or memes.</li>
            </ul>
            <p>Use the <strong>Sort</strong> dropdown to order by Date, File Size, or Sharpness Score.</p>
          </div>
        )}
      </div>

      <ReviewToolbar
        testId="image-filter-bar"
        left={
          <div className="row">
            <button data-testid="image-filter-all" className={viewMode === "all" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("all")}>All Images</button>
            <button data-testid="image-filter-flagged" className={viewMode === "flagged" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("flagged")}>Flagged Only</button>
            <button data-testid="image-filter-burst" className={viewMode === "burst" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("burst")}>Burst Groups</button>
            <button data-testid="image-filter-duplicate" className={viewMode === "duplicate" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("duplicate")}>Duplicates</button>
            <button data-testid="image-filter-screenshot" className={viewMode === "screenshot" ? "primaryBtn" : "secondaryBtn"} onClick={() => setViewMode("screenshot")}>Screenshots</button>
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

      {viewMode === "burst" || viewMode === "duplicate" ? (
        <div data-testid={viewMode === "burst" ? "image-burst-groups-view" : "image-duplicate-groups-view"}>
          {Array.from((viewMode === "burst" ? burstGroups : duplicateGroups).entries()).map(([groupId, groupItems]) => (
            <div key={groupId} className="item" data-testid={viewMode === "burst" ? `image-burst-group-${groupId}` : `image-duplicate-group-${groupId}`}>
              <div className="row" style={{ gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                <div className="muted">
                  {viewMode === "burst"
                    ? `Burst group - ${groupItems.length} shots, best auto-selected`
                    : `Duplicate group - ${groupItems.length} similar images`}
                </div>
                <button data-testid={`image-keep-best-only-${groupId}`} className="secondaryBtn" onClick={() => void onKeepBestOnly(groupId)}>Keep Best Only</button>
                <button data-testid={`image-keep-all-${groupId}`} className="secondaryBtn" onClick={() => void onKeepAll(groupId)}>Keep All</button>
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
              const emptySlotCount = calculateEmptySlotsInRow(rowItems.length, columnCount);
              return (
                <div key={virtualRow.key} style={{ position: "absolute", top: virtualRow.start, left: 0, right: 0, display: "flex", gap: "12px", padding: "0 12px", boxSizing: "border-box" }}>
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
                  {emptySlotCount > 0 ? Array.from({ length: emptySlotCount }).map((_, index) => <div key={`i-empty-${virtualRow.index}-${index}`} style={{ flex: "1 1 0", minWidth: 0 }} />) : null}
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
            {modalItem.mimeType.startsWith("video/") ? (
              <video data-testid="image-preview-video" controls src={getVideoSrcUrl(modalItem.currentPath)} style={{ width: "100%", maxHeight: "55vh", background: "#000" }} />
            ) : previewById[modalItem.id] ? (
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
        {item.mimeType.startsWith("video/") && (
          <span data-testid={`image-play-glyph-${item.id}`} className="mediaTilePlayGlyphStatic">▶</span>
        )}
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
      </div>
      <div className="mediaTileOverlayBottom">
        <strong className="truncateOneLine">{item.filename}</strong>
        <div className="mediaTileMeta truncateOneLine">
          {formatFileSize(item.fileSizeBytes)} • {item.dateTaken ?? "(missing date)"}
          {item.blurScore != null ? ` • blur: ${item.blurScore.toFixed(0)}` : ""}
          {item.aiQualityScore != null ? ` • AI: ${item.aiQualityScore.toFixed(1)}/10` : ""}
        </div>
        <div className="mediaTileBadges">
          {item.imageFlags.includes("small_file") ? <span data-testid={`image-flag-small-${item.id}`} className="mediaTileBadge">small_file</span> : null}
          {item.imageFlags.includes("blurry") ? <span data-testid={`image-flag-blurry-${item.id}`} className="mediaTileBadge">blurry</span> : null}
          {item.imageFlags.includes("poor_exposure") ? <span data-testid={`image-flag-exposure-${item.id}`} className="mediaTileBadge">poor_exposure</span> : null}
          {item.imageFlags.includes("burst_shot") ? <span data-testid={`image-flag-burst-${item.id}`} className="mediaTileBadge">burst_shot</span> : null}
          {item.imageFlags.includes("duplicate") ? <span data-testid={`image-flag-duplicate-${item.id}`} className="mediaTileBadge">duplicate</span> : null}
          {item.imageFlags.includes("screenshot_or_meme") ? <span data-testid={`image-flag-screenshot-${item.id}`} className="mediaTileBadge">screenshot</span> : null}
          {item.isBurstPrimary ? <span data-testid={`image-flag-best-${item.id}`} className="mediaTileBadge mediaTileBadgeBest">Best</span> : null}
          {item.aiContentClass && item.aiContentClass !== "photo" ? <span data-testid={`image-flag-ai-class-${item.id}`} className="mediaTileBadge" title="AI classified">AI</span> : null}
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
  const [activeFilter, setActiveFilter] = useState<"size" | "duration">("duration");
  const [sizeThresholdMb, setSizeThresholdMb] = useState(5);
  const [durationThresholdSecs, setDurationThresholdSecs] = useState(10);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [removingIds, setRemovingIds] = useState<number[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [previewById, setPreviewById] = useState<Record<number, string>>({});
  const [inlinePlayingId, setInlinePlayingId] = useState<number | null>(null);
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [columnCount, setColumnCount] = useState(4);
  const [gridWidth, setGridWidth] = useState(0);
  const [scrollHeight, setScrollHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filtered = useMemo(() => {
    const statusFiltered = showExcluded
      ? items.filter((item) => item.status === "excluded")
      : items.filter((item) => item.status !== "excluded");

    const thresholded = showExcluded
      ? statusFiltered
      : statusFiltered.filter((item) => {
          const underSize = item.fileSizeBytes <= sizeThresholdMb * 1024 * 1024;
          const underDuration = item.durationSecs <= durationThresholdSecs;
          return activeFilter === "size" ? underSize : underDuration;
        });

    return [...thresholded].sort((a, b) =>
      activeFilter === "size"
        ? a.fileSizeBytes - b.fileSizeBytes
        : a.durationSecs - b.durationSecs
    );
  }, [items, sizeThresholdMb, durationThresholdSecs, activeFilter, showExcluded]);

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
        setGridWidth(entry.contentRect.width);
        setColumnCount(calculateColumnCount(entry.contentRect.width, MIN_ITEM_WIDTH));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const videoTileHeight = useMemo(() => {
    if (columnCount <= 0 || !Number.isFinite(gridWidth) || gridWidth <= 0) {
      return Math.round((THUMBNAIL_SIZE * 9) / 16);
    }
    const horizontalPadding = 24;
    const rowGap = 12;
    const usableWidth = Math.max(0, gridWidth - horizontalPadding - rowGap * Math.max(0, columnCount - 1));
    const tileWidth = Math.max(MIN_ITEM_WIDTH, Math.floor(usableWidth / columnCount));
    return Math.max(96, Math.round((tileWidth * 9) / 16));
  }, [columnCount, gridWidth]);

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
    estimateSize: () => videoTileHeight + 12,
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

  function getOrSetVideoPreview(item: VideoReviewItem): string {
    if (previewById[item.id]) return previewById[item.id];
    const src = getVideoSrcUrl(item.currentPath);
    setPreviewById((prev) => ({ ...prev, [item.id]: src }));
    return src;
  }

  function handleOpen(item: VideoReviewItem, index: number) {
    getOrSetVideoPreview(item);
    setInlinePlayingId(null);
    setModalIndex(index);
  }

  function handleHoverPlay(item: VideoReviewItem) {
    if (inlinePlayingId === item.id) return;
    getOrSetVideoPreview(item);
    setInlinePlayingId(item.id);
  }

  function handleHoverStop() {
    setInlinePlayingId(null);
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
                  style={{ position: "absolute", top: virtualRow.start, left: 0, right: 0, display: "flex", gap: "12px", padding: "0 12px", boxSizing: "border-box" }}
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
                        <button
                          data-testid={`video-open-${item.id}`}
                          className="mediaTileOpen"
                          onClick={() => handleOpen(item, startIndex + offset)}
                          onMouseEnter={() => handleHoverPlay(item)}
                          onMouseLeave={handleHoverStop}
                        >
                          {inlinePlayingId === item.id && previewSrc ? (
                            <video data-testid={`video-inline-player-${item.id}`} src={previewSrc} autoPlay muted loop playsInline className="mediaTileVideoAsset" />
                          ) : (
                            <>
                              <img className="mediaTileImage mediaTileImageVideo" src={thumbSrc} alt={item.filename} />
                              <span data-testid={`video-play-overlay-${item.id}`} className="mediaTilePlayGlyph">▶</span>
                            </>
                          )}
                        </button>
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
                        </div>
                        <div className="mediaTileOverlayBottom">
                          <strong className="truncateOneLine">{item.filename}</strong>
                          <div className="mediaTileMeta truncateOneLine">{formatFileSize(item.fileSizeBytes)} • {formatDuration(item.durationSecs)}</div>
                          {flagged ? <span className="mediaTileBadge">candidate</span> : null}
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

function createDefaultAiModels(): AiModelsState {
  return {
    dateEstimation: { provider: "anthropic", model: "claude-sonnet-4-6" },
    dateEstimationFallback: null,
    eventNaming: { provider: "anthropic", model: "claude-sonnet-4-6" },
    eventNamingFallback: null,
    groupingPass1: null,
    imageReview: null,
  };
}

function cloneAiModelSelection(value: AiModelSelection): AiModelSelection {
  return { provider: value.provider, model: value.model };
}

function normalizeAiModelSelection(value: unknown): AiModelSelection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const provider = (value as { provider?: unknown }).provider;
  const model = (value as { model?: unknown }).model;
  if (typeof provider !== "string" || typeof model !== "string") {
    return null;
  }
  const providerTrimmed = provider.trim();
  const modelTrimmed = model.trim();
  if (!providerTrimmed || !modelTrimmed) {
    return null;
  }
  return { provider: providerTrimmed, model: modelTrimmed };
}

function normalizeAiTaskModels(raw: Partial<AiModelsState> | AiModelsState | undefined): AiModelsState {
  const fallback = createDefaultAiModels();
  const dateEstimation = normalizeAiModelSelection(raw?.dateEstimation) ?? cloneAiModelSelection(fallback.dateEstimation);
  const eventNaming = normalizeAiModelSelection(raw?.eventNaming) ?? cloneAiModelSelection(fallback.eventNaming);
  return {
    dateEstimation,
    dateEstimationFallback: normalizeAiModelSelection(raw?.dateEstimationFallback),
    eventNaming,
    eventNamingFallback: normalizeAiModelSelection(raw?.eventNamingFallback),
    groupingPass1: normalizeAiModelSelection(raw?.groupingPass1),
    imageReview: normalizeAiModelSelection(raw?.imageReview),
  };
}

function ModelSelector({
  label,
  testPrefix,
  value,
  onChange,
  optional = false,
  onClear
}: {
  label: string;
  testPrefix: string;
  value: AiModelSelection | null;
  onChange: (value: AiModelSelection) => void;
  optional?: boolean;
  onClear?: () => void;
}) {
  const providerId = `${testPrefix}-provider`;
  const modelId = `${testPrefix}-model`;
  const isUnconfigured = optional && value === null;
  const activeValue = value ?? { provider: "anthropic", model: "" };
  return (
    <div className="settingsField settingsModelCard" data-testid={`model-selector-${testPrefix}`}>
      <label className="fieldLabel settingsFieldLabel" htmlFor={providerId}>
        {label}
        {optional ? <span className="settingsModelOptionalTag"> (Optional)</span> : null}
      </label>
      <select
        id={providerId}
        data-testid={`model-provider-${testPrefix}`}
        className="settingsInput"
        value={activeValue.provider}
        disabled={isUnconfigured}
        onChange={(e) => onChange({ ...activeValue, provider: e.target.value })}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input
        id={modelId}
        data-testid={`model-name-${testPrefix}`}
        className={`settingsInput${isUnconfigured ? " settingsModelUnconfigured" : ""}`}
        value={activeValue.model}
        disabled={isUnconfigured}
        onChange={(e) => onChange({ ...activeValue, model: e.target.value })}
        placeholder={isUnconfigured ? "Not configured" : "Model name"}
      />
      {isUnconfigured ? (
        <button
          type="button"
          data-testid={`model-configure-${testPrefix}`}
          className="secondaryBtn settingsInlineAction"
          onClick={() => onChange({ provider: "anthropic", model: "" })}
        >
          Configure
        </button>
      ) : optional ? (
        <button
          type="button"
          data-testid={`model-clear-${testPrefix}`}
          className="secondaryBtn settingsInlineAction settingsModelClearBtn"
          onClick={() => onClear?.()}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

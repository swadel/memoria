import type { Page } from "@playwright/test";

type BrowserFixtureProfile =
  | "all"
  | "settings-only"
  | "responsive"
  | "pre-video"
  | "pre-index"
  | "video-to-dates"
  | "finalize-busy"
  | "dashboard-video-only"
  | "phase-busy"
  | "reset-error"
  | "reset-slow"
  | "ingest-slow"
  | "complete"
  | "grouping-empty";

type DateEstimate = {
  mediaItemId: number;
  filename: string;
  currentDate: string | null;
  aiDate: string | null;
  confidence: number;
  reasoning: string;
  mimeType: string;
  currentPath: string | null;
};

type EventGroup = {
  id: number;
  year: number;
  name: string;
  folderName: string;
  itemCount: number;
  userApproved: boolean;
};

type EventGroupItem = {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
  status?: string;
};

type VideoReviewItem = {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
  fileSizeBytes: number;
  durationSecs: number;
  videoWidth: number | null;
  videoHeight: number | null;
  videoCodec: string | null;
  status: string;
};

type ImageReviewItem = {
  id: number;
  filename: string;
  currentPath: string;
  dateTaken: string | null;
  mimeType: string;
  fileSizeBytes: number;
  sharpnessScore: number | null;
  blurScore: number | null;
  perceptualHash: string | null;
  burstGroupId: string | null;
  isBurstPrimary: boolean;
  duplicateGroupId: string | null;
  exposureMean: number | null;
  aiQualityScore: number | null;
  aiContentClass: string | null;
  imageFlags: string[];
  status: string;
};

function buildState(profile: BrowserFixtureProfile) {
  const isIngestSlow = profile === "ingest-slow";
  const isGroupingEmpty = profile === "grouping-empty";
  const isPreIndex = profile === "pre-index";
  const isVideoToDates = profile === "video-to-dates";
  const isFinalizeBusy = profile === "finalize-busy";
  const isDashboardVideoOnly = profile === "dashboard-video-only";
  const dateItems: DateEstimate[] =
    profile === "settings-only" || isIngestSlow || isGroupingEmpty || isPreIndex || isVideoToDates || isFinalizeBusy || isDashboardVideoOnly
      ? []
      : [
          {
            mediaItemId: 301,
            filename: "date_review_fixture.png",
            currentDate: null,
            aiDate: "2026-03-11",
            confidence: 0.82,
            reasoning: "Fixture seeded date estimate",
            mimeType: "image/png",
            currentPath: "C:\\fixture\\output\\staging\\date_review_fixture.png"
          },
          {
            mediaItemId: 302,
            filename: "date_review_fixture_2.mov",
            currentDate: null,
            aiDate: "2026-03-12",
            confidence: 0.79,
            reasoning: "Fixture seeded date estimate 2",
            mimeType: "video/quicktime",
            currentPath: "C:\\fixture\\output\\staging\\date_review_fixture_2.mov"
          }
        ];

  const eventGroups: EventGroup[] =
    profile === "settings-only" || isIngestSlow || isGroupingEmpty || isPreIndex
      ? []
      : [
          {
            id: 401,
            year: 2026,
            name: "Ski Trip",
            folderName: "2026 - Ski Trip",
            itemCount: profile === "responsive" ? 11 : 2,
            userApproved: false
          }
        ];

  const eventGroupItemsByGroupId: Record<number, EventGroupItem[]> =
    profile === "settings-only" || isIngestSlow || isGroupingEmpty || isPreIndex
      ? {}
      : {
          401:
            profile === "responsive"
              ? Array.from({ length: 11 }).map((_, index) => {
                  const id = 901 + index;
                  return {
                    id,
                    filename: `ski_${String(index + 1).padStart(3, "0")}.png`,
                    currentPath: `C:\\fixture\\output\\staging\\ski_${String(index + 1).padStart(3, "0")}.png`,
                    dateTaken: `2026-01-${String(11 + index).padStart(2, "0")}`,
                    mimeType: "image/png",
                    status: "grouped"
                  };
                })
              : [
                  {
                    id: 901,
                    filename: "ski_001.png",
                    currentPath: "C:\\fixture\\output\\staging\\ski_001.png",
                    dateTaken: "2026-01-11",
                    mimeType: "image/png",
                    status: "grouped"
                  },
                  {
                    id: 902,
                    filename: "ski_002.png",
                    currentPath: "C:\\fixture\\output\\staging\\ski_002.png",
                    dateTaken: "2026-01-12",
                    mimeType: "image/png",
                    status: "grouped"
                  }
                ]
        };
  if (isDashboardVideoOnly) {
    eventGroupItemsByGroupId[401] = [
      {
        id: 9901,
        filename: "clip_001.mp4",
        currentPath: "C:\\fixture\\output\\staging\\clip_001.mp4",
        dateTaken: "2026-01-11",
        mimeType: "video/mp4",
        status: "grouped"
      },
      {
        id: 9902,
        filename: "clip_002.mov",
        currentPath: "C:\\fixture\\output\\staging\\clip_002.mov",
        dateTaken: "2026-01-12",
        mimeType: "video/quicktime",
        status: "grouped"
      }
    ];
  }

  const isComplete = profile === "complete";
  const stats = {
    total: isIngestSlow || isPreIndex ? 0 : 8,
    indexed: isPreIndex ? 0 : 2,
    imageReview: isComplete || isPreIndex ? 0 : 2,
    imageVerified: isPreIndex ? 0 : 4,
    dateReview: isComplete || isGroupingEmpty || isPreIndex || isVideoToDates || isFinalizeBusy || isDashboardVideoOnly ? 0 : profile === "pre-video" ? 0 : Math.max(1, dateItems.length),
    dateNeedsReview: isComplete || isGroupingEmpty || isPreIndex || isVideoToDates || isFinalizeBusy || isDashboardVideoOnly ? 0 : profile === "pre-video" ? Math.max(1, dateItems.length) : dateItems.length,
    dateVerified: isComplete ? 8 : isGroupingEmpty || isPreIndex ? 0 : 5,
    grouped: isComplete ? 8 : isGroupingEmpty || isPreIndex ? 0 : 2,
    filed: isComplete ? 8 : isPreIndex ? 0 : 1,
    imageFlaggedPending: isComplete || isPreIndex ? 0 : 2,
    imagePhaseState: (profile === "pre-video" || isIngestSlow || isPreIndex ? "pending" : "complete") as "pending" | "in_progress" | "complete",
    videoTotal: 3,
    videoFlagged: 2,
    videoExcluded: 1,
    videoUnreviewedFlagged: 2,
    videoPhaseState: (isComplete || isGroupingEmpty || isFinalizeBusy || isDashboardVideoOnly ? "complete" : profile === "pre-video" || isIngestSlow || isPreIndex ? "pending" : "in_progress") as "pending" | "in_progress" | "complete"
  };
  if (isVideoToDates) {
    stats.imagePhaseState = "complete";
    stats.videoPhaseState = "in_progress";
  }
  if (isFinalizeBusy) {
    stats.imagePhaseState = "complete";
    stats.videoPhaseState = "complete";
  }

  const imageItems: ImageReviewItem[] = [
    {
      id: 501,
      filename: "burst_001.jpg",
      currentPath: "C:\\fixture\\output\\staging\\burst_001.jpg",
      dateTaken: "2026-03-01 10:00:00",
      mimeType: "image/jpeg",
      fileSizeBytes: 420_000,
      sharpnessScore: 82.5,
      blurScore: 0.35,
      perceptualHash: "a1b2c3d4e5f60001",
      burstGroupId: "burst-a",
      isBurstPrimary: false,
      duplicateGroupId: null,
      exposureMean: 0.48,
      aiQualityScore: null,
      aiContentClass: null,
      imageFlags: ["small_file", "burst_shot"],
      status: "indexed"
    },
    {
      id: 502,
      filename: "burst_002.jpg",
      currentPath: "C:\\fixture\\output\\staging\\burst_002.jpg",
      dateTaken: "2026-03-01 10:00:02",
      mimeType: "image/jpeg",
      fileSizeBytes: 530_000,
      sharpnessScore: 132.8,
      blurScore: 0.12,
      perceptualHash: "a1b2c3d4e5f60002",
      burstGroupId: "burst-a",
      isBurstPrimary: true,
      duplicateGroupId: null,
      exposureMean: 0.52,
      aiQualityScore: null,
      aiContentClass: null,
      imageFlags: [],
      status: "indexed"
    },
    {
      id: 503,
      filename: "blurry_001.jpg",
      currentPath: "C:\\fixture\\output\\staging\\blurry_001.jpg",
      dateTaken: "2026-03-02 11:20:00",
      mimeType: "image/jpeg",
      fileSizeBytes: 1_500_000,
      sharpnessScore: 42.2,
      blurScore: 0.78,
      perceptualHash: "ff00ff00ff00ff00",
      burstGroupId: null,
      isBurstPrimary: false,
      duplicateGroupId: null,
      exposureMean: 0.45,
      aiQualityScore: null,
      aiContentClass: null,
      imageFlags: ["blurry"],
      status: "indexed"
    },
    {
      id: 505,
      filename: "clip_review.mov",
      currentPath: "C:\\fixture\\output\\staging\\clip_review.mov",
      dateTaken: "2026-03-02 12:00:00",
      mimeType: "video/quicktime",
      fileSizeBytes: 2_400_000,
      sharpnessScore: null,
      blurScore: null,
      perceptualHash: null,
      burstGroupId: null,
      isBurstPrimary: false,
      duplicateGroupId: null,
      exposureMean: null,
      aiQualityScore: null,
      aiContentClass: null,
      imageFlags: [],
      status: "indexed"
    },
    {
      id: 504,
      filename: "excluded_001.jpg",
      currentPath: "C:\\fixture\\output\\recycle\\excluded_001.jpg",
      dateTaken: "2026-03-02 11:20:05",
      mimeType: "image/jpeg",
      fileSizeBytes: 460_000,
      sharpnessScore: 65.0,
      blurScore: 0.22,
      perceptualHash: "0011223344556677",
      burstGroupId: null,
      isBurstPrimary: false,
      duplicateGroupId: null,
      exposureMean: 0.50,
      aiQualityScore: null,
      aiContentClass: null,
      imageFlags: ["small_file"],
      status: "excluded"
    }
  ];

  const videoItems: VideoReviewItem[] = [
    {
      id: 601,
      filename: "live_clip.mov",
      currentPath: "C:\\fixture\\output\\staging\\live_clip.mov",
      dateTaken: "2026-03-10",
      mimeType: "video/quicktime",
      fileSizeBytes: 1_200_000,
      durationSecs: 3,
      videoWidth: 1080,
      videoHeight: 1920,
      videoCodec: "h264",
      status: "image_reviewed"
    },
    {
      id: 602,
      filename: "trip_video.mp4",
      currentPath: "C:\\fixture\\output\\staging\\trip_video.mp4",
      dateTaken: "2026-03-11",
      mimeType: "video/mp4",
      fileSizeBytes: 18_000_000,
      durationSecs: 84,
      videoWidth: 1920,
      videoHeight: 1080,
      videoCodec: "h264",
      status: "image_reviewed"
    },
    {
      id: 603,
      filename: "excluded_clip.mov",
      currentPath: "C:\\fixture\\output\\recycle\\excluded_clip.mov",
      dateTaken: "2026-03-11",
      mimeType: "video/quicktime",
      fileSizeBytes: 800_000,
      durationSecs: 2,
      videoWidth: 1080,
      videoHeight: 1920,
      videoCodec: "h264",
      status: "excluded"
    }
  ];

  return {
    config: {
      workingDirectory: "C:\\fixture\\inbox",
      outputDirectory: "C:\\fixture\\output",
      aiTaskModels: {
        dateEstimation: { provider: "anthropic", model: "claude-sonnet-4-6" },
        dateEstimationFallback: null,
        eventNaming: { provider: "anthropic", model: "claude-sonnet-4-6" },
        eventNamingFallback: null,
        groupingPass1: null,
        imageReview: null
      },
      homeLocation: null as { addressRaw: string; label: string | null; latitude: number; longitude: number; radiusMiles: number } | null
    },
    stats,
    dateItems,
    eventGroups,
    eventGroupItemsByGroupId,
    imageItems,
    videoItems,
    imageReviewSettings: {
      blurThreshold: 0.6,
      blurBorderlinePct: 0.15,
      exposureDarkPct: 0.05,
      exposureBrightPct: 0.95,
      burstTimeWindowSecs: 3,
      burstHashDistance: 10,
      duplicateHashDistance: 5,
      smallFileMinBytes: 512000,
      screenshotHeuristicThreshold: 0.6
    },
    nextGroupId: 402,
    resetBehavior: profile === "reset-error" ? "error" : profile === "reset-slow" ? "slow" : "normal",
    ingestBehavior: isIngestSlow ? "slow" : "normal"
  };
}

export async function installBrowserApiMock(page: Page, profile: BrowserFixtureProfile = "all") {
  const tinyPngDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4zwAAAQIBAqdpws8AAAAASUVORK5CYII=";
  await page.addInitScript(
    ({ stateBuilderSource }) => {
      (window as any).__MEMORIA_BUILD_STATE__ = new Function(`return (${stateBuilderSource});`)();
    },
    { stateBuilderSource: buildState.toString() }
  );

  await page.addInitScript(
    ({ fixtureProfile, tinyPngDataUrl }) => {
      const state = (function createState() {
        const build = (window as any).__MEMORIA_BUILD_STATE__;
        return build ? build(fixtureProfile) : null;
      })();
      if (!state) return;
      const delayed = (value: unknown, ms = 320) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
      const withPhaseDelay = (value: unknown) =>
        fixtureProfile === "phase-busy" || fixtureProfile === "video-to-dates" || fixtureProfile === "finalize-busy"
          ? delayed(value)
          : Promise.resolve(value);

      (window as any).__MEMORIA_TEST_API__ = {
        invoke(command: string, args?: Record<string, unknown>) {
          switch (command) {
            case "initialize_app":
              return Promise.resolve();
            case "get_app_configuration":
              return Promise.resolve(state.config);
            case "get_dashboard_stats":
              return Promise.resolve(state.stats);
            case "get_tool_health":
              return Promise.resolve({
                exiftoolAvailable: true,
                exiftoolPath: "C:\\fixture\\vendor\\exiftool.exe",
                ffmpegAvailable: true,
                ffmpegPath: "C:\\fixture\\vendor\\ffmpeg.exe"
              });
            case "get_date_review_queue":
              return Promise.resolve(state.dateItems);
            case "get_date_media_thumbnail":
              return Promise.resolve(tinyPngDataUrl);
            case "get_event_groups":
              return Promise.resolve(state.eventGroups);
            case "get_event_group_items": {
              const groupId = Number(args?.groupId ?? args?.group_id ?? -1);
              const showExcluded = Boolean(args?.showExcluded ?? args?.show_excluded);
              const items = state.eventGroupItemsByGroupId[groupId] ?? [];
              return Promise.resolve(
                items.filter((item: EventGroupItem) => (showExcluded ? item.status === "excluded" : item.status !== "excluded"))
              );
            }
            case "get_event_group_media_preview":
              return Promise.resolve(tinyPngDataUrl);
            case "get_video_review_items": {
              const includeExcluded = Boolean(args?.includeExcluded ?? args?.include_excluded);
              return Promise.resolve(
                state.videoItems.filter((item: VideoReviewItem) =>
                  includeExcluded ? ["image_reviewed", "excluded"].includes(item.status) : item.status === "image_reviewed"
                )
              );
            }
            case "get_image_review_items": {
              const includeExcluded = Boolean(args?.includeExcluded ?? args?.include_excluded);
              return Promise.resolve(
                state.imageItems.filter((item: ImageReviewItem) =>
                  includeExcluded ? ["indexed", "image_reviewed", "excluded"].includes(item.status) : ["indexed", "image_reviewed"].includes(item.status)
                )
              );
            }
            case "set_working_directory":
              state.config.workingDirectory = String(args?.path ?? state.config.workingDirectory);
              return Promise.resolve();
            case "set_output_directory":
              state.config.outputDirectory = String(args?.path ?? state.config.outputDirectory);
              return Promise.resolve();
            case "set_home_location": {
              const address = String(args?.address ?? "").trim();
              if (!address) return Promise.reject(new Error("Home address cannot be empty."));
              const result = {
                addressRaw: address,
                label: args?.label ? String(args.label) : null,
                latitude: 36.16,
                longitude: -86.78,
                radiusMiles: Number(args?.radiusMiles ?? args?.radius_miles ?? 25)
              };
              state.config.homeLocation = result;
              return Promise.resolve(result);
            }
            case "clear_home_location":
              state.config.homeLocation = null;
              return Promise.resolve();
            case "start_download_session":
              if (state.ingestBehavior === "slow") {
                return new Promise((resolve) =>
                  setTimeout(() => {
                    state.stats = {
                      ...state.stats,
                      total: 8,
                      indexed: 2
                    };
                    resolve(undefined);
                  }, 350)
                );
              }
              return Promise.resolve();
            case "set_openai_key":
            case "set_anthropic_key":
            case "set_ai_task_model":
            case "clear_ai_task_model":
            case "run_event_grouping":
              if (command === "set_ai_task_model") {
                const task = String(args?.task ?? "");
                const provider = String(args?.provider ?? "");
                const model = String(args?.model ?? "");
                const next = { provider, model };
                if (task === "dateEstimation") state.config.aiTaskModels.dateEstimation = next;
                if (task === "dateEstimationFallback") state.config.aiTaskModels.dateEstimationFallback = next;
                if (task === "eventNaming") state.config.aiTaskModels.eventNaming = next;
                if (task === "eventNamingFallback") state.config.aiTaskModels.eventNamingFallback = next;
                if (task === "groupingPass1") state.config.aiTaskModels.groupingPass1 = next;
                if (task === "imageReview") state.config.aiTaskModels.imageReview = next;
              }
              if (command === "clear_ai_task_model") {
                const task = String(args?.task ?? "");
                if (task === "dateEstimationFallback") {
                  if (!state.config.aiTaskModels.dateEstimationFallback) {
                    return Promise.reject(new Error("dateEstimationFallback is not configured"));
                  }
                  state.config.aiTaskModels.dateEstimationFallback = null;
                }
                if (task === "eventNamingFallback") {
                  if (!state.config.aiTaskModels.eventNamingFallback) {
                    return Promise.reject(new Error("eventNamingFallback is not configured"));
                  }
                  state.config.aiTaskModels.eventNamingFallback = null;
                }
                if (task === "groupingPass1") {
                  if (!state.config.aiTaskModels.groupingPass1) {
                    return Promise.reject(new Error("groupingPass1 is not configured"));
                  }
                  state.config.aiTaskModels.groupingPass1 = null;
                }
                if (task === "imageReview") {
                  if (!state.config.aiTaskModels.imageReview) {
                    return Promise.reject(new Error("imageReview is not configured"));
                  }
                  state.config.aiTaskModels.imageReview = null;
                }
              }
              if (fixtureProfile === "grouping-empty" && state.eventGroups.length === 0) {
                state.eventGroups = [
                  {
                    id: 777,
                    year: 2026,
                    name: "Auto Grouped Event",
                    folderName: "2026 - Auto Grouped Event",
                    itemCount: 3,
                    userApproved: false
                  }
                ];
                state.eventGroupItemsByGroupId = {
                  777: [
                    {
                      id: 9701,
                      filename: "grouped_a.jpg",
                      currentPath: "C:\\fixture\\output\\organized\\2026 - Auto Grouped Event\\grouped_a.jpg",
                      dateTaken: "2026-03-01",
                      mimeType: "image/jpeg",
                      status: "grouped"
                    },
                    {
                      id: 9702,
                      filename: "grouped_b.jpg",
                      currentPath: "C:\\fixture\\output\\organized\\2026 - Auto Grouped Event\\grouped_b.jpg",
                      dateTaken: "2026-03-01",
                      mimeType: "image/jpeg",
                      status: "grouped"
                    },
                    {
                      id: 9703,
                      filename: "grouped_c.mp4",
                      currentPath: "C:\\fixture\\output\\organized\\2026 - Auto Grouped Event\\grouped_c.mp4",
                      dateTaken: "2026-03-01",
                      mimeType: "video/mp4",
                      status: "grouped"
                    }
                  ]
                };
                state.stats = { ...state.stats, grouped: 3 };
              }
              return withPhaseDelay(undefined);
            case "finalize_organization":
              return withPhaseDelay(undefined);
            case "run_image_review_scan":
              return withPhaseDelay(undefined);
            case "run_date_enforcement":
              if (fixtureProfile === "grouping-empty") {
                state.stats = { ...state.stats, dateVerified: 8, dateNeedsReview: 0 };
              } else if (fixtureProfile === "video-to-dates") {
                state.dateItems = [
                  {
                    mediaItemId: 3301,
                    filename: "date_needed_after_video_1.jpg",
                    currentDate: null,
                    aiDate: "2026-05-11",
                    confidence: 0.86,
                    reasoning: "Fixture created after date enforcement",
                    mimeType: "image/jpeg",
                    currentPath: "C:\\fixture\\output\\staging\\date_needed_after_video_1.jpg"
                  },
                  {
                    mediaItemId: 3302,
                    filename: "date_needed_after_video_2.jpg",
                    currentDate: null,
                    aiDate: "2026-05-12",
                    confidence: 0.81,
                    reasoning: "Fixture created after date enforcement",
                    mimeType: "image/jpeg",
                    currentPath: "C:\\fixture\\output\\staging\\date_needed_after_video_2.jpg"
                  }
                ];
                state.stats = {
                  ...state.stats,
                  dateNeedsReview: 2,
                  dateReview: 2,
                  dateVerified: 6
                };
              }
              return withPhaseDelay(undefined);
            case "complete_image_review_and_start_video_review":
              state.stats.imagePhaseState = "complete";
              state.stats.videoPhaseState = "in_progress";
              state.stats.imageFlaggedPending = 0;
              state.imageItems = state.imageItems.map((item: ImageReviewItem) =>
                item.status === "indexed" ? { ...item, status: "image_reviewed", imageFlags: [] } : item
              );
              return withPhaseDelay(undefined);
            case "complete_video_review_and_run_grouping":
              state.stats.videoPhaseState = "complete";
              return withPhaseDelay(undefined);
            case "exclude_videos": {
              const ids = (args?.mediaItemIds ?? args?.media_item_ids ?? []) as number[];
              state.videoItems = state.videoItems.map((item: VideoReviewItem) =>
                ids.includes(item.id) ? { ...item, status: "excluded", currentPath: item.currentPath.replace("\\staging\\", "\\recycle\\") } : item
              );
              state.stats.videoExcluded = state.videoItems.filter((item: VideoReviewItem) => item.status === "excluded").length;
              state.stats.videoFlagged = state.videoItems.filter((item: VideoReviewItem) => item.status === "image_reviewed" && (item.fileSizeBytes <= 5 * 1024 * 1024 || item.durationSecs <= 10)).length;
              state.stats.videoUnreviewedFlagged = state.stats.videoFlagged;
              return withPhaseDelay(ids.length);
            }
            case "restore_videos": {
              const ids = (args?.mediaItemIds ?? args?.media_item_ids ?? []) as number[];
              state.videoItems = state.videoItems.map((item: VideoReviewItem) =>
                ids.includes(item.id) ? { ...item, status: "image_reviewed", currentPath: item.currentPath.replace("\\recycle\\", "\\staging\\") } : item
              );
              state.stats.videoExcluded = state.videoItems.filter((item: VideoReviewItem) => item.status === "excluded").length;
              state.stats.videoFlagged = state.videoItems.filter((item: VideoReviewItem) => item.status === "image_reviewed" && (item.fileSizeBytes <= 5 * 1024 * 1024 || item.durationSecs <= 10)).length;
              state.stats.videoUnreviewedFlagged = state.stats.videoFlagged;
              return withPhaseDelay(ids.length);
            }
            case "keep_best_only": {
              const burstGroupId = String(args?.burstGroupId ?? args?.burst_group_id ?? "");
              let moved = 0;
              state.imageItems = state.imageItems.map((item: ImageReviewItem) => {
                if (item.burstGroupId !== burstGroupId || item.isBurstPrimary) return item;
                moved += 1;
                return { ...item, status: "excluded", currentPath: item.currentPath.replace("\\staging\\", "\\recycle\\") };
              });
              return Promise.resolve(moved);
            }
            case "keep_all_burst": {
              const burstGroupId = String(args?.burstGroupId ?? args?.burst_group_id ?? "");
              state.imageItems = state.imageItems.map((item: ImageReviewItem) =>
                item.burstGroupId === burstGroupId ? { ...item, status: "image_reviewed", imageFlags: [] } : item
              );
              state.stats.imageFlaggedPending = state.imageItems.filter((item: ImageReviewItem) => item.status === "indexed" && item.imageFlags.length > 0).length;
              return Promise.resolve();
            }
            case "exclude_media_item": {
              const id = Number(args?.mediaItemId ?? args?.media_item_id ?? -1);
              state.imageItems = state.imageItems.map((item: ImageReviewItem) =>
                item.id === id ? { ...item, status: "excluded", currentPath: item.currentPath.replace("\\staging\\", "\\recycle\\") } : item
              );
              for (const group of state.eventGroups as EventGroup[]) {
                const items = state.eventGroupItemsByGroupId[group.id] ?? [];
                for (const item of items) {
                  if (item.id === id) item.status = "excluded";
                }
                group.itemCount = items.filter((item: EventGroupItem) => item.status !== "excluded").length;
              }
              return Promise.resolve();
            }
            case "restore_media_item": {
              const id = Number(args?.mediaItemId ?? args?.media_item_id ?? -1);
              state.imageItems = state.imageItems.map((item: ImageReviewItem) =>
                item.id === id ? { ...item, status: "indexed", currentPath: item.currentPath.replace("\\recycle\\", "\\staging\\") } : item
              );
              for (const group of state.eventGroups as EventGroup[]) {
                const items = state.eventGroupItemsByGroupId[group.id] ?? [];
                for (const item of items) {
                  if (item.id === id) item.status = "grouped";
                }
                group.itemCount = items.filter((item: EventGroupItem) => item.status !== "excluded").length;
              }
              return Promise.resolve();
            }
            case "exclude_media_items": {
              const ids = (args?.mediaItemIds ?? args?.media_item_ids ?? []) as number[];
              state.imageItems = state.imageItems.map((item: ImageReviewItem) =>
                ids.includes(item.id) ? { ...item, status: "excluded", currentPath: item.currentPath.replace("\\staging\\", "\\recycle\\") } : item
              );
              for (const group of state.eventGroups as EventGroup[]) {
                const items = state.eventGroupItemsByGroupId[group.id] ?? [];
                for (const item of items) {
                  if (ids.includes(item.id)) item.status = "excluded";
                }
                group.itemCount = items.filter((item: EventGroupItem) => item.status !== "excluded").length;
              }
              return Promise.resolve(ids.length);
            }
            case "reset_session":
              if (state.resetBehavior === "error") {
                return Promise.reject(new Error("no such table: main.media_items_old"));
              }
              if (state.resetBehavior === "slow") {
                return new Promise((resolve) =>
                  setTimeout(
                    () => {
                      state.dateItems = [];
                      state.eventGroups = [];
                      state.stats = {
                        ...state.stats,
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
                      resolve({
                        deletedGeneratedFiles: Boolean(args?.deleteGeneratedFiles),
                        removedDirectories: Boolean(args?.deleteGeneratedFiles) ? ["staging", "organized", "recycle"] : []
                      });
                    },
                    350
                  )
                );
              }
              state.dateItems = [];
              state.eventGroups = [];
              state.stats = {
                ...state.stats,
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
              return Promise.resolve({
                deletedGeneratedFiles: Boolean(args?.deleteGeneratedFiles),
                removedDirectories: Boolean(args?.deleteGeneratedFiles) ? ["staging", "organized", "recycle"] : []
              });
            case "apply_date_approval": {
              const id = Number(args?.mediaItemId ?? args?.media_item_id ?? -1);
              state.dateItems = state.dateItems.filter((item: DateEstimate) => item.mediaItemId !== id);
              state.stats.dateNeedsReview = state.dateItems.length;
              state.stats.dateVerified += 1;
              return Promise.resolve();
            }
            case "rename_event_group": {
              const id = Number(args?.groupId ?? args?.group_id ?? -1);
              const name = String(args?.name ?? "");
              const exists = state.eventGroups.some(
                (group: EventGroup) => group.id !== id && group.name.trim().toLowerCase() === name.trim().toLowerCase()
              );
              if (exists) {
                return Promise.reject(new Error("A group with this name already exists"));
              }
              state.eventGroups = state.eventGroups.map((group: EventGroup) =>
                group.id === id ? { ...group, name, folderName: `${group.year} - ${name}` } : group
              );
              return Promise.resolve();
            }
            case "create_event_group": {
              const name = String(args?.name ?? "").trim();
              const exists = state.eventGroups.some(
                (group: EventGroup) => group.name.trim().toLowerCase() === name.toLowerCase()
              );
              if (exists) {
                return Promise.reject(new Error("A group with this name already exists"));
              }
              const group: EventGroup = {
                id: state.nextGroupId++,
                year: 2026,
                name,
                folderName: `2026 - ${name}`,
                itemCount: 0,
                userApproved: true
              };
              state.eventGroups = [...state.eventGroups, group];
              state.eventGroupItemsByGroupId[group.id] = [];
              return Promise.resolve(group);
            }
            case "delete_event_group": {
              const groupId = Number(args?.groupId ?? args?.group_id ?? -1);
              const items = state.eventGroupItemsByGroupId[groupId] ?? [];
              if (items.length > 0) {
                return Promise.reject(new Error("Cannot delete a group that still has items"));
              }
              state.eventGroups = state.eventGroups.filter((group: EventGroup) => group.id !== groupId);
              delete state.eventGroupItemsByGroupId[groupId];
              return Promise.resolve();
            }
            case "move_event_group_items": {
              const ids = (args?.mediaItemIds ?? args?.media_item_ids ?? []) as number[];
              const destinationGroupId = Number(args?.destinationGroupId ?? args?.destination_group_id ?? -1);
              const destinationItems = state.eventGroupItemsByGroupId[destinationGroupId] ?? [];
              const moving: EventGroupItem[] = [];
              for (const group of state.eventGroups as EventGroup[]) {
                const currentItems = state.eventGroupItemsByGroupId[group.id] ?? [];
                const retained = currentItems.filter((item: EventGroupItem) => {
                  if (ids.includes(item.id)) {
                    moving.push(item);
                    return false;
                  }
                  return true;
                });
                state.eventGroupItemsByGroupId[group.id] = retained;
                group.itemCount = retained.filter((item: EventGroupItem) => item.status !== "excluded").length;
              }
              state.eventGroupItemsByGroupId[destinationGroupId] = [...destinationItems, ...moving];
              state.eventGroups = state.eventGroups.map((group: EventGroup) =>
                group.id === destinationGroupId
                  ? {
                      ...group,
                      itemCount: state.eventGroupItemsByGroupId[destinationGroupId].filter((item: EventGroupItem) => item.status !== "excluded").length
                    }
                  : group
              );
              return Promise.resolve();
            }
            case "create_event_group_and_move": {
              const name = String(args?.name ?? "").trim();
              const ids = (args?.mediaItemIds ?? args?.media_item_ids ?? []) as number[];
              const exists = state.eventGroups.some(
                (group: EventGroup) => group.name.trim().toLowerCase() === name.toLowerCase()
              );
              if (exists) {
                return Promise.reject(new Error("A group with this name already exists"));
              }
              const group: EventGroup = {
                id: state.nextGroupId++,
                year: 2026,
                name,
                folderName: `2026 - ${name}`,
                itemCount: 0,
                userApproved: true
              };
              state.eventGroups = [...state.eventGroups, group];
              state.eventGroupItemsByGroupId[group.id] = [];
              const destinationItems = state.eventGroupItemsByGroupId[group.id];
              for (const source of state.eventGroups as EventGroup[]) {
                if (source.id === group.id) continue;
                const currentItems = state.eventGroupItemsByGroupId[source.id] ?? [];
                const retained = currentItems.filter((item: EventGroupItem) => {
                  if (ids.includes(item.id)) {
                    destinationItems.push(item);
                    return false;
                  }
                  return true;
                });
                state.eventGroupItemsByGroupId[source.id] = retained;
                source.itemCount = retained.filter((item: EventGroupItem) => item.status !== "excluded").length;
              }
              group.itemCount = destinationItems.filter((item: EventGroupItem) => item.status !== "excluded").length;
              return Promise.resolve(group);
            }
            case "get_image_review_settings":
              return Promise.resolve(state.imageReviewSettings);
            case "set_image_review_settings": {
              const settings = args?.settings as Record<string, unknown> | undefined;
              if (settings) {
                state.imageReviewSettings = { ...state.imageReviewSettings, ...settings };
              }
              return Promise.resolve();
            }
            default:
              return Promise.reject(new Error(`Unknown mocked command: ${command}`));
          }
        }
      };
    },
    { fixtureProfile: profile, tinyPngDataUrl }
  );
}

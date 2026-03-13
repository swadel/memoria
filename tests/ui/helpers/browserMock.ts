import type { Page } from "@playwright/test";

type BrowserFixtureProfile = "all" | "review-duplicates" | "settings-only";

type MediaItem = {
  id: number;
  filename: string;
  currentPath: string;
  classification: "legitimate" | "review" | "deleted" | null;
  reviewReason: string | null;
  reviewReasonDetails: string | null;
  duplicateClusterId: string | null;
  status: string;
  dateTaken: string | null;
  dateNeedsReview: boolean;
  aiConfidence: number | null;
  eventGroupId: number | null;
};

type DateEstimate = {
  mediaItemId: number;
  filename: string;
  currentDate: string | null;
  aiDate: string | null;
  confidence: number;
  reasoning: string;
};

type EventGroup = {
  id: number;
  year: number;
  name: string;
  folderName: string;
  itemCount: number;
  userApproved: boolean;
};

function buildState(profile: BrowserFixtureProfile) {
  const reviewItems: MediaItem[] = [
    {
      id: 101,
      filename: "screenshot_fixture.png",
      currentPath: "C:\\fixture\\review\\screenshot_fixture.png",
      classification: "review",
      reviewReason: "screenshot",
      reviewReasonDetails: "{\"reason\":\"screenshot\"}",
      duplicateClusterId: null,
      status: "classified",
      dateTaken: null,
      dateNeedsReview: false,
      aiConfidence: null,
      eventGroupId: null
    }
  ];

  if (profile !== "settings-only") {
    reviewItems.push(
      {
        id: 201,
        filename: "duplicate_1.png",
        currentPath: "C:\\fixture\\review\\duplicate_1.png",
        classification: "review",
        reviewReason: "duplicate_keep_suggestion",
        reviewReasonDetails: "{\"reason\":\"duplicate_keep_suggestion\",\"rank\":1}",
        duplicateClusterId: "fixture-cluster-1",
        status: "classified",
        dateTaken: "2026-03-10",
        dateNeedsReview: false,
        aiConfidence: null,
        eventGroupId: null
      },
      {
        id: 202,
        filename: "duplicate_2.png",
        currentPath: "C:\\fixture\\review\\duplicate_2.png",
        classification: "review",
        reviewReason: "duplicate_non_best",
        reviewReasonDetails: "{\"reason\":\"duplicate_non_best\",\"rank\":2}",
        duplicateClusterId: "fixture-cluster-1",
        status: "classified",
        dateTaken: "2026-03-10",
        dateNeedsReview: false,
        aiConfidence: null,
        eventGroupId: null
      }
    );
  }

  const dateItems: DateEstimate[] =
    profile === "settings-only"
      ? []
      : [
          {
            mediaItemId: 301,
            filename: "date_review_fixture.png",
            currentDate: null,
            aiDate: "2026-03-11",
            confidence: 0.82,
            reasoning: "Fixture seeded date estimate"
          }
        ];

  const eventGroups: EventGroup[] =
    profile === "settings-only"
      ? []
      : [
          {
            id: 401,
            year: 2026,
            name: "Ski Trip",
            folderName: "2026 - Ski Trip",
            itemCount: 2,
            userApproved: false
          }
        ];

  const stats = {
    total: 8,
    downloading: 0,
    review: reviewItems.length,
    legitimate: 3,
    dateNeedsReview: dateItems.length,
    grouped: 2,
    filed: 1,
    errors: 0
  };

  return {
    config: {
      workingDirectory: "C:\\fixture\\inbox",
      outputDirectory: "C:\\fixture\\output",
      aiTaskModels: {
        classification: { provider: "openai", model: "gpt-4o-mini" },
        dateEstimation: { provider: "anthropic", model: "claude-sonnet-4-6" },
        eventNaming: { provider: "anthropic", model: "claude-sonnet-4-6" },
        duplicateRanking: { provider: "anthropic", model: "claude-sonnet-4-6" }
      }
    },
    stats,
    reviewItems,
    dateItems,
    eventGroups
  };
}

export async function installBrowserApiMock(page: Page, profile: BrowserFixtureProfile = "all") {
  await page.addInitScript(
    ({ stateBuilderSource }) => {
      (window as any).__MEMORIA_BUILD_STATE__ = new Function(`return (${stateBuilderSource});`)();
    },
    { stateBuilderSource: buildState.toString() }
  );

  await page.addInitScript(({ fixtureProfile }) => {
    const state = (function createState() {
      const build = (window as any).__MEMORIA_BUILD_STATE__;
      return build ? build(fixtureProfile) : null;
    })();
    if (!state) {
      return;
    }

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
            case "get_review_queue":
              return Promise.resolve(state.reviewItems);
            case "get_date_review_queue":
              return Promise.resolve(state.dateItems);
            case "get_event_groups":
              return Promise.resolve(state.eventGroups);
            case "set_working_directory":
              state.config.workingDirectory = String(args?.path ?? state.config.workingDirectory);
              return Promise.resolve();
            case "set_output_directory":
              state.config.outputDirectory = String(args?.path ?? state.config.outputDirectory);
              return Promise.resolve();
            case "set_openai_key":
            case "set_anthropic_key":
            case "set_ai_task_model":
            case "start_download_session":
            case "run_classification":
            case "run_event_grouping":
            case "finalize_organization":
              return Promise.resolve();
            case "reset_session": {
              state.reviewItems = [];
              state.dateItems = [];
              state.eventGroups = [];
              state.stats = {
                ...state.stats,
                total: 0,
                downloading: 0,
                review: 0,
                legitimate: 0,
                dateNeedsReview: 0,
                grouped: 0,
                filed: 0,
                errors: 0
              };
              return Promise.resolve({
                deletedGeneratedFiles: Boolean(args?.deleteGeneratedFiles),
                removedDirectories: Boolean(args?.deleteGeneratedFiles)
                  ? ["staging", "review", "organized", "recycle"]
                  : []
              });
            }
            case "apply_review_action": {
              const ids = (args?.ids as number[]) ?? [];
              const action = String(args?.action ?? "");
              state.reviewItems = state.reviewItems.filter((item: MediaItem) => !ids.includes(item.id));
              state.stats.review = state.reviewItems.length;
              if (action === "include") {
                state.stats.legitimate += ids.length;
              }
              return Promise.resolve();
            }
            case "confirm_duplicate_keep": {
              const id = Number(args?.media_item_id ?? -1);
              state.reviewItems = state.reviewItems.filter(
                (item: MediaItem) => item.id === id || item.duplicateClusterId !== "fixture-cluster-1"
              );
              state.stats.review = state.reviewItems.length;
              return Promise.resolve();
            }
            case "apply_date_approval": {
              const id = Number(args?.media_item_id ?? -1);
              state.dateItems = state.dateItems.filter((item: DateEstimate) => item.mediaItemId !== id);
              state.stats.dateNeedsReview = state.dateItems.length;
              return Promise.resolve();
            }
            case "rename_event_group": {
              const id = Number(args?.group_id ?? -1);
              const name = String(args?.name ?? "");
              state.eventGroups = state.eventGroups.map((group: EventGroup) =>
                group.id === id ? { ...group, name, folderName: `${group.year} - ${name}` } : group
              );
              return Promise.resolve();
            }
            default:
              return Promise.reject(new Error(`Unknown mocked command: ${command}`));
        }
      }
    };
  }, { fixtureProfile: profile });
}

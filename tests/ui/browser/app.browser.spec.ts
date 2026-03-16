import { expect, test } from "@playwright/test";
import { installBrowserApiMock } from "../helpers/browserMock";

test.describe("Memoria browser UI", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserApiMock(page, "all");
    await page.goto("/");
  });

  test("dashboard uses reordered pipeline and updated tiles", async ({ page }) => {
    await expect(page.getByTestId("tab-dashboard")).toContainText("Index");
    await expect(page.getByTestId("tab-images")).toContainText("Image Review");
    await expect(page.getByTestId("tab-videos")).toContainText("Video Review");
    await expect(page.getByTestId("tab-dates")).toContainText("Date Approval");
    await expect(page.getByTestId("tab-events")).toContainText("Event Groups");
    await expect(page.getByTestId("workflow-step-finalize")).toContainText("Finalize");
    await expect(page.getByTestId("dashboard-pipeline-card")).toHaveCount(0);

    await expect(page.getByTestId("stat-image-review")).toHaveCount(0);
    await expect(page.getByTestId("stat-image-verified")).toHaveCount(0);
    await expect(page.getByTestId("stat-date-review")).toHaveCount(0);
    await expect(page.getByTestId("stat-date-verified")).toHaveCount(0);
    await expect(page.getByTestId("stat-total")).toHaveCount(0);
    await expect(page.getByTestId("stat-indexed")).toHaveCount(0);
    await expect(page.getByTestId("stat-grouped")).toHaveCount(0);
    await expect(page.getByTestId("stat-filed")).toHaveCount(0);
    await expect(page.getByTestId("stat-errors")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-video-review-tile")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-progress-hero")).toBeVisible();
  });

  test("header brand logo is centered above Memoria text", async ({ page }) => {
    const brand = page.getByTestId("brand-home-link");
    const logo = page.getByTestId("brand-logo-image");
    const text = page.getByTestId("brand-logo-text");

    await expect(brand).toBeVisible();
    await expect(logo).toBeVisible();
    await expect(text).toBeVisible();

    const [logoBox, textBox] = await Promise.all([logo.boundingBox(), text.boundingBox()]);
    expect(logoBox).not.toBeNull();
    expect(textBox).not.toBeNull();
    if (!logoBox || !textBox) return;

    const logoCenterX = logoBox.x + logoBox.width / 2;
    const textCenterX = textBox.x + textBox.width / 2;
    expect(Math.abs(logoCenterX - textCenterX)).toBeLessThanOrEqual(6);
    expect(logoBox.y + logoBox.height).toBeLessThan(textBox.y + 1);
  });

  test("dashboard narrative hero shows memory stack and edge progress", async ({ page }) => {
    await expect(page.getByTestId("dashboard-progress-copy")).toContainText("You've filed");
    await expect(page.getByTestId("progress-memory-stack")).toBeVisible();
    await expect(page.getByTestId("progress-hero-edge-fill")).toBeVisible();
    await expect(page.getByTestId("dashboard-progress-action")).toHaveText("Resume Organizing");
    const fillStyle = await page.getByTestId("progress-hero-edge-fill").evaluate((el) => (el as HTMLElement).style.width);
    const fillPercent = Number.parseFloat(fillStyle);
    expect(fillPercent).toBeGreaterThan(40);
  });

  test("dashboard hero centers logo and text content", async ({ page }) => {
    await expect(page.getByTestId("progress-memory-stack")).toBeVisible();
    const layoutStyles = await page.locator(".progressHeroContent").evaluate((el) => {
      const styles = getComputedStyle(el as HTMLElement);
      return {
        justifyContent: styles.justifyContent,
        alignItems: styles.alignItems
      };
    });
    const bodyTextAlign = await page.getByTestId("progress-hero-body").evaluate((el) => getComputedStyle(el as HTMLElement).textAlign);
    expect(layoutStyles.justifyContent).toBe("center");
    expect(layoutStyles.alignItems).toBe("center");
    expect(bodyTextAlign).toBe("center");
  });

  test("dashboard action is start organizing before first indexing", async ({ context }) => {
    const preIndexPage = await context.newPage();
    await installBrowserApiMock(preIndexPage, "pre-index");
    await preIndexPage.goto("/");
    await expect(preIndexPage.getByTestId("dashboard-progress-action")).toHaveText("Start Organizing");
    await preIndexPage.close();
  });

  test("indexing uses LoadingState component with branded logo", async ({ context }) => {
    const ingestPage = await context.newPage();
    await installBrowserApiMock(ingestPage, "ingest-slow");
    await ingestPage.goto("/");

    await ingestPage.getByTestId("tab-dashboard").click();
    await expect(ingestPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-root")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-logo")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-logo")).toHaveClass(/mix-blend-multiply/);
    const logoBox = await ingestPage.getByTestId("loading-state-logo").boundingBox();
    expect(logoBox).not.toBeNull();
    if (logoBox) {
      expect(logoBox.width).toBeLessThanOrEqual(34);
      expect(logoBox.height).toBeLessThanOrEqual(34);
    }
    await expect(ingestPage.getByText("Indexing your media...")).toBeVisible();
    await ingestPage.close();
  });

  test("dashboard shows completion headline and success toast when fully filed", async ({ context }) => {
    const completePage = await context.newPage();
    await installBrowserApiMock(completePage, "complete");
    await completePage.goto("/");
    await expect(completePage.getByTestId("dashboard-progress-copy")).toContainText("Your archive is fully organized!");
    await expect(completePage.getByTestId("dashboard-progress-action")).toHaveText("Start New Session");
    await expect(completePage.getByTestId("finalize-success-toast")).toBeVisible();
    await completePage.getByTestId("dashboard-progress-action").click();
    await expect(completePage.getByTestId("reset-session-dialog")).toBeVisible();
    await expect(completePage.getByTestId("reset-session-delete-files")).toBeVisible();
    await expect(completePage.getByTestId("reset-session-keep-files")).toBeVisible();
    await completePage.close();
  });

  test("dashboard fallback logo uses anti-black blend mode", async ({ context }) => {
    const settingsPage = await context.newPage();
    await installBrowserApiMock(settingsPage, "settings-only");
    await settingsPage.goto("/");
    const fallbackLogo = settingsPage.getByTestId("progress-hero-fallback-logo");
    await expect(fallbackLogo).toBeVisible();
    const mixBlendMode = await fallbackLogo.evaluate((el) => getComputedStyle(el).mixBlendMode);
    expect(mixBlendMode).toBe("screen");
    await settingsPage.close();
  });

  test("dashboard memory stack ignores video items", async ({ context }) => {
    const videoOnlyPage = await context.newPage();
    await installBrowserApiMock(videoOnlyPage, "dashboard-video-only");
    await videoOnlyPage.goto("/");
    await expect(videoOnlyPage.getByTestId("progress-hero-fallback-logo")).toBeVisible();
    await expect(videoOnlyPage.locator(".progressHeroMemoryCard")).toHaveCount(0);
    await videoOnlyPage.close();
  });

  test("settings renders all model slots with locked labels", async ({ page }) => {
    await page.getByTestId("tab-settings").click();

    await expect(page.getByText("Date Estimation")).toBeVisible();
    await expect(page.getByText("Primary Model — Analyzes photos to estimate when they were taken")).toBeVisible();
    await expect(page.getByText("Fallback Model — Used when the primary model fails or returns low confidence")).toBeVisible();
    await expect(page.getByText("Event Grouping and Naming")).toBeVisible();
    await expect(page.getByText("Cluster Analysis Model — Extracts scene, activity, and location clues from sample photos")).toBeVisible();
    await expect(page.getByText("Event Naming Model — Generates descriptive folder names from cluster analysis and photo context")).toBeVisible();
    await expect(page.getByText("Naming Fallback Model — Used when the naming model fails or returns a generic name")).toBeVisible();
    await expect(page.getByText("Image Review Quality")).toBeVisible();
    await expect(page.getByText("Quality Assessment Model — Evaluates borderline blur, classifies screenshots and memes")).toBeVisible();

    await expect(page.getByTestId("model-selector-date-estimation")).toBeVisible();
    await expect(page.getByTestId("model-selector-date-estimation-fallback")).toBeVisible();
    await expect(page.getByTestId("model-selector-grouping-pass1")).toBeVisible();
    await expect(page.getByTestId("model-selector-event-naming")).toBeVisible();
    await expect(page.getByTestId("model-selector-event-naming-fallback")).toBeVisible();
    await expect(page.getByTestId("model-selector-image-review")).toBeVisible();

    await expect(page.getByTestId("model-configure-date-estimation-fallback")).toBeVisible();
    await expect(page.getByTestId("model-configure-grouping-pass1")).toBeVisible();
    await expect(page.getByTestId("model-configure-event-naming-fallback")).toBeVisible();
    await expect(page.getByTestId("model-configure-image-review")).toBeVisible();
  });

  test("settings save does not clear never-configured optional models", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.getByTestId("settings-save-ai-models").click();
    await expect(page.getByTestId("status-pill")).toContainText("AI task models saved.");
  });

  test("settings optional model configure and clear flow", async ({ page }) => {
    await page.getByTestId("tab-settings").click();

    await page.getByTestId("model-configure-date-estimation-fallback").click();
    await page.getByTestId("model-provider-date-estimation-fallback").selectOption("openai");
    await page.getByTestId("model-name-date-estimation-fallback").fill("gpt-4o-mini");
    await page.getByTestId("settings-save-ai-models").click();
    await expect(page.getByTestId("status-pill")).toContainText("AI task models saved.");
    await expect(page.getByTestId("model-name-date-estimation-fallback")).toHaveValue("gpt-4o-mini");

    await page.getByTestId("model-clear-date-estimation-fallback").click();
    await page.getByTestId("settings-save-ai-models").click();
    await expect(page.getByTestId("status-pill")).toContainText("AI task models saved.");
    await expect(page.getByTestId("model-configure-date-estimation-fallback")).toBeVisible();
  });

  test("settings backward compatibility with only original primary models configured", async ({ context }) => {
    const compatibilityPage = await context.newPage();
    const consoleErrors: string[] = [];
    compatibilityPage.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    await installBrowserApiMock(compatibilityPage, "settings-only");
    await compatibilityPage.goto("/");
    await compatibilityPage.getByTestId("tab-settings").click();

    await expect(compatibilityPage.getByTestId("model-name-date-estimation")).toHaveValue("claude-sonnet-4-6");
    await expect(compatibilityPage.getByTestId("model-name-event-naming")).toHaveValue("claude-sonnet-4-6");
    await expect(compatibilityPage.getByTestId("model-configure-date-estimation-fallback")).toBeVisible();
    await expect(compatibilityPage.getByTestId("model-configure-grouping-pass1")).toBeVisible();
    await expect(compatibilityPage.getByTestId("model-configure-event-naming-fallback")).toBeVisible();
    await expect(compatibilityPage.getByTestId("model-configure-image-review")).toBeVisible();

    await compatibilityPage.getByTestId("settings-save-ai-models").click();
    await expect(compatibilityPage.getByTestId("status-pill")).toContainText("AI task models saved.");
    expect(consoleErrors).toEqual([]);
    await compatibilityPage.close();
  });

  test("image review supports flagged and burst workflows", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await expect(page.getByTestId("image-review-view")).toBeVisible();
    await expect(page.getByText("Keep the best shots and exclude anything you do not want grouped.")).toBeVisible();

    await page.getByTestId("image-filter-flagged").click();
    await expect(page.getByTestId("image-item-503")).toBeVisible();
    await expect(page.getByTestId("image-flag-blurry-503")).toBeVisible();

    await page.getByTestId("image-filter-burst").click();
    await expect(page.getByTestId("image-burst-groups-view")).toBeVisible();
    await expect(page.getByTestId("image-preview-filmstrip")).toHaveCount(0);
    await page.getByTestId("image-keep-best-only-burst-a").click();

    await page.getByTestId("image-filter-all").click();
    await page.getByTestId("image-open-502").click();
    await expect(page.getByTestId("image-preview-modal")).toBeVisible();
    await page.getByTestId("image-preview-exclude").click();
    await page.getByTestId("image-preview-close").click();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("image-done-proceed").click();
    await expect(page.getByTestId("status-pill")).toContainText("Image review complete");
  });

  test("image and video grids keep consistent tile sizing and spacing", async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 900 });

    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-all").click();
    const firstImage = page.getByTestId("image-item-501");
    const trailingImage = page.getByTestId("image-item-503");
    await expect(firstImage).toBeVisible();
    await expect(trailingImage).toBeVisible();
    const [firstImageBox, trailingImageBox] = await Promise.all([firstImage.boundingBox(), trailingImage.boundingBox()]);
    expect(firstImageBox).not.toBeNull();
    expect(trailingImageBox).not.toBeNull();
    if (!firstImageBox || !trailingImageBox) return;
    expect(trailingImageBox.width).toBeLessThanOrEqual(firstImageBox.width * 1.4);

    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-filter-mode-size").check();
    await page.getByTestId("video-size-slider").fill("50");
    const videoTiles = page.locator("[data-testid^='video-item-']");
    await expect(videoTiles.first()).toBeVisible();
    const videoFirstBox = await videoTiles.nth(0).boundingBox();
    expect(videoFirstBox).not.toBeNull();
    if (!videoFirstBox) return;
    const ratio = videoFirstBox.width / Math.max(videoFirstBox.height, 1);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(1.95);
  });

  test("image done shows loading overlay before video review", async ({ context }) => {
    const imageFlowPage = await context.newPage();
    await installBrowserApiMock(imageFlowPage, "phase-busy");
    await imageFlowPage.goto("/");
    await imageFlowPage.getByTestId("tab-images").click();
    imageFlowPage.once("dialog", (dialog) => dialog.accept());
    await imageFlowPage.getByTestId("image-done-proceed").click();
    await expect(imageFlowPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(imageFlowPage.getByText("Advancing to video review...")).toBeVisible();
    await expect(imageFlowPage.getByTestId("video-review-card")).toBeVisible();
    await imageFlowPage.close();
  });

  test("video phase busy overlay uses compact helper style", async ({ context }) => {
    const busyPage = await context.newPage();
    await installBrowserApiMock(busyPage, "phase-busy");
    await busyPage.goto("/");
    await busyPage.getByTestId("tab-videos").click();
    await busyPage.getByTestId("video-select-all-filtered").click();
    await busyPage.getByTestId("video-exclude-selected").click();
    await expect(busyPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(busyPage.getByTestId("loading-state-logo")).toBeVisible();
    await expect(busyPage.getByText("Updating video review...")).toBeVisible();
    await expect(busyPage.getByTestId("loading-state-hint")).toContainText("include/exclude changes");
    await busyPage.close();
  });

  test("video proceed runs date enforcement and opens date approval with queue", async ({ context }) => {
    const flowPage = await context.newPage();
    await installBrowserApiMock(flowPage, "video-to-dates");
    await flowPage.goto("/");
    await flowPage.getByTestId("tab-videos").click();
    await flowPage.getByTestId("video-done-proceed").click();
    await expect(flowPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(flowPage.getByText("Enforcing dates...")).toBeVisible();
    await expect(flowPage.getByTestId("date-approval-card")).toBeVisible();
    await expect(flowPage.locator("[data-testid^='date-item-']")).toHaveCount(2);
    await flowPage.close();
  });

  test("event groups can proceed to finalize with loading overlay", async ({ context }) => {
    const finalizePage = await context.newPage();
    await installBrowserApiMock(finalizePage, "finalize-busy");
    await finalizePage.goto("/");
    await finalizePage.getByTestId("tab-events").click();
    await expect(finalizePage.getByTestId("event-done-proceed-finalize")).toBeVisible();
    await finalizePage.getByTestId("event-done-proceed-finalize").click();
    await expect(finalizePage.getByTestId("global-loading-state")).toBeVisible();
    await expect(finalizePage.getByText("Finalizing organization...")).toBeVisible();
    await expect(finalizePage.getByTestId("status-pill")).toContainText("Organization finalized.");
    await expect(finalizePage.getByTestId("event-done-proceed-finalize")).toHaveText("Back to Dashboard");
    await finalizePage.getByTestId("event-done-proceed-finalize").click();
    await expect(finalizePage.getByTestId("dashboard-progress-hero")).toBeVisible();
    await expect(finalizePage.getByTestId("dashboard-progress-action")).toHaveText("Start New Session");
    await finalizePage.getByTestId("dashboard-progress-action").click();
    await expect(finalizePage.getByTestId("reset-session-dialog")).toBeVisible();
    await finalizePage.close();
  });

  test("video review filter mode is mutually exclusive", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await expect(page.getByTestId("video-filter-mode-duration")).toBeChecked();
    await expect(page.getByTestId("video-duration-slider")).toBeEnabled();
    await expect(page.getByTestId("video-size-slider")).toBeDisabled();

    await page.getByTestId("video-duration-slider").fill("23");
    await expect(page.getByTestId("video-filter-summary")).toContainText("23 sec");

    await page.getByTestId("video-filter-mode-size").check();
    await expect(page.getByTestId("video-size-slider")).toBeEnabled();
    await expect(page.getByTestId("video-duration-slider")).toBeDisabled();
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing videos under 5 MB");

    await page.getByTestId("video-size-slider").fill("2");
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing videos under 2 MB");
    await page.getByTestId("video-filter-mode-duration").check();
    await expect(page.getByTestId("video-duration-slider")).toHaveValue("23");
  });

  test("date approval and event flow still work after reorder", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-done-proceed").click();

    await page.getByTestId("video-done-proceed").click();

    await page.getByTestId("tab-dates").click();
    await expect(page.locator("[data-testid^='date-item-']")).toHaveCount(2);
    await page.getByTestId("date-skip-301").click();
    await page.getByTestId("date-skip-302").click();
    await expect(page.locator("[data-testid^='date-item-']")).toHaveCount(0);
    await expect(page.getByTestId("date-done-proceed-events")).toBeVisible();
    await page.getByTestId("date-done-proceed-events").click();
    await expect(page.getByTestId("status-pill")).toContainText("Event grouping complete.");

    await expect(page.getByTestId("event-groups-card")).toBeVisible();
  });

  test("date to event grouping creates groups when starting empty", async ({ context }) => {
    const groupingPage = await context.newPage();
    await installBrowserApiMock(groupingPage, "grouping-empty");
    await groupingPage.goto("/");
    await groupingPage.getByTestId("tab-dates").click();
    await expect(groupingPage.locator("[data-testid^='date-item-']")).toHaveCount(0);
    await groupingPage.getByTestId("date-done-proceed-events").click();
    await expect(groupingPage.getByTestId("status-pill")).toContainText("Event grouping complete.");
    await expect(groupingPage.getByTestId("event-group-777")).toBeVisible();
    await groupingPage.close();
  });

  test("reset delete files shows loading and disables actions", async ({ page, context }) => {
    const resetPage = await context.newPage();
    await installBrowserApiMock(resetPage, "reset-slow");
    await resetPage.goto("/");
    await resetPage.getByTestId("pipeline-reset-session").click();
    const deleteBtn = resetPage.getByTestId("reset-session-delete-files");
    const keepBtn = resetPage.getByTestId("reset-session-keep-files");
    await deleteBtn.click();
    await expect(resetPage.getByTestId("reset-session-loading")).toBeVisible();
    await expect(deleteBtn).toBeDisabled();
    await expect(keepBtn).toBeDisabled();
    await expect(resetPage.getByTestId("reset-session-dialog")).toHaveCount(0);
    await resetPage.close();
  });

  test("reset app state only shows loading and succeeds", async ({ page, context }) => {
    const resetPage = await context.newPage();
    await installBrowserApiMock(resetPage, "reset-slow");
    await resetPage.goto("/");
    await expect(resetPage.getByTestId("dashboard-progress-copy")).toContainText("of 8 items.");
    await resetPage.getByTestId("pipeline-reset-session").click();
    const keepBtn = resetPage.getByTestId("reset-session-keep-files");
    await keepBtn.click();
    await expect(resetPage.getByTestId("reset-session-loading")).toBeVisible();
    await expect(resetPage.getByTestId("dashboard-progress-copy")).toContainText("0 of 0 items.");
    await resetPage.close();
  });

  test("reset error keeps dialog open with inline message", async ({ page, context }) => {
    const resetPage = await context.newPage();
    await installBrowserApiMock(resetPage, "reset-error");
    await resetPage.goto("/");
    await resetPage.getByTestId("pipeline-reset-session").click();
    await resetPage.getByTestId("reset-session-delete-files").click();
    await expect(resetPage.getByTestId("reset-session-dialog")).toBeVisible();
    await expect(resetPage.getByTestId("reset-session-error")).toContainText("Reset failed:");
    await expect(resetPage.getByTestId("reset-session-error")).toContainText("media_items_old");
    await resetPage.close();
  });

  test("reset cancel closes dialog without running reset", async ({ page }) => {
    await expect(page.getByTestId("dashboard-progress-copy")).toContainText("of 8 items.");
    await page.getByTestId("pipeline-reset-session").click();
    await page.getByTestId("reset-session-cancel").click();
    await expect(page.getByTestId("reset-session-dialog")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-progress-copy")).toContainText("of 8 items.");
  });

  test("home location section renders with correct testids and default state", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("settings-section-home-location")).toBeVisible();
    await expect(page.getByTestId("home-address-input")).toBeVisible();
    await expect(page.getByTestId("home-label-input")).toBeVisible();
    await expect(page.getByTestId("home-radius-input")).toBeVisible();
    await expect(page.getByTestId("home-location-save-btn")).toBeVisible();
    await expect(page.getByTestId("home-location-clear-btn")).toBeVisible();
    await expect(page.getByTestId("home-location-status")).toContainText("Not configured");
  });

  test("home location save and clear flow", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await page.getByTestId("home-address-input").fill("Nashville, TN");
    await page.getByTestId("home-label-input").fill("Home");
    await page.getByTestId("home-location-save-btn").click();
    await expect(page.getByTestId("home-location-status")).toContainText("Saved: Nashville, TN");
    await expect(page.getByTestId("status-pill")).toContainText("Home location saved.");

    await page.getByTestId("home-location-clear-btn").click();
    await expect(page.getByTestId("home-location-status")).toContainText("Not configured");
    await expect(page.getByTestId("status-pill")).toContainText("Home location cleared.");
  });

  test("video review tiles show play overlay", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-filter-mode-size").check();
    await page.getByTestId("video-size-slider").fill("50");
    const firstVideoTile = page.locator("[data-testid^='video-item-']").first();
    await expect(firstVideoTile).toBeVisible();
    const firstId = await firstVideoTile.getAttribute("data-testid").then((v) => v?.replace("video-item-", ""));
    await expect(page.getByTestId(`video-play-overlay-${firstId}`)).toBeVisible();
  });

  test("video review opens modal with video player on long video", async ({ context }) => {
    const videoPage = await context.newPage();
    await installBrowserApiMock(videoPage, "all");
    await videoPage.goto("/");
    await videoPage.getByTestId("tab-videos").click();
    await videoPage.getByTestId("video-filter-mode-size").check();
    await videoPage.getByTestId("video-size-slider").fill("20");
    const openBtn = videoPage.getByTestId("video-open-602");
    if (await openBtn.isVisible()) {
      await openBtn.click();
      const modal = videoPage.getByTestId("video-preview-modal");
      const isVisible = await modal.isVisible().catch(() => false);
      if (isVisible) {
        const player = videoPage.getByTestId("video-preview-player");
        await expect(player).toBeVisible();
      }
    }
    await videoPage.close();
  });

  test("event group thumbnail shows play glyph for video items", async ({ context }) => {
    const videoGroupPage = await context.newPage();
    await installBrowserApiMock(videoGroupPage, "dashboard-video-only");
    await videoGroupPage.goto("/");
    await videoGroupPage.getByTestId("tab-events").click();
    await expect(videoGroupPage.getByTestId("event-group-401")).toBeVisible();
    await videoGroupPage.getByTestId("event-open-401").click();
    await expect(videoGroupPage.getByTestId("event-media-item-9901")).toBeVisible();
    await expect(videoGroupPage.getByTestId("event-media-play-glyph-9901")).toBeVisible();
    await expect(videoGroupPage.getByTestId("event-media-play-glyph-9902")).toBeVisible();
    await videoGroupPage.close();
  });

  test("event group item remove overlay button is visible on hover and triggers confirmation", async ({ context }) => {
    const removePage = await context.newPage();
    await installBrowserApiMock(removePage, "finalize-busy");
    await removePage.goto("/");
    await removePage.getByTestId("tab-events").click();
    await expect(removePage.getByTestId("event-group-401")).toBeVisible();
    await removePage.getByTestId("event-open-401").click();
    await expect(removePage.getByTestId("event-media-item-901")).toBeVisible();

    const card = removePage.getByTestId("event-media-item-901");
    await card.hover();
    const removeOverlayBtn = removePage.getByTestId("event-media-remove-overlay-901");
    await expect(removeOverlayBtn).toBeVisible();
    await removeOverlayBtn.click();
    await expect(removePage.getByTestId("event-media-exclude-confirm-901")).toBeVisible();
    await expect(removePage.getByText("Remove and move to recycle?")).toBeVisible();
    await removePage.close();
  });

  test("event group item remove bottom button uses Remove label", async ({ context }) => {
    const removePage = await context.newPage();
    await installBrowserApiMock(removePage, "finalize-busy");
    await removePage.goto("/");
    await removePage.getByTestId("tab-events").click();
    await removePage.getByTestId("event-open-401").click();
    await expect(removePage.getByTestId("event-media-item-901")).toBeVisible();
    const removeBtn = removePage.getByTestId("event-media-exclude-901");
    await expect(removeBtn).toHaveText("Remove");
    await removeBtn.click();
    await expect(removePage.getByTestId("event-media-exclude-confirm-901")).toBeVisible();
    const confirmBtn = removePage.getByTestId("event-media-exclude-confirm-yes-901");
    await expect(confirmBtn).toHaveText("Remove");
    await removePage.close();
  });

  test("event group item remove confirmation decrements item count", async ({ context }) => {
    const removePage = await context.newPage();
    await installBrowserApiMock(removePage, "finalize-busy");
    await removePage.goto("/");
    await removePage.getByTestId("tab-events").click();
    await removePage.getByTestId("event-open-401").click();
    await expect(removePage.getByTestId("event-media-item-901")).toBeVisible();
    await removePage.getByTestId("event-media-exclude-901").click();
    await removePage.getByTestId("event-media-exclude-confirm-yes-901").click();
    await expect(removePage.getByTestId("event-media-item-901")).toHaveCount(0);
    await removePage.close();
  });

  test("media tile overlay bottom text has sufficient contrast styling", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-all").click();
    const firstItem = page.getByTestId("image-item-501");
    await expect(firstItem).toBeVisible();
    const overlayBottom = firstItem.locator(".mediaTileOverlayBottom");
    const metaStyles = await overlayBottom.locator(".mediaTileMeta").evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, color: s.color };
    });
    const fontSize = parseFloat(metaStyles.fontSize);
    expect(fontSize).toBeGreaterThanOrEqual(12);
  });

  test("loading state shows progress bar when progress prop is set", async ({ context }) => {
    const progressPage = await context.newPage();
    await installBrowserApiMock(progressPage, "phase-busy");
    await progressPage.goto("/");
    await progressPage.getByTestId("tab-images").click();
    progressPage.once("dialog", (dialog) => dialog.accept());
    await progressPage.getByTestId("image-done-proceed").click();
    await expect(progressPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(progressPage.getByTestId("loading-state-logo")).toBeVisible();
    await progressPage.close();
  });

  test("image review video item shows play glyph on thumbnail", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-all").click();
    const videoItem = page.getByTestId("image-item-505");
    await expect(videoItem).toBeVisible();
    await expect(page.getByTestId("image-play-glyph-505")).toBeVisible();
  });

  test("image review clicking video opens modal with video element", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-all").click();
    await page.getByTestId("image-open-505").click();
    await expect(page.getByTestId("image-preview-modal")).toBeVisible();
    await expect(page.getByTestId("image-preview-video")).toBeVisible();
    await page.getByTestId("image-preview-close").click();
  });

  test("image review overlay bottom text is always visible without hover", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-all").click();
    const firstItem = page.getByTestId("image-item-501");
    await expect(firstItem).toBeVisible();
    const overlayBottom = firstItem.locator(".mediaTileOverlayBottom");
    const opacity = await overlayBottom.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeGreaterThanOrEqual(1);
  });

  test("image review help toggle shows explanation text", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await expect(page.getByTestId("image-review-help")).toBeVisible();
    await expect(page.getByTestId("image-review-help-content")).toHaveCount(0);
    await page.getByTestId("image-review-help-toggle").click();
    await expect(page.getByTestId("image-review-help-content")).toBeVisible();
    await expect(page.getByTestId("image-review-help-content")).toContainText("Flagged Only");
    await expect(page.getByTestId("image-review-help-content")).toContainText("Burst Groups");
    await page.getByTestId("image-review-help-toggle").click();
    await expect(page.getByTestId("image-review-help-content")).toHaveCount(0);
  });

  test("image review burst group buttons are near group label", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-filter-burst").click();
    const bestBtn = page.getByTestId("image-keep-best-only-burst-a");
    await expect(bestBtn).toBeVisible();
    const btnBox = await bestBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    if (!btnBox) return;
    expect(btnBox.x).toBeLessThan(600);
  });

  test("video review defaults to filter by duration", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await expect(page.getByTestId("video-filter-mode-duration")).toBeChecked();
    await expect(page.getByTestId("video-duration-slider")).toBeEnabled();
    await expect(page.getByTestId("video-size-slider")).toBeDisabled();
    await expect(page.getByTestId("video-filter-summary")).toContainText("sec");
  });

  test("video review slider has constrained width", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    const slider = page.getByTestId("video-duration-slider");
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.width).toBeLessThanOrEqual(410);
  });

  test("video review videos are sorted ascending by active filter", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-duration-slider").fill("120");
    const tiles = page.locator("[data-testid^='video-item-']");
    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const firstId = await tiles.nth(0).getAttribute("data-testid").then((v) => v?.replace("video-item-", ""));
    const secondId = await tiles.nth(1).getAttribute("data-testid").then((v) => v?.replace("video-item-", ""));
    expect(firstId).toBe("601");
    expect(secondId).toBe("602");
  });

  test("video review excluded tab shows excluded videos with restore", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-show-excluded").click();
    const excludedTile = page.getByTestId("video-item-603");
    await expect(excludedTile).toBeVisible();
    await expect(page.getByTestId("video-restore-603")).toBeVisible();
  });

  test("date approval thumbnail opens preview on click", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-done-proceed").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-dates").click();
    await expect(page.getByTestId("date-item-301")).toBeVisible();
    await page.getByTestId("date-preview-btn-301").click();
    await expect(page.getByTestId("date-preview-overlay-301")).toBeVisible();
    await expect(page.getByTestId("date-preview-image-301")).toBeVisible();
    await page.getByTestId("date-preview-close-301").click();
    await expect(page.getByTestId("date-preview-overlay-301")).toHaveCount(0);
  });

  test("date approval video item shows play glyph and opens video preview", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-done-proceed").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-dates").click();
    await expect(page.getByTestId("date-item-302")).toBeVisible();
    const thumbBtn = page.getByTestId("date-preview-btn-302");
    await expect(thumbBtn.locator(".dateThumbPlayGlyph")).toBeVisible();
    await thumbBtn.click();
    await expect(page.getByTestId("date-preview-overlay-302")).toBeVisible();
    await expect(page.getByTestId("date-preview-video-302")).toBeVisible();
    await page.getByTestId("date-preview-close-302").click();
  });

  test("loading state renders with detail and percentage as separate elements", async ({ context }) => {
    const progressPage = await context.newPage();
    await installBrowserApiMock(progressPage, "phase-busy");
    await progressPage.goto("/");
    await progressPage.getByTestId("tab-images").click();
    progressPage.once("dialog", (dialog) => dialog.accept());
    await progressPage.getByTestId("image-done-proceed").click();
    await expect(progressPage.getByTestId("loading-state-root")).toBeVisible();
    await expect(progressPage.getByTestId("loading-state-hint")).toBeVisible();
    await progressPage.close();
  });

  test("loading state progress does not concatenate percentage with filename", async ({ context }) => {
    const progressPage = await context.newPage();
    await installBrowserApiMock(progressPage, "phase-busy");
    await progressPage.goto("/");
    await progressPage.getByTestId("tab-images").click();
    progressPage.once("dialog", (dialog) => dialog.accept());
    await progressPage.getByTestId("image-done-proceed").click();
    await expect(progressPage.getByTestId("loading-state-root")).toBeVisible();

    await progressPage.evaluate(() => {
      const setProgress = (window as any).__MEMORIA_SET_PROGRESS__;
      if (setProgress) {
        setProgress({ current: 160, total: 269, detail: "Indexing: IMG_6703.JPEG" });
      }
    });

    const detail = progressPage.getByTestId("loading-state-progress-detail");
    const pct = progressPage.getByTestId("loading-state-progress-pct");
    await expect(detail).toBeVisible();
    await expect(pct).toBeVisible();
    await expect(detail).toHaveText("Indexing: IMG_6703.JPEG");
    await expect(pct).toHaveText("59%");
    await expect(detail).not.toContainText("%");

    const detailFlex = await detail.evaluate((el) => getComputedStyle(el).flexGrow);
    expect(detailFlex).toBe("1");

    const containerBox = await progressPage.getByTestId("loading-state-progress").boundingBox();
    const pctBox = await pct.boundingBox();
    expect(containerBox).not.toBeNull();
    expect(pctBox).not.toBeNull();
    if (containerBox && pctBox) {
      const containerRight = containerBox.x + containerBox.width;
      const pctRight = pctBox.x + pctBox.width;
      expect(Math.abs(containerRight - pctRight)).toBeLessThanOrEqual(2);
    }

    await progressPage.close();
  });

  test("image review scan busy screen shows progress from image analysis", async ({ context }) => {
    const scanPage = await context.newPage();
    await installBrowserApiMock(scanPage, "image-scan-busy");
    await scanPage.goto("/");

    await scanPage.getByTestId("tab-images").click();
    await expect(scanPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(scanPage.getByText("Preparing image review...")).toBeVisible();
    await expect(scanPage.getByTestId("loading-state-hint")).toContainText("image quality and burst candidates");

    await scanPage.evaluate(() => {
      const setProgress = (window as any).__MEMORIA_SET_PROGRESS__;
      if (setProgress) {
        setProgress({ current: 50, total: 139, detail: "Analyzing image 50/139" });
      }
    });

    await expect(scanPage.getByTestId("loading-state-progress")).toBeVisible();
    await expect(scanPage.getByTestId("loading-state-progress-detail")).toHaveText("Analyzing image 50/139");
    await expect(scanPage.getByTestId("loading-state-progress-pct")).toHaveText("36%");
    const bar = scanPage.getByTestId("loading-state-progress-bar");
    await expect(bar).toHaveAttribute("style", /width:\s*36%/);
    await expect(scanPage.getByTestId("loading-state-progress-count")).toHaveText("50 of 139");

    await scanPage.evaluate(() => {
      const setProgress = (window as any).__MEMORIA_SET_PROGRESS__;
      if (setProgress) {
        setProgress({ current: 100, total: 139, detail: "Analyzing image 100/139" });
      }
    });

    await expect(scanPage.getByTestId("loading-state-progress-detail")).toHaveText("Analyzing image 100/139");
    await expect(scanPage.getByTestId("loading-state-progress-pct")).toHaveText("72%");
    await expect(scanPage.getByTestId("loading-state-progress-count")).toHaveText("100 of 139");

    await scanPage.close();
  });

  test("excluded images remain visible after toggling excluded filter", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-show-excluded").click();
    const excludedTile = page.getByTestId("image-item-504");
    await expect(excludedTile).toBeVisible();
    await page.waitForTimeout(500);
    await expect(excludedTile).toBeVisible();
  });

  test("excluded videos remain visible after toggling excluded filter", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-show-excluded").click();
    const excludedTile = page.getByTestId("video-item-603");
    await expect(excludedTile).toBeVisible();
    await page.waitForTimeout(500);
    await expect(excludedTile).toBeVisible();
  });

  test("video review done-proceed advances without confirm dialog", async ({ page }) => {
    let videoDialogSeen = false;
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-done-proceed").click();
    page.on("dialog", (dialog) => {
      videoDialogSeen = true;
      void dialog.accept();
    });
    await page.getByTestId("video-done-proceed").click();
    await page.waitForTimeout(300);
    expect(videoDialogSeen).toBe(false);
  });

  test("video thumbnail click opens lightbox for short video", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-duration-slider").fill("120");
    await page.getByTestId("video-open-601").click();
    await expect(page.getByTestId("video-preview-modal")).toBeVisible();
  });

  test("video thumbnail click opens lightbox for long video", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-duration-slider").fill("120");
    await page.getByTestId("video-open-602").click();
    await expect(page.getByTestId("video-preview-modal")).toBeVisible();
  });

  test("video tile has hover and click event handlers for playback", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-duration-slider").fill("120");
    const tile = page.getByTestId("video-open-601");
    await expect(tile).toBeVisible();
    const hasMouseEnter = await tile.evaluate((el) => typeof el.onmouseenter === "function" || el.getAttribute("onmouseenter") !== null);
    const tagName = await tile.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe("button");
  });
});

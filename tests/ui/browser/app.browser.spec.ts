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

    await expect(page.getByText("Date Estimation — Primary Model")).toBeVisible();
    await expect(page.getByText("Date Estimation — Fallback Model")).toBeVisible();
    await expect(page.getByText("Grouping Pass 1 — Cluster Analysis Model")).toBeVisible();
    await expect(page.getByText("Grouping Pass 2 — Event Naming Model")).toBeVisible();
    await expect(page.getByText("Event Naming — Fallback Model")).toBeVisible();

    await expect(page.getByTestId("model-selector-date-estimation")).toBeVisible();
    await expect(page.getByTestId("model-selector-date-estimation-fallback")).toBeVisible();
    await expect(page.getByTestId("model-selector-grouping-pass1")).toBeVisible();
    await expect(page.getByTestId("model-selector-event-naming")).toBeVisible();
    await expect(page.getByTestId("model-selector-event-naming-fallback")).toBeVisible();

    await expect(page.getByTestId("model-configure-date-estimation-fallback")).toBeVisible();
    await expect(page.getByTestId("model-configure-grouping-pass1")).toBeVisible();
    await expect(page.getByTestId("model-configure-event-naming-fallback")).toBeVisible();
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
    flowPage.once("dialog", (dialog) => dialog.accept());
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
    await expect(page.getByTestId("video-filter-mode-size")).toBeChecked();
    await expect(page.getByTestId("video-size-slider")).toBeEnabled();
    await expect(page.getByTestId("video-duration-slider")).toBeDisabled();

    await page.getByTestId("video-size-slider").fill("2");
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing videos under 2 MB");

    await page.getByTestId("video-filter-mode-duration").check();
    await expect(page.getByTestId("video-duration-slider")).toBeEnabled();
    await expect(page.getByTestId("video-size-slider")).toBeDisabled();
    await expect(page.getByTestId("video-filter-summary")).toContainText("sec");

    await page.getByTestId("video-duration-slider").fill("23");
    await expect(page.getByTestId("video-filter-summary")).toContainText("23 sec");
    await page.getByTestId("video-filter-mode-size").check();
    await expect(page.getByTestId("video-size-slider")).toHaveValue("2");
  });

  test("date approval and event flow still work after reorder", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-images").click();
    await page.getByTestId("image-done-proceed").click();

    page.once("dialog", (dialog) => dialog.accept());
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
});

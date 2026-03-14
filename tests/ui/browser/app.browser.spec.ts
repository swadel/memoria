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
    await expect(completePage.getByTestId("finalize-success-toast")).toBeVisible();
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
});

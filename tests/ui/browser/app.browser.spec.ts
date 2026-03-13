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

  test("dashboard progress ring is hollow, gradient, and computed", async ({ page }) => {
    const ringCircles = page.locator("[data-testid='dashboard-progress-hero'] svg circle");
    await expect(ringCircles).toHaveCount(2);

    const attrs = await ringCircles.evaluateAll((nodes) =>
      nodes.map((node) => ({
        fill: node.getAttribute("fill"),
        stroke: node.getAttribute("stroke"),
        strokeDasharray: node.getAttribute("stroke-dasharray"),
        strokeDashoffset: node.getAttribute("stroke-dashoffset")
      }))
    );

    expect(attrs[0]?.fill).toBe("none");
    expect(attrs[1]?.fill).toBe("none");
    expect(attrs[1]?.stroke).toBe("url(#petalGradient)");

    const dasharray = Number(attrs[1]?.strokeDasharray ?? "0");
    const dashoffset = Number(attrs[1]?.strokeDashoffset ?? "0");
    expect(dasharray).toBeCloseTo(502.6, 1);
    expect(dashoffset).toBeGreaterThanOrEqual(0);
    expect(dashoffset).toBeLessThanOrEqual(dasharray);
  });

  test("indexing uses LoadingState component with branded logo", async ({ context }) => {
    const ingestPage = await context.newPage();
    await installBrowserApiMock(ingestPage, "ingest-slow");
    await ingestPage.goto("/");

    await ingestPage.getByTestId("tab-dashboard").click();
    await expect(ingestPage.getByTestId("global-loading-state")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-root")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-logo")).toBeVisible();
    await expect(ingestPage.getByTestId("loading-state-logo")).toHaveClass(/h-24/);
    await expect(ingestPage.getByTestId("loading-state-logo")).toHaveClass(/w-24/);
    await expect(ingestPage.getByTestId("loading-state-logo")).toHaveClass(/mix-blend-multiply/);
    await expect(ingestPage.getByText("Indexing your media...")).toBeVisible();
    await ingestPage.close();
  });

  test("image review supports flagged and burst workflows", async ({ page }) => {
    await page.getByTestId("tab-images").click();
    await expect(page.getByTestId("image-review-view")).toBeVisible();

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

    await expect(page.getByTestId("event-groups-card")).toBeVisible();
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

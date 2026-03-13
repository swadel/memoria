import { expect, test } from "@playwright/test";
import { installBrowserApiMock } from "../helpers/browserMock";

test.describe("Memoria browser UI", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserApiMock(page, "all");
    await page.goto("/");
  });

  test("dashboard uses reordered pipeline and updated tiles", async ({ page }) => {
    await expect(page.getByTestId("pipeline-index")).toContainText("1) Index Media");
    await expect(page.getByTestId("pipeline-image-review")).toContainText("2) Image Review");
    await expect(page.getByTestId("pipeline-video-review")).toContainText("3) Video Review");
    await expect(page.getByTestId("pipeline-date-enforcement")).toContainText("4) Date Enforcement");
    await expect(page.getByTestId("pipeline-group")).toContainText("5) Group");
    await expect(page.getByTestId("pipeline-finalize")).toContainText("6) Finalize");

    await expect(page.getByTestId("stat-total")).toBeVisible();
    await expect(page.getByTestId("stat-indexed")).toBeVisible();
    await expect(page.getByTestId("stat-image-review")).toBeVisible();
    await expect(page.getByTestId("stat-image-verified")).toBeVisible();
    await expect(page.getByTestId("stat-date-review")).toBeVisible();
    await expect(page.getByTestId("stat-date-verified")).toBeVisible();
    await expect(page.getByTestId("stat-grouped")).toBeVisible();
    await expect(page.getByTestId("stat-filed")).toBeVisible();
    await expect(page.getByTestId("stat-errors")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-video-review-tile")).toHaveCount(0);
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

    await page.getByTestId("tab-events").click();
    await expect(page.getByTestId("event-groups-card")).toBeVisible();
  });
});

import { expect, test } from "@playwright/test";
import { installBrowserApiMock } from "../helpers/browserMock";

test.describe("Memoria browser UI smoke", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserApiMock(page, "all");
    await page.goto("/");
  });

  test("renders dashboard and updated pipeline phases", async ({ page }) => {
    await expect(page.getByTestId("layout-root")).toBeVisible();
    await expect(page.getByTestId("stat-total")).toContainText("8");
    await expect(page.getByTestId("pipeline-index")).toBeVisible();
    await expect(page.getByTestId("pipeline-date-enforcement")).toBeVisible();
    await expect(page.getByTestId("pipeline-video-review")).toBeVisible();
    await expect(page.getByTestId("pipeline-group")).toBeVisible();
    await expect(page.getByTestId("pipeline-finalize")).toBeVisible();
    await expect(page.getByTestId("tab-videos")).toContainText("2");
  });

  test("removes orphaned dashboard controls and review queue UI", async ({ page }) => {
    await expect(page.getByTestId("pipeline-classify")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-working-directory")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-output-directory")).toHaveCount(0);
    await expect(page.getByTestId("pipeline-progress-track")).toHaveCount(0);
  });

  test("handles date approval", async ({ page }) => {
    await page.getByTestId("tab-dates").click();
    const dateItems = page.locator("[data-testid^='date-item-']");
    await expect(dateItems).toHaveCount(2);
    await expect(page.getByTestId("date-item-301")).toBeVisible();
    await expect(page.getByTestId("date-thumb-301")).toBeVisible();
    await expect(page.getByTestId("date-thumb-301")).toHaveAttribute("src", /data:image\/png;base64/);
    await page.getByTestId("date-input-301").fill("2026-01-15");
    await page.getByTestId("date-approve-301").click();
    await expect(dateItems).toHaveCount(1);
    await expect(page.getByTestId("status-pill")).toContainText("Approved date 2026-01-15");
    await page.getByTestId("date-skip-302").click();
    await expect(dateItems).toHaveCount(0);
    await expect(page.getByTestId("status-pill")).toContainText("Skipped date approval");
  });

  test("video review filters, previews, exclude and restore", async ({ page }) => {
    await page.getByTestId("tab-videos").click();
    await expect(page.getByTestId("video-review-view")).toBeVisible();
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing 1 of 2 videos");

    await page.getByTestId("video-size-slider").fill("50");
    await page.getByTestId("video-duration-slider").fill("120");
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing 2 of 2 videos");

    await page.getByTestId("video-select-all-filtered").click();
    await expect(page.getByTestId("video-exclude-selected")).toBeEnabled();
    await expect(page.getByTestId("video-item-601")).toHaveAttribute("data-flagged", "true");

    await page.getByTestId("video-open-601").click();
    await expect(page.getByTestId("video-inline-player-601")).toBeVisible();

    await page.getByTestId("video-open-602").click();
    await expect(page.getByTestId("video-preview-modal")).toBeVisible();
    await expect(page.getByTestId("video-preview-player")).toBeVisible();
    await page.getByTestId("video-preview-prev").click();
    await page.getByTestId("video-preview-next").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("video-preview-modal")).toHaveCount(0);

    await page.getByTestId("video-select-all-filtered").click();
    await page.getByTestId("video-exclude-selected").click();
    await expect(page.getByTestId("status-pill")).toContainText("moved to recycle");
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing 0 of 0 videos");

    await page.getByTestId("video-show-excluded").click();
    await expect(page.getByTestId("video-filter-summary")).toContainText("Showing 3 of 3 videos");
    await page.getByTestId("video-restore-601").click();
    await expect(page.getByTestId("status-pill")).toContainText("restored");
  });

  test("video done confirmation and tab disabled before phase reached", async ({ page, context }) => {
    const preVideoPage = await context.newPage();
    await installBrowserApiMock(preVideoPage, "pre-video");
    await preVideoPage.goto("/");
    await expect(preVideoPage.getByTestId("tab-videos")).toBeDisabled();
    await preVideoPage.close();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();
    await expect(page.getByTestId("status-pill")).toContainText("Video review complete");
  });

  test("event groups enforce uniqueness and support detail move flows", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-events").click();

    await page.getByTestId("event-add-group-button").click();
    await page.getByTestId("event-add-group-input").fill("Ski Trip");
    await expect(page.getByTestId("event-add-group-error")).toContainText("already exists");
    await expect(page.getByTestId("event-add-group-save")).toBeDisabled();

    await page.getByTestId("event-add-group-input").fill("Road Trip");
    await page.getByTestId("event-add-group-save").click();
    await expect(page.getByTestId("event-group-402")).toContainText("0 items");
    await expect(page.getByTestId("event-delete-402")).toBeVisible();

    await page.getByTestId("event-rename-input-402").fill("SKI TRIP");
    await expect(page.getByTestId("event-rename-error-402")).toContainText("already exists");
    await expect(page.getByTestId("event-rename-save-402")).toBeDisabled();

    await page.getByTestId("event-open-401").click();
    await expect(page.getByTestId("event-group-detail-view")).toBeVisible();
    await expect(page.getByTestId("event-virtual-grid")).toBeVisible();
    await expect(page.getByTestId("event-media-item-901")).toBeVisible();
    await expect(page.getByTestId("event-media-item-902")).toBeVisible();

    await page.getByTestId("event-media-preview-901").click();
    await expect(page.getByTestId("event-preview-image")).toBeVisible();
    await page.getByTestId("event-preview-close").click();

    await page.getByTestId("event-media-select-901").click();
    await page.getByTestId("event-media-select-902").click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("event-selection-toolbar")).toContainText("2 selected");

    await page.getByTestId("event-move-selected").click();
    await page.getByTestId("event-move-target-select").selectOption("402");
    await page.getByTestId("event-move-confirm").click();
    await expect(page.getByTestId("event-selection-toolbar")).toHaveCount(0);
    await expect(page.getByTestId("event-media-item-901")).toHaveCount(0);

    await page.getByTestId("event-detail-back").click();
    await expect(page.getByTestId("event-group-401")).toContainText("0 items");
    await expect(page.getByTestId("event-delete-401")).toBeVisible();
    await expect(page.getByTestId("event-group-402")).toContainText("2 items");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("event-delete-401").click();
    await expect(page.getByTestId("event-group-401")).toHaveCount(0);

    await page.getByTestId("event-open-402").click();
    await page.getByTestId("event-select-all").click();
    await expect(page.getByTestId("event-selection-toolbar")).toContainText("2 selected");
    await page.getByTestId("event-move-selected").click();
    await page.getByLabel("Create New Group").click();
    await page.getByTestId("event-move-new-group-input").fill("road trip");
    await page.getByTestId("event-move-confirm").click();
    await expect(page.getByTestId("event-move-error")).toContainText("already exists");
    await page.getByTestId("event-move-new-group-input").fill("Family Reunion");
    await page.getByTestId("event-move-confirm").click();
    await expect(page.getByTestId("event-detail-back")).toBeVisible();
    await page.getByTestId("event-detail-back").click();
    await expect(page.getByTestId("event-group-403")).toContainText("2 items");
  });

  test("event detail supports individual and bulk soft delete plus excluded restore", async ({ page }) => {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-events").click();
    await page.getByTestId("event-open-401").click();

    await expect(page.getByTestId("event-media-exclude-901")).toBeVisible();
    await page.getByTestId("event-media-exclude-901").click();
    await expect(page.getByTestId("event-media-exclude-confirm-901")).toBeVisible();
    await page.getByTestId("event-media-exclude-confirm-cancel-901").click();
    await expect(page.getByTestId("event-media-item-901")).toBeVisible();

    await page.getByTestId("event-media-exclude-901").click();
    await page.getByTestId("event-media-exclude-confirm-yes-901").click();
    await expect(page.getByTestId("status-pill")).toContainText("Item moved to recycle");
    await expect(page.getByTestId("event-media-item-901")).toHaveCount(0);

    await page.getByTestId("event-media-select-902").click();
    await expect(page.getByTestId("event-exclude-selected")).toBeVisible();
    await page.getByTestId("event-exclude-selected").click();
    await expect(page.getByTestId("event-exclude-selected-confirmation")).toContainText("Move 1 items to recycle?");
    await page.getByTestId("event-exclude-selected-confirm").click();
    await expect(page.getByTestId("status-pill")).toContainText("1 items moved to recycle");
    await expect(page.getByTestId("event-media-item-902")).toHaveCount(0);

    await page.getByTestId("event-detail-back").click();
    await expect(page.getByTestId("event-group-401")).toContainText("0 items");
    await expect(page.getByTestId("event-delete-401")).toBeVisible();

    await page.getByTestId("event-open-401").click();
    await page.getByTestId("event-show-excluded").click();
    await expect(page.getByTestId("event-media-item-901")).toHaveAttribute("data-muted", "true");
    await expect(page.getByTestId("event-media-restore-901")).toBeVisible();
    await page.getByTestId("event-media-restore-901").click();
    await expect(page.getByTestId("status-pill")).toContainText("Item restored to group");
    await expect(page.getByTestId("event-media-item-901")).toHaveCount(0);

    await page.getByTestId("event-show-active").click();
    await expect(page.getByTestId("event-media-item-901")).toBeVisible();
    await page.getByTestId("event-detail-back").click();
    await expect(page.getByTestId("event-group-401")).toContainText("1 items");
  });

  test("saves settings sections without crashing", async ({ page }) => {
    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("settings-section-directories")).toBeVisible();
    await page.getByTestId("settings-working-directory").fill("C:\\fixture\\updated-inbox");
    await page.getByTestId("settings-output-directory").fill("C:\\fixture\\updated-output");
    await page.getByTestId("settings-save-directories").click();
    await expect(page.getByTestId("status-pill")).toContainText("saved");

    await page.getByTestId("settings-openai-key").fill("sk-test-key");
    await page.getByTestId("settings-save-openai-key").click();
    await expect(page.getByTestId("status-pill")).toContainText("OpenAI API key saved");
  });

  test("resets session without deleting files and keeps settings", async ({ page }) => {
    await expect(page.getByTestId("stat-total")).toContainText("8");
    await page.getByTestId("pipeline-reset-session").click();
    await expect(page.getByTestId("reset-session-dialog")).toBeVisible();
    await page.getByTestId("reset-session-keep-files").click();

    await expect(page.getByTestId("stat-total")).toContainText("0");
    await expect(page.getByTestId("stat-indexed")).toContainText("0");
    await expect(page.getByTestId("status-pill")).toContainText("Configuration was preserved");

    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("settings-working-directory")).toHaveValue("C:\\fixture\\inbox");
    await expect(page.getByTestId("settings-output-directory")).toHaveValue("C:\\fixture\\output");
  });

  test("resets session and deletes generated files", async ({ page }) => {
    await page.getByTestId("pipeline-reset-session").click();
    await expect(page.getByTestId("reset-session-dialog")).toBeVisible();
    await page.getByTestId("reset-session-delete-files").click();
    await expect(page.getByTestId("status-pill")).toContainText("Removed 3 generated directories");
    await expect(page.getByTestId("stat-total")).toContainText("0");
  });

  test("event detail grid recalculates responsive columns and row counts", async ({ page }) => {
    await installBrowserApiMock(page, "responsive");
    await page.goto("/");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-events").click();
    await page.getByTestId("event-open-401").click();
    await expect(page.getByTestId("event-group-detail-view")).toBeVisible();

    const grid = page.getByTestId("event-virtual-grid");
    const firstCard = page.locator("[data-thumbnail-card]").first();
    const overflowValue = await firstCard.evaluate((el) => window.getComputedStyle(el).overflow);
    expect(overflowValue).not.toBe("hidden");

    await page.setViewportSize({ width: 1200, height: 760 });
    const initialScrollHeight = Number(await grid.getAttribute("data-scroll-height"));
    expect(initialScrollHeight).toBeGreaterThan(0);

    await page.setViewportSize({ width: 1200, height: 980 });
    const resizedScrollHeight = Number(await grid.getAttribute("data-scroll-height"));
    expect(resizedScrollHeight).toBeGreaterThan(initialScrollHeight);

    const cases = [{ width: 800 }, { width: 1280 }, { width: 1440 }, { width: 1920 }];
    const observedColumns: number[] = [];

    for (const testCase of cases) {
      await page.setViewportSize({ width: testCase.width + 200, height: 980 });
      await grid.evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, testCase.width);

      const columns = Number(await grid.getAttribute("data-column-count"));
      const rows = Number(await grid.getAttribute("data-row-count"));
      expect(columns).toBeGreaterThan(0);
      expect(rows).toBe(Math.ceil(11 / columns));
      observedColumns.push(columns);

      const innerTotalSize = await page.getByTestId("event-virtual-grid-inner").evaluate((el) => {
        const totalSizeAttr = Number(el.getAttribute("data-total-size") ?? "0");
        const heightValue = parseFloat((el as HTMLElement).style.height);
        return { totalSizeAttr, heightValue };
      });
      expect(Math.round(innerTotalSize.heightValue)).toBe(Math.round(innerTotalSize.totalSizeAttr));

      await grid.evaluate((el) => {
        const viewport = el as HTMLElement;
        viewport.scrollTop = viewport.scrollHeight;
      });
      await page.waitForTimeout(50);

      const visibleRows = page.locator("[data-testid^='event-virtual-row-']");
      const visibleCount = await visibleRows.count();
      expect(visibleCount).toBeGreaterThan(0);
      for (let index = 0; index < visibleCount; index += 1) {
        const row = visibleRows.nth(index);
        await expect(row).toHaveAttribute("data-measure-element", "true");
        await expect(row).toHaveAttribute("data-index", /\d+/);
      }

      const emptyCells = await page.getByTestId("event-empty-slot").count();
      if (11 % columns !== 0) {
        expect(emptyCells).toBeGreaterThan(0);
      }
    }
    expect(new Set(observedColumns).size).toBeGreaterThan(1);
  });

  test("app layout avoids horizontal overflow at supported widths", async ({ page }) => {
    const widths = [800, 1280, 1440, 1920];

    for (const width of widths) {
      await page.setViewportSize({ width, height: 920 });
      await page.goto("/");
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByTestId("tab-videos").click();
      await page.getByTestId("video-done-proceed").click();

      for (const tabId of ["tab-dashboard", "tab-dates", "tab-videos", "tab-events", "tab-settings"]) {
        await page.getByTestId(tabId).click();
        const hasHorizontalOverflow = await page.evaluate(() => {
          const root = document.documentElement;
          return root.scrollWidth > root.clientWidth;
        });
        expect(hasHorizontalOverflow).toBeFalsy();
      }
    }
  });

  test("event group review grid expands card width with window size", async ({ page }) => {
    await page.goto("/");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();
    await page.getByTestId("tab-events").click();
    const grid = page.getByTestId("event-groups-review-grid");

    await page.setViewportSize({ width: 800, height: 920 });
    const narrowColumns = await grid.evaluate((el) => {
      const template = window.getComputedStyle(el).gridTemplateColumns.trim();
      return template ? template.split(/\s+/).length : 1;
    });

    await page.setViewportSize({ width: 1920, height: 920 });
    await expect(page.getByTestId("event-add-group-button")).toBeVisible();
    const wideColumns = await grid.evaluate((el) => {
      const template = window.getComputedStyle(el).gridTemplateColumns.trim();
      return template ? template.split(/\s+/).length : 1;
    });

    expect(wideColumns).toBeGreaterThanOrEqual(narrowColumns);
  });

  test("date approval preview scales responsively with max width", async ({ page }) => {
    await page.getByTestId("tab-dates").click();
    const thumb = page.getByTestId("date-thumb-301");

    await page.setViewportSize({ width: 800, height: 920 });
    const narrow = await thumb.evaluate((el) => el.getBoundingClientRect().width);

    await page.setViewportSize({ width: 1920, height: 920 });
    const wide = await thumb.evaluate((el) => el.getBoundingClientRect().width);

    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeLessThanOrEqual(600);
  });
});

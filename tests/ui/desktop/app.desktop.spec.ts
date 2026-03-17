import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { DesktopHarness } from "../helpers/desktopHarness";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test.describe("Memoria desktop UI", () => {
  const harness = new DesktopHarness();

  test.beforeAll(async () => {
    harness.seedFixture("regression-mixed");
  });

  test.afterAll(async () => {
    await harness.close();
  });

  test("renders seeded dashboard and event groups", async () => {
    const page = await harness.launch();
    await expect(page.getByTestId("stat-total")).not.toHaveText("0", { timeout: 30_000 });

    await expect(page.getByTestId("stat-date-review")).not.toContainText("0");
    await expect(page.getByTestId("stat-grouped")).not.toContainText("0");

    await page.evaluate(() => (window as any).__MEMORIA_SET_TAB__("dates"));
    await expect(page.locator("[data-testid^='date-thumb-']").first()).toBeVisible();

    await page.evaluate(() => (window as any).__MEMORIA_SET_TAB__("events"));
    await expect(page.getByTestId("event-groups-card")).toContainText("Ski Trip");
  });

  test("event groups support add/delete and detail navigation", async () => {
    const page = await harness.launch();
    await page.getByTestId("tab-events").click();

    const firstName = await page.locator("[data-testid^='event-rename-input-']").first().inputValue();
    await page.getByTestId("event-add-group-button").click();
    await page.getByTestId("event-add-group-input").fill(firstName.toUpperCase());
    await expect(page.getByTestId("event-add-group-error")).toContainText("already exists");

    await page.getByTestId("event-add-group-input").fill("Desktop New Group");
    await page.getByTestId("event-add-group-save").click();
    const createdCard = page.locator("[data-testid^='event-group-']").filter({ hasText: "Desktop New Group" });
    await expect(createdCard).toContainText("0 items");

    page.once("dialog", (dialog) => dialog.accept());
    await createdCard.getByRole("button", { name: "Delete" }).click();
    await expect(createdCard).toHaveCount(0);

    await page.locator("[data-testid^='event-open-']").first().click();
    await expect(page.getByTestId("event-group-detail-view")).toBeVisible();
    await expect(page.getByTestId("event-virtual-grid")).toBeVisible();
    await page.locator("[data-testid^='event-media-preview-']").first().click();
    await expect(page.getByTestId("event-preview-overlay")).toBeVisible();
    await page.getByTestId("event-preview-close").click();
    await page.getByTestId("event-detail-back").click();
    await expect(page.getByTestId("event-group-detail-view")).toHaveCount(0);
  });

  test("date approval shows rendered thumbnails and approve/skip actions work", async () => {
    const review1 = `${harness.outputRoot}\\staging\\IMG_DATE_REVIEW_001.png`;
    const review2 = `${harness.outputRoot}\\staging\\IMG_DATE_REVIEW_002.png`;
    expect(existsSync(review1)).toBeTruthy();
    expect(existsSync(review2)).toBeTruthy();

    const page = await harness.launch();
    await page.getByTestId("tab-dates").click();

    const dateItems = page.locator("[data-testid^='date-item-']");
    await expect(dateItems).toHaveCount(2);

    const firstThumb = page.locator("[data-testid^='date-thumb-']").first();
    await expect(firstThumb).toBeVisible();
    await expect
      .poll(async () => {
        return await firstThumb.evaluate((img) => {
          const el = img as HTMLImageElement;
          const visuallyDecoded = el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 60;
          const src = el.currentSrc || el.src;
          const isFallbackSvg = src.includes("image/svg+xml");
          return visuallyDecoded && !isFallbackSvg;
        });
      })
      .toBeTruthy();

    await page.getByTestId("date-input-2").fill("2026-01-15");
    await page.getByTestId("date-approve-2").click();
    await expect(dateItems).toHaveCount(1);
    await expect(page.getByTestId("status-pill")).toContainText("Approved date 2026-01-15");

    await page.getByTestId("date-skip-3").click();
    await expect(dateItems).toHaveCount(0);
    await expect(page.getByTestId("status-pill")).toContainText("Skipped date approval");
  });

  test("date approval can proceed to event grouping without FK failure", async () => {
    harness.seedFixture("regression-mixed");
    const page = await harness.launch();
    await page.getByTestId("tab-images").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("image-done-proceed").click();

    await page.getByTestId("tab-videos").click();
    await page.getByTestId("video-done-proceed").click();

    await page.getByTestId("tab-dates").click();
    await expect(page.getByTestId("date-approval-card")).toBeVisible();
    while (true) {
      const enabledSkipButton = page.locator("[data-testid^='date-skip-']:not([disabled])").first();
      if ((await enabledSkipButton.count()) === 0) {
        break;
      }
      await enabledSkipButton.click();
      await page.waitForTimeout(100);
    }
    await expect(page.locator("[data-testid^='date-item-']")).toHaveCount(0);

    await page.getByTestId("date-done-proceed-events").click();
    await expect(page.getByTestId("status-pill")).toContainText("Event grouping complete.");
    await expect(page.getByTestId("status-pill")).not.toContainText("Grouping failed");
    await expect(page.getByTestId("event-groups-card")).toBeVisible();
  });

  test("resets session and optionally deletes generated output directories", async () => {
    const page = await harness.launch();
    await page.getByTestId("tab-dashboard").click();

    const stagingDir = `${harness.outputRoot}\\staging`;
    const organizedDir = `${harness.outputRoot}\\organized`;
    const recycleDir = `${harness.outputRoot}\\recycle`;
    expect(existsSync(stagingDir)).toBeTruthy();
    expect(existsSync(organizedDir)).toBeTruthy();
    expect(existsSync(recycleDir)).toBeTruthy();

    await page.getByTestId("pipeline-reset-session").click();
    await expect(page.getByTestId("reset-session-dialog")).toBeVisible();
    await page.getByTestId("reset-session-delete-files").click();

    await expect(page.getByTestId("stat-total")).toContainText("0");
    await expect(page.getByTestId("stat-indexed")).toContainText("0");
    await expect(page.getByTestId("stat-grouped")).toContainText("0");
    await expect(page.getByTestId("status-pill")).toContainText("Removed");
    await expect(page.getByTestId("tab-settings")).toBeVisible();

    expect(existsSync(stagingDir)).toBeFalsy();
    expect(existsSync(organizedDir)).toBeFalsy();
    expect(existsSync(recycleDir)).toBeFalsy();
  });
});

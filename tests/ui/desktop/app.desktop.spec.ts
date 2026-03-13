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

  test("renders seeded dashboard/review/groups and opens thumbnail lightbox", async () => {
    const page = await harness.launch();
    await page.getByTestId("tab-dashboard").click();

    await expect(page.getByTestId("stat-review")).not.toContainText("0");
    await expect(page.getByTestId("stat-grouped")).not.toContainText("0");

    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("duplicate-clusters")).toBeVisible();

    const duplicateThumb = page.getByAltText("duplicate_fixture_1.png");
    await expect(duplicateThumb).toBeVisible();
    await duplicateThumb.click();

    await expect(page.getByTestId("lightbox-dialog")).toBeVisible();
    await expect(page.getByTestId("lightbox-image")).toBeVisible();
    await page.getByTestId("lightbox-close").click();

    await page.getByTestId("tab-events").click();
    await expect(page.getByTestId("event-groups-card")).toContainText("Ski Trip");
  });

  test("resets session and optionally deletes generated output directories", async () => {
    const page = await harness.launch();
    await page.getByTestId("tab-dashboard").click();

    const stagingDir = `${harness.outputRoot}\\staging`;
    const reviewDir = `${harness.outputRoot}\\review`;
    const organizedDir = `${harness.outputRoot}\\organized`;
    const recycleDir = `${harness.outputRoot}\\recycle`;
    expect(existsSync(stagingDir)).toBeTruthy();
    expect(existsSync(reviewDir)).toBeTruthy();
    expect(existsSync(organizedDir)).toBeTruthy();
    expect(existsSync(recycleDir)).toBeTruthy();

    await page.getByTestId("pipeline-reset-session").click();
    await expect(page.getByTestId("reset-session-dialog")).toBeVisible();
    await page.getByTestId("reset-session-delete-files").click();

    await expect(page.getByTestId("stat-total")).toContainText("0");
    await expect(page.getByTestId("stat-review")).toContainText("0");
    await expect(page.getByTestId("stat-grouped")).toContainText("0");
    await expect(page.getByTestId("status-pill")).toContainText("Removed");
    await expect(page.getByTestId("tab-settings")).toBeVisible();

    expect(existsSync(stagingDir)).toBeFalsy();
    expect(existsSync(reviewDir)).toBeFalsy();
    expect(existsSync(organizedDir)).toBeFalsy();
    expect(existsSync(recycleDir)).toBeFalsy();
  });
});

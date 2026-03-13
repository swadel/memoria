import { expect, test } from "@playwright/test";
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
});

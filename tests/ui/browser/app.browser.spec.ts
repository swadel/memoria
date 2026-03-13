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
    await expect(page.getByTestId("pipeline-group")).toBeVisible();
    await expect(page.getByTestId("pipeline-finalize")).toBeVisible();
  });

  test("removes orphaned dashboard controls and review queue UI", async ({ page }) => {
    await expect(page.getByTestId("tab-review")).toHaveCount(0);
    await expect(page.getByTestId("pipeline-classify")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-working-directory")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-output-directory")).toHaveCount(0);
    await expect(page.getByTestId("pipeline-progress-track")).toHaveCount(0);
  });

  test("handles date approval and event renaming", async ({ page }) => {
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

    await page.getByTestId("tab-events").click();
    await page.getByTestId("event-rename-input-401").fill("Playwright Renamed Event");
    await page.getByTestId("event-rename-save-401").click();
    await expect(page.getByTestId("event-group-401")).toContainText("2026 - Playwright Renamed Event");
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
});

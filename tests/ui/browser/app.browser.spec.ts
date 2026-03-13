import { expect, test } from "@playwright/test";
import { installBrowserApiMock } from "../helpers/browserMock";

test.describe("Memoria browser UI smoke", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserApiMock(page, "all");
    await page.goto("/");
  });

  test("renders dashboard and pipeline actions", async ({ page }) => {
    await expect(page.getByTestId("layout-root")).toBeVisible();
    await expect(page.getByTestId("stat-total")).toContainText("8");
    await expect(page.getByTestId("pipeline-index")).toBeVisible();
    await expect(page.getByTestId("pipeline-classify")).toBeVisible();
    await expect(page.getByTestId("pipeline-group")).toBeVisible();
    await expect(page.getByTestId("pipeline-finalize")).toBeVisible();
  });

  test("supports review queue filtering and actions", async ({ page }) => {
    await page.getByTestId("tab-review").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await page.getByTestId("review-reason-filter").selectOption("screenshot");
    await expect(page.getByTestId("review-item-101")).toBeVisible();

    await page.getByTestId("review-select-101").check();
    await page.getByTestId("review-include").click();
    await expect(page.getByTestId("status-pill")).toContainText("Applied 'include'");
  });

  test("opens lightbox and navigates duplicate cluster", async ({ page }) => {
    await page.getByTestId("tab-review").click();
    await page.getByTestId("review-thumb-201").click();
    await expect(page.getByTestId("lightbox-dialog")).toBeVisible();
    await page.getByTestId("lightbox-next").click();
    await page.getByTestId("lightbox-prev").click();
    await page.getByTestId("lightbox-close").click();
    await expect(page.getByTestId("lightbox-dialog")).toBeHidden();
  });

  test("handles date approval and event renaming", async ({ page }) => {
    await page.getByTestId("tab-dates").click();
    await expect(page.getByTestId("date-item-301")).toBeVisible();
    await page.getByTestId("date-approve-301").click();
    await expect(page.getByTestId("status-pill")).not.toContainText("failed");

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
    await expect(page.getByTestId("stat-review")).toContainText("0");
    await expect(page.getByTestId("status-pill")).toContainText("Configuration was preserved");

    await page.getByTestId("tab-settings").click();
    await expect(page.getByTestId("settings-working-directory")).toHaveValue("C:\\fixture\\inbox");
    await expect(page.getByTestId("settings-output-directory")).toHaveValue("C:\\fixture\\output");
  });

  test("resets session and deletes generated files", async ({ page }) => {
    await page.getByTestId("pipeline-reset-session").click();
    await expect(page.getByTestId("reset-session-dialog")).toBeVisible();
    await page.getByTestId("reset-session-delete-files").click();
    await expect(page.getByTestId("status-pill")).toContainText("Removed 4 generated directories");
    await expect(page.getByTestId("stat-total")).toContainText("0");
  });
});

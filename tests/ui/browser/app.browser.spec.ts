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

  test("event groups enforce uniqueness and support detail move flows", async ({ page }) => {
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

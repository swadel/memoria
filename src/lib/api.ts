import { invoke } from "@tauri-apps/api/core";
import type { DashboardStats, DateEstimate, EventGroup, MediaItem } from "../types";

export interface SessionInput {
  workingDirectory: string;
  outputDirectory: string;
}

export interface AppConfiguration {
  workingDirectory: string;
  outputDirectory: string;
  aiTaskModels: {
    classification: { provider: string; model: string };
    dateEstimation: { provider: string; model: string };
    eventNaming: { provider: string; model: string };
    duplicateRanking: { provider: string; model: string };
  };
}

export function initializeApp() {
  return invoke<void>("initialize_app");
}

export function startDownloadSession(input: SessionInput) {
  return invoke<number>("start_download_session", { input });
}

export function setOutputDirectory(path: string) {
  return invoke<void>("set_output_directory", { path });
}

export function setWorkingDirectory(path: string) {
  return invoke<void>("set_working_directory", { path });
}

export function setOpenAiKey(apiKey: string) {
  return invoke<void>("set_openai_key", { api_key: apiKey });
}

export function setAnthropicKey(apiKey: string) {
  return invoke<void>("set_anthropic_key", { api_key: apiKey });
}

export function setAiTaskModel(
  task: "classification" | "dateEstimation" | "eventNaming" | "duplicateRanking",
  provider: "openai" | "anthropic",
  model: string
) {
  return invoke<void>("set_ai_task_model", { task, provider, model });
}

export function getAppConfiguration() {
  return invoke<AppConfiguration>("get_app_configuration");
}

export function getDashboardStats() {
  return invoke<DashboardStats>("get_dashboard_stats");
}

export function runClassification() {
  return invoke<void>("run_classification");
}

export function getReviewQueue() {
  return invoke<MediaItem[]>("get_review_queue");
}

export function applyReviewAction(ids: number[], action: "include" | "delete") {
  return invoke<void>("apply_review_action", { ids, action });
}

export function confirmDuplicateKeep(mediaItemId: number) {
  return invoke<void>("confirm_duplicate_keep", { media_item_id: mediaItemId });
}

export function getDateReviewQueue() {
  return invoke<DateEstimate[]>("get_date_review_queue");
}

export function applyDateApproval(mediaItemId: number, date: string | null) {
  return invoke<void>("apply_date_approval", { media_item_id: mediaItemId, date });
}

export function runEventGrouping() {
  return invoke<void>("run_event_grouping");
}

export function getEventGroups() {
  return invoke<EventGroup[]>("get_event_groups");
}

export function renameEventGroup(groupId: number, name: string) {
  return invoke<void>("rename_event_group", { group_id: groupId, name });
}

export function finalizeOrganization() {
  return invoke<void>("finalize_organization");
}

import { invoke } from "@tauri-apps/api/core";
import type { DashboardStats, DateEstimate, EventGroup, MediaItem } from "../types";

declare global {
  interface Window {
    __MEMORIA_TEST_API__?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}

function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  if (window.__MEMORIA_TEST_API__) {
    return window.__MEMORIA_TEST_API__.invoke<T>(command, args);
  }
  return invoke<T>(command, args);
}

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

export interface ResetSessionResult {
  deletedGeneratedFiles: boolean;
  removedDirectories: string[];
}

export interface ToolHealth {
  exiftoolAvailable: boolean;
  exiftoolPath: string | null;
  ffmpegAvailable: boolean;
  ffmpegPath: string | null;
}

export function initializeApp() {
  return invokeCommand<void>("initialize_app");
}

export function startDownloadSession(input: SessionInput) {
  return invokeCommand<number>("start_download_session", { input });
}

export function setOutputDirectory(path: string) {
  return invokeCommand<void>("set_output_directory", { path });
}

export function setWorkingDirectory(path: string) {
  return invokeCommand<void>("set_working_directory", { path });
}

export function setOpenAiKey(apiKey: string) {
  return invokeCommand<void>("set_openai_key", { apiKey });
}

export function setAnthropicKey(apiKey: string) {
  return invokeCommand<void>("set_anthropic_key", { apiKey });
}

export function setAiTaskModel(
  task: "classification" | "dateEstimation" | "eventNaming" | "duplicateRanking",
  provider: "openai" | "anthropic",
  model: string
) {
  return invokeCommand<void>("set_ai_task_model", { task, provider, model });
}

export function getAppConfiguration() {
  return invokeCommand<AppConfiguration>("get_app_configuration");
}

export function getToolHealth() {
  return invokeCommand<ToolHealth>("get_tool_health");
}

export function getDashboardStats() {
  return invokeCommand<DashboardStats>("get_dashboard_stats");
}

export function runClassification() {
  return invokeCommand<void>("run_classification");
}

export function getReviewQueue() {
  return invokeCommand<MediaItem[]>("get_review_queue");
}

export function applyReviewAction(ids: number[], action: "include" | "delete") {
  return invokeCommand<void>("apply_review_action", { ids, action });
}

export function confirmDuplicateKeep(mediaItemId: number) {
  return invokeCommand<void>("confirm_duplicate_keep", { media_item_id: mediaItemId });
}

export function getDateReviewQueue() {
  return invokeCommand<DateEstimate[]>("get_date_review_queue");
}

export function applyDateApproval(mediaItemId: number, date: string | null) {
  return invokeCommand<void>("apply_date_approval", { media_item_id: mediaItemId, date });
}

export function runEventGrouping() {
  return invokeCommand<void>("run_event_grouping");
}

export function getEventGroups() {
  return invokeCommand<EventGroup[]>("get_event_groups");
}

export function renameEventGroup(groupId: number, name: string) {
  return invokeCommand<void>("rename_event_group", { group_id: groupId, name });
}

export function finalizeOrganization() {
  return invokeCommand<void>("finalize_organization");
}

export function resetSession(deleteGeneratedFiles: boolean) {
  return invokeCommand<ResetSessionResult>("reset_session", { deleteGeneratedFiles });
}

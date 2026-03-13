import { invoke } from "@tauri-apps/api/core";
import type { DashboardStats, DateEstimate, EventGroup, EventGroupItem, VideoReviewItem } from "../types";

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
    dateEstimation: { provider: string; model: string };
    eventNaming: { provider: string; model: string };
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
  task: "dateEstimation" | "eventNaming",
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

export function getDateReviewQueue() {
  return invokeCommand<DateEstimate[]>("get_date_review_queue");
}

export function getDateMediaThumbnail(mediaItemId: number) {
  return invokeCommand<string | null>("get_date_media_thumbnail", { mediaItemId, media_item_id: mediaItemId });
}

export function applyDateApproval(mediaItemId: number, date: string | null) {
  return invokeCommand<void>("apply_date_approval", { mediaItemId, media_item_id: mediaItemId, date });
}

export function runEventGrouping() {
  return invokeCommand<void>("run_event_grouping");
}

export function getEventGroups() {
  return invokeCommand<EventGroup[]>("get_event_groups");
}

export function renameEventGroup(groupId: number, name: string) {
  return invokeCommand<void>("rename_event_group", { groupId, group_id: groupId, name });
}

export function createEventGroup(name: string) {
  return invokeCommand<EventGroup>("create_event_group", { name });
}

export function deleteEventGroup(groupId: number) {
  return invokeCommand<void>("delete_event_group", { groupId, group_id: groupId });
}

export function getEventGroupItems(groupId: number, showExcluded = false) {
  return invokeCommand<EventGroupItem[]>("get_event_group_items", {
    groupId,
    group_id: groupId,
    showExcluded,
    show_excluded: showExcluded
  });
}

export function getEventGroupMediaPreview(mediaItemId: number) {
  return invokeCommand<string | null>("get_event_group_media_preview", {
    mediaItemId,
    media_item_id: mediaItemId
  });
}

export function moveEventGroupItems(mediaItemIds: number[], destinationGroupId: number) {
  return invokeCommand<void>("move_event_group_items", {
    mediaItemIds,
    media_item_ids: mediaItemIds,
    destinationGroupId,
    destination_group_id: destinationGroupId
  });
}

export function createEventGroupAndMove(name: string, mediaItemIds: number[]) {
  return invokeCommand<EventGroup>("create_event_group_and_move", {
    name,
    mediaItemIds,
    media_item_ids: mediaItemIds
  });
}

export function finalizeOrganization() {
  return invokeCommand<void>("finalize_organization");
}

export function getVideoReviewItems(includeExcluded: boolean) {
  return invokeCommand<VideoReviewItem[]>("get_video_review_items", { includeExcluded, include_excluded: includeExcluded });
}

export function excludeVideos(mediaItemIds: number[]) {
  return invokeCommand<number>("exclude_videos", { mediaItemIds, media_item_ids: mediaItemIds });
}

export function restoreVideos(mediaItemIds: number[]) {
  return invokeCommand<number>("restore_videos", { mediaItemIds, media_item_ids: mediaItemIds });
}

export function completeVideoReviewAndRunGrouping() {
  return invokeCommand<void>("complete_video_review_and_run_grouping");
}

export function excludeMediaItem(mediaItemId: number) {
  return invokeCommand<void>("exclude_media_item", { mediaItemId, media_item_id: mediaItemId });
}

export function restoreMediaItem(mediaItemId: number) {
  return invokeCommand<void>("restore_media_item", { mediaItemId, media_item_id: mediaItemId });
}

export function excludeMediaItems(mediaItemIds: number[]) {
  return invokeCommand<number>("exclude_media_items", { mediaItemIds, media_item_ids: mediaItemIds });
}

export function resetSession(deleteGeneratedFiles: boolean) {
  return invokeCommand<ResetSessionResult>("reset_session", { deleteGeneratedFiles });
}

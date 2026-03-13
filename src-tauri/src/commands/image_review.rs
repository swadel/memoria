use anyhow::Result;
use tauri::State;

use crate::{
    models::ImageReviewItemDto,
    services::{image_review, runtime_log, video_review},
    AppState,
};

#[tauri::command]
pub fn run_image_review_scan(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        image_review::run_image_review_scan(&conn)
            .await
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn get_image_review_items(include_excluded: bool, state: State<'_, AppState>) -> Result<Vec<ImageReviewItemDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_image_review_items(&conn, include_excluded).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keep_best_only(burst_group_id: String, state: State<'_, AppState>) -> Result<usize, String> {
    let mut conn = state.open_conn().map_err(|e| e.to_string())?;
    image_review::keep_best_only(&mut conn, burst_group_id.as_str(), &state.root_output()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keep_all_burst(burst_group_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    image_review::keep_all_burst(&conn, burst_group_id.as_str()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn complete_image_review_and_start_video_review(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        runtime_log::info("commands.image_review", "Completing image review phase.");
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        image_review::complete_image_review(&conn).map_err(|e| e.to_string())?;
        video_review::prepare_video_review(&conn, &state.root_output())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

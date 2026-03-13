use anyhow::Result;
use tauri::State;

use crate::{models::VideoReviewItemDto, services::{event_grouper, runtime_log, video_review}, AppState};

#[tauri::command]
pub fn get_video_review_items(include_excluded: bool, state: State<'_, AppState>) -> Result<Vec<VideoReviewItemDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_video_review_items(&conn, include_excluded).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exclude_videos(media_item_ids: Vec<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    runtime_log::info("commands.video_review", format!("Excluding {} videos.", media_item_ids.len()));
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    video_review::exclude_videos(&conn, &state.root_output(), &media_item_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_videos(media_item_ids: Vec<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    runtime_log::info("commands.video_review", format!("Restoring {} videos.", media_item_ids.len()));
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    video_review::restore_videos(&conn, &state.root_output(), &media_item_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn complete_video_review_and_run_grouping(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(complete_video_review_and_run_grouping_impl(&state)).map_err(|e| e.to_string())
}

pub async fn complete_video_review_and_run_grouping_impl(state: &AppState) -> Result<()> {
    let conn = state.open_conn()?;
    video_review::complete_video_review(&conn)?;
    let ai = state.ai_client().await;
    event_grouper::run(&conn, &ai).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::complete_video_review_and_run_grouping_impl;
    use crate::{db::init_db, AppState};
    use std::{path::PathBuf, sync::{Arc, Mutex}};

    fn app_state_for(db_path: PathBuf) -> AppState {
        let base = db_path.parent().unwrap_or_else(|| std::path::Path::new(".")).to_path_buf();
        AppState {
            db_path,
            base_dir: base,
            default_output_dir: Arc::new(Mutex::new(Some(std::env::temp_dir().to_string_lossy().to_string()))),
        }
    }

    #[tokio::test]
    async fn pipeline_transitions_video_review_to_grouping() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-video-pipeline-{}.db", rand::random::<u64>()));
        let conn = init_db(&db_path).expect("db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, date_taken)
             VALUES('x1', 'v1.mov', 'C:\\tmp\\v1.mov', 'excluded', 'video/quicktime', '2026-01-01')",
            [],
        )
        .expect("insert");
        drop(conn);
        let app = app_state_for(db_path.clone());
        complete_video_review_and_run_grouping_impl(&app)
            .await
            .expect("transition");
        let conn2 = init_db(&db_path).expect("reopen");
        let state = crate::db::get_setting(&conn2, "video_review_phase_state")
            .expect("state")
            .unwrap_or_default();
        assert_eq!(state, "complete");
    }
}

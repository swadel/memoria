use anyhow::Result;
use tauri::State;

use crate::{models::VideoReviewItemDto, services::{runtime_log, video_review}, AppState};

#[tauri::command]
pub fn get_video_review_items(include_excluded: bool, state: State<'_, AppState>) -> Result<Vec<VideoReviewItemDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_video_review_items(&conn, include_excluded).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exclude_videos(media_item_ids: Vec<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    runtime_log::info("commands.video_review", format!("Excluding {} videos.", media_item_ids.len()));
    let mut conn = state.open_conn().map_err(|e| e.to_string())?;
    video_review::exclude_videos(&mut conn, &state.root_output(), &media_item_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_videos(media_item_ids: Vec<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    runtime_log::info("commands.video_review", format!("Restoring {} videos.", media_item_ids.len()));
    let mut conn = state.open_conn().map_err(|e| e.to_string())?;
    video_review::restore_videos(&mut conn, &state.root_output(), &media_item_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exclude_media_item(media_item_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    exclude_media_item_impl(media_item_id, &state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_media_item(media_item_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    restore_media_item_impl(media_item_id, &state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exclude_media_items(media_item_ids: Vec<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    let mut conn = state.open_conn().map_err(|e| e.to_string())?;
    video_review::exclude_media_items(
        &mut conn,
        &state.root_output(),
        &media_item_ids,
        &["indexed", "image_reviewed", "video_reviewed", "date_verified", "grouped"],
    )
        .map_err(|e| e.to_string())
}

fn exclude_media_item_impl(media_item_id: i64, state: &AppState) -> Result<()> {
    let mut conn = state.open_conn()?;
    video_review::exclude_media_items(
        &mut conn,
        &state.root_output(),
        &[media_item_id],
        &["indexed", "image_reviewed", "video_reviewed", "date_verified", "grouped"],
    )?;
    Ok(())
}

fn restore_media_item_impl(media_item_id: i64, state: &AppState) -> Result<()> {
    let mut conn = state.open_conn()?;
    let restore_status = conn.query_row(
        "SELECT CASE
            WHEN event_group_id IS NOT NULL THEN 'grouped'
            WHEN mime_type LIKE 'video/%' THEN 'image_reviewed'
            ELSE 'indexed'
         END
         FROM media_items WHERE id=?1",
        [media_item_id],
        |r| r.get::<_, String>(0),
    )?;
    video_review::restore_media_items(&mut conn, &state.root_output(), &[media_item_id], restore_status.as_str())?;
    Ok(())
}

#[tauri::command]
pub fn complete_video_review_and_run_grouping(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(complete_video_review_and_run_grouping_impl(&state, Some(&app_handle))).map_err(|e| e.to_string())
}

pub async fn complete_video_review_and_run_grouping_impl(state: &AppState, app_handle: Option<&tauri::AppHandle>) -> Result<()> {
    let conn = state.open_conn()?;
    video_review::complete_video_review(&conn)?;
    let _ = app_handle; // reserved for future progress emission
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{complete_video_review_and_run_grouping_impl, exclude_media_item_impl, restore_media_item_impl};
    use crate::{db::init_db, AppState};
    use rusqlite::params;
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
        complete_video_review_and_run_grouping_impl(&app, None)
            .await
            .expect("transition");
        let conn2 = init_db(&db_path).expect("reopen");
        let state = crate::db::get_setting(&conn2, "video_review_phase_state")
            .expect("state")
            .unwrap_or_default();
        assert_eq!(state, "complete");
    }

    #[test]
    fn exclude_and_restore_media_item_commands_move_and_log() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-video-cmd-{}.db", rand::random::<u64>()));
        let conn = init_db(&db_path).expect("db");
        let root = std::env::temp_dir().join(format!("memoria-video-cmd-root-{}", rand::random::<u64>()));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("staging");
        let src = staging.join("cmd.jpg");
        std::fs::write(&src, b"img").expect("file");
        conn.execute(
            "INSERT INTO event_groups(id, year, name, folder_name, item_count, user_approved) VALUES(2, 2026, 'Group', '2026 - Group', 0, 1)",
            [],
        )
        .expect("group");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, event_group_id)
             VALUES(?1, ?2, ?3, 'grouped', 'image/jpeg', 2)",
            params!["cmd-1", "cmd.jpg", src.to_string_lossy().to_string()],
        )
        .expect("insert");
        let id = conn.last_insert_rowid();
        drop(conn);
        let app = AppState {
            db_path: db_path.clone(),
            base_dir: root.clone(),
            default_output_dir: Arc::new(Mutex::new(Some(root.to_string_lossy().to_string()))),
        };
        exclude_media_item_impl(id, &app).expect("exclude");
        restore_media_item_impl(id, &app).expect("restore");
        let conn2 = init_db(&db_path).expect("db2");
        let status: String = conn2
            .query_row("SELECT status FROM media_items WHERE id=?1", [id], |r| r.get(0))
            .expect("status");
        assert_eq!(status, "grouped");
        let excluded_count: i64 = conn2
            .query_row("SELECT COUNT(*) FROM audit_log WHERE media_item_id=?1 AND action='excluded'", [id], |r| r.get(0))
            .expect("excluded count");
        let restored_count: i64 = conn2
            .query_row("SELECT COUNT(*) FROM audit_log WHERE media_item_id=?1 AND action='restored'", [id], |r| r.get(0))
            .expect("restored count");
        assert_eq!(excluded_count, 1);
        assert_eq!(restored_count, 1);
    }
}

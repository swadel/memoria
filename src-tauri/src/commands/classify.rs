use anyhow::Result;
use rusqlite::params;
use std::path::PathBuf;
use tauri::State;

use crate::{
    models::DateEstimateDto,
    services::{classifier, date_enforcer, exiftool},
    AppState,
};

#[tauri::command]
pub fn run_classification(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let ai = state.ai_client().await;
        classifier::run(&conn, &ai).await.map_err(|e| e.to_string())?;
        stage_review_items(&conn, &state).await.map_err(|e| e.to_string())?;
        date_enforcer::evaluate(&conn, &ai)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_review_queue(state: State<'_, AppState>) -> Result<Vec<crate::models::MediaItemDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_review_queue(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_review_action(ids: Vec<i64>, action: String, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(apply_review_action_impl(ids, &action, &state))
        .map_err(|e| e.to_string())
}

async fn apply_review_action_impl(ids: Vec<i64>, action: &str, state: &AppState) -> Result<()> {
    let conn = state.open_conn()?;
    let recycle_dir = state.root_output().join("recycle");
    let review_dir = state.root_output().join("review");
    tokio::fs::create_dir_all(&recycle_dir).await?;
    tokio::fs::create_dir_all(&review_dir).await?;

    for id in ids {
        let current_path: String = conn.query_row(
            "SELECT COALESCE(current_path, '') FROM media_items WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let filename: String = conn.query_row("SELECT filename FROM media_items WHERE id=?1", [id], |r| r.get(0))?;
        let current = PathBuf::from(&current_path);
        let target = if action == "delete" {
            recycle_dir.join(filename)
        } else {
            current.clone()
        };
        if action == "delete" {
            let _ = tokio::fs::copy(&current, &target).await;
        }
        let new_class = if action == "delete" {
            "deleted"
        } else {
            "legitimate"
        };
        let new_status = if action == "delete" {
            "classified"
        } else {
            "date_verified"
        };
        conn.execute(
            "UPDATE media_items
             SET classification=?1, classification_source='user', current_path=?2, status=?3, updated_at=CURRENT_TIMESTAMP
             WHERE id=?4",
            params![new_class, target.to_string_lossy().to_string(), new_status, id],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value)
             VALUES(?1, 'review_action', 'user', ?2)",
            params![id, new_class],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_date_review_queue(state: State<'_, AppState>) -> Result<Vec<DateEstimateDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_date_review_queue(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_date_approval(media_item_id: i64, date: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        date_enforcer::apply_date_approval(&conn, media_item_id, date)
            .await
            .map_err(|e| e.to_string())
    })
}

async fn stage_review_items(conn: &rusqlite::Connection, state: &AppState) -> Result<()> {
    let review_dir = state.root_output().join("review");
    let thumbs_dir = review_dir.join(".thumbnails");
    tokio::fs::create_dir_all(&review_dir).await?;
    tokio::fs::create_dir_all(&thumbs_dir).await?;
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, '') FROM media_items WHERE classification='review'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, filename, current_path) = row?;
        let current = PathBuf::from(&current_path);
        let target = review_dir.join(&filename);
        if current != target {
            let _ = tokio::fs::copy(&current, &target).await;
            conn.execute(
                "UPDATE media_items SET current_path=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                params![target.to_string_lossy().to_string(), id],
            )?;
        }
        // Best-effort thumbnail generation (especially useful for HEIC on Windows).
        let thumb_path = thumbs_dir.join(format!("{id}.jpg"));
        let _ = exiftool::create_thumbnail_ffmpeg(&target, &thumb_path).await;
    }
    Ok(())
}

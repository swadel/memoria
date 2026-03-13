use anyhow::Result;
use base64::Engine;
use rusqlite::params;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{
    models::DateEstimateDto,
    services::{classifier, date_enforcer, exiftool, review_rules},
    AppState,
};

#[tauri::command]
pub fn run_classification(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let ai = state.ai_client().await;
        classifier::run(&conn, &ai).await.map_err(|e| e.to_string())?;
        review_rules::apply(&conn, &ai).await.map_err(|e| e.to_string())?;
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
pub async fn get_media_preview(media_item_id: i64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let current_path: String = conn
        .query_row(
            "SELECT COALESCE(current_path, '') FROM media_items WHERE id=?1",
            [media_item_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let current = PathBuf::from(current_path);
    if current.as_os_str().is_empty() {
        return Ok(None);
    }

    for thumb in thumbnail_candidates(&current, media_item_id) {
        if let Some(url) = read_as_data_url(&thumb).await.map_err(|e| e.to_string())? {
            return Ok(Some(url));
        }
    }

    if is_image_copy_candidate(&current) {
        return read_as_data_url(&current).await.map_err(|e| e.to_string());
    }
    Ok(None)
}

#[tauri::command]
pub async fn get_media_full_resolution(media_item_id: i64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let current_path: String = conn
        .query_row(
            "SELECT COALESCE(current_path, '') FROM media_items WHERE id=?1",
            [media_item_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let current = PathBuf::from(current_path);
    if current.as_os_str().is_empty() {
        return Ok(None);
    }

    if is_image_copy_candidate(&current) {
        if let Some(url) = read_as_data_url(&current).await.map_err(|e| e.to_string())? {
            return Ok(Some(url));
        }
    }

    for thumb in thumbnail_candidates(&current, media_item_id) {
        if let Some(url) = read_as_data_url(&thumb).await.map_err(|e| e.to_string())? {
            return Ok(Some(url));
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn apply_review_action(ids: Vec<i64>, action: String, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(apply_review_action_impl(ids, &action, &state))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn confirm_duplicate_keep(media_item_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(confirm_duplicate_keep_impl(media_item_id, &state))
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
             SET classification=?1, classification_source='user', review_reason=?2, review_reason_details=?3, current_path=?4, status=?5, updated_at=CURRENT_TIMESTAMP
             WHERE id=?6",
            params![
                new_class,
                if action == "delete" { Some("user_marked_delete".to_string()) } else { None },
                if action == "delete" {
                    Some(serde_json::json!({"reason":"user_marked_delete"}).to_string())
                } else {
                    None
                },
                target.to_string_lossy().to_string(),
                new_status,
                id
            ],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value)
             VALUES(?1, 'review_action', 'user', ?2)",
            params![id, new_class],
        )?;
    }
    Ok(())
}

async fn confirm_duplicate_keep_impl(media_item_id: i64, state: &AppState) -> Result<()> {
    let conn = state.open_conn()?;
    confirm_duplicate_keep_with_conn(&conn, media_item_id)
}

fn confirm_duplicate_keep_with_conn(conn: &rusqlite::Connection, media_item_id: i64) -> Result<()> {
    let (cluster_id, filename): (Option<String>, String) = conn.query_row(
        "SELECT duplicate_cluster_id, filename FROM media_items WHERE id=?1",
        [media_item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let Some(cluster_id) = cluster_id.filter(|v| !v.trim().is_empty()) else {
        return Err(anyhow::anyhow!("Selected media item is not part of a duplicate cluster."));
    };

    conn.execute(
        "UPDATE media_items
         SET classification='legitimate', classification_source='user', review_reason=NULL,
             review_reason_details=?1, status='classified', updated_at=CURRENT_TIMESTAMP
         WHERE id=?2",
        params![
            serde_json::json!({
                "reason":"duplicate_keep_confirmed",
                "clusterId": cluster_id,
                "confirmedByUser": true
            })
            .to_string(),
            media_item_id
        ],
    )?;
    conn.execute(
        "UPDATE media_items
         SET classification='review', classification_source='rule', review_reason='duplicate_non_best',
             review_reason_details=?1, status='classified', updated_at=CURRENT_TIMESTAMP
         WHERE duplicate_cluster_id=?2 AND id != ?3 AND (classification IS NULL OR classification != 'deleted')",
        params![
            serde_json::json!({
                "reason":"duplicate_non_best",
                "clusterId": cluster_id,
                "winnerId": media_item_id,
                "winnerFilename": filename
            })
            .to_string(),
            cluster_id,
            media_item_id
        ],
    )?;
    conn.execute(
        "INSERT INTO audit_log(media_item_id, action, source, new_value, details)
         VALUES(?1, 'duplicate_keep_confirmed', 'user', ?2, ?3)",
        params![
            media_item_id,
            "legitimate",
            serde_json::json!({"clusterId": cluster_id, "winnerFilename": filename}).to_string()
        ],
    )?;
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
        let mut effective_path = current.clone();
        if current != target {
            if tokio::fs::copy(&current, &target).await.is_ok() {
                effective_path = target.clone();
                conn.execute(
                    "UPDATE media_items SET current_path=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![effective_path.to_string_lossy().to_string(), id],
                )?;
            }
        }
        // Best-effort thumbnail generation (especially useful for HEIC on Windows).
        let thumb_id_path = thumbs_dir.join(format!("{id}.jpg"));
        let _ = ensure_thumbnail(&effective_path, &thumb_id_path).await;
        if let Some(stem) = Path::new(&filename).file_stem().and_then(|s| s.to_str()) {
            let thumb_name_path = thumbs_dir.join(format!("{stem}.jpg"));
            let _ = ensure_thumbnail(&effective_path, &thumb_name_path).await;
        }
    }
    Ok(())
}

async fn ensure_thumbnail(input: &Path, output: &Path) -> Result<()> {
    if exiftool::create_thumbnail_ffmpeg(input, output).await.is_ok() {
        return Ok(());
    }
    // Fallback when ffmpeg is unavailable: for common image formats, copy the source
    // so the UI still has a resolvable preview asset.
    if is_image_copy_candidate(input) {
        tokio::fs::copy(input, output).await?;
    }
    Ok(())
}

fn is_image_copy_candidate(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif" | "tif" | "tiff"
    )
}

fn thumbnail_candidates(current: &Path, media_item_id: i64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(parent) = current.parent() {
        let thumbs_dir = parent.join(".thumbnails");
        out.push(thumbs_dir.join(format!("{media_item_id}.jpg")));
        if let Some(stem) = current.file_stem().and_then(|s| s.to_str()) {
            out.push(thumbs_dir.join(format!("{stem}.jpg")));
        }
    }
    out
}

async fn read_as_data_url(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = tokio::fs::read(path).await?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = mime_for_path(path);
    Ok(Some(format!("data:{mime};base64,{encoded}")))
}

fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::confirm_duplicate_keep_with_conn;
    use crate::db::init_db;
    use rusqlite::params;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-classify-cmd-test-{}.db", rand::random::<u64>()));
        p
    }

    #[test]
    fn confirm_duplicate_keep_updates_cluster_members() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, classification, review_reason, duplicate_cluster_id, status)
             VALUES(?1, ?2, ?3, 'review', 'duplicate_keep_suggestion', ?4, 'classified')",
            params!["d1", "IMG_DUP_1.JPG", "C:\\tmp\\IMG_DUP_1.JPG", "cluster-1"],
        )
        .expect("insert candidate keep");
        let keep_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, classification, review_reason, duplicate_cluster_id, status)
             VALUES(?1, ?2, ?3, 'review', 'duplicate_non_best', ?4, 'classified')",
            params!["d2", "IMG_DUP_2.JPG", "C:\\tmp\\IMG_DUP_2.JPG", "cluster-1"],
        )
        .expect("insert candidate non-best");

        confirm_duplicate_keep_with_conn(&conn, keep_id).expect("confirm keep");

        let keep_class: String = conn
            .query_row("SELECT classification FROM media_items WHERE id=?1", [keep_id], |r| r.get(0))
            .expect("keep classification");
        assert_eq!(keep_class, "legitimate");

        let other_reason: String = conn
            .query_row(
                "SELECT review_reason FROM media_items WHERE id != ?1 AND duplicate_cluster_id='cluster-1'",
                [keep_id],
                |r| r.get(0),
            )
            .expect("other review reason");
        assert_eq!(other_reason, "duplicate_non_best");

        let audit_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action='duplicate_keep_confirmed' AND media_item_id=?1",
                [keep_id],
                |r| r.get(0),
            )
            .expect("audit row count");
        assert_eq!(audit_count, 1);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

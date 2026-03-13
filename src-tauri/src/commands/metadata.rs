use anyhow::Result;
use base64::Engine;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{
    models::{DashboardStats, DateEstimateDto},
    services::{date_enforcer, exiftool, runtime_log, video_review},
    AppState,
};

#[tauri::command]
pub async fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::dashboard_stats(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_date_review_queue(state: State<'_, AppState>) -> Result<Vec<DateEstimateDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let queue = crate::db::get_date_review_queue(&conn).map_err(|e| e.to_string())?;
    runtime_log::info(
        "commands.metadata",
        format!("Fetched date review queue with {} items.", queue.len()),
    );
    Ok(queue)
}

#[tauri::command]
pub fn apply_date_approval(media_item_id: i64, date: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    runtime_log::info(
        "commands.metadata",
        format!(
            "Received apply_date_approval for id={media_item_id}. mode={}.",
            if date.is_some() { "approve" } else { "skip" }
        ),
    );
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        date_enforcer::apply_date_approval(&conn, media_item_id, date)
            .await
            .map_err(|e| e.to_string())?;
        video_review::prepare_video_review(&conn, &state.root_output())
            .await
            .map_err(|e| e.to_string())?;
        runtime_log::info(
            "commands.metadata",
            format!("apply_date_approval completed for id={media_item_id}."),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn get_date_media_thumbnail(media_item_id: i64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    tauri::async_runtime::block_on(async {
        runtime_log::info(
            "commands.metadata",
            format!("Resolving thumbnail for media item id={media_item_id}."),
        );
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let (filename, current_path, original_path): (String, String, String) = conn
            .query_row(
                "SELECT filename, COALESCE(current_path, ''), COALESCE(original_path, '') FROM media_items WHERE id=?1",
                [media_item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let root_output = state.root_output();
        let resolved = resolve_media_path(&filename, &current_path, &original_path, &root_output);
        let result = get_date_media_thumbnail_for_path(resolved.clone(), media_item_id)
            .await
            .map_err(|e| e.to_string())?;
        runtime_log::info(
            "commands.metadata",
            format!(
                "Thumbnail resolution for id={media_item_id} path='{}' result={}.",
                resolved.to_string_lossy(),
                if result.is_some() { "hit" } else { "miss" }
            ),
        );
        Ok(result)
    })
}

fn resolve_media_path(filename: &str, current_path: &str, original_path: &str, root_output: &Path) -> PathBuf {
    let mut candidates = Vec::<PathBuf>::new();
    if !current_path.trim().is_empty() {
        candidates.push(PathBuf::from(current_path));
    }
    if !original_path.trim().is_empty() {
        candidates.push(PathBuf::from(original_path));
    }
    if !filename.trim().is_empty() {
        candidates.push(root_output.join("staging").join(filename));
    }
    for candidate in candidates {
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(current_path)
}

async fn get_date_media_thumbnail_for_path(
    current: PathBuf,
    media_item_id: i64,
) -> Result<Option<String>> {
    if current.as_os_str().is_empty() || !current.exists() {
        return Ok(None);
    }

    for thumb in thumbnail_candidates(&current, media_item_id) {
        if let Some(url) = read_as_data_url(&thumb).await? {
            runtime_log::info(
                "commands.metadata",
                format!(
                    "Using existing thumbnail for id={media_item_id}: '{}'.",
                    thumb.to_string_lossy()
                ),
            );
            return Ok(Some(url));
        }
    }

    let generated = generate_thumbnail_if_possible(&current, media_item_id).await?;
    if let Some(path) = generated {
        if let Some(url) = read_as_data_url(&path).await? {
            runtime_log::info(
                "commands.metadata",
                format!(
                    "Generated thumbnail for id={media_item_id}: '{}'.",
                    path.to_string_lossy()
                ),
            );
            return Ok(Some(url));
        }
    }

    if is_directly_renderable_image(&current) {
        runtime_log::info(
            "commands.metadata",
            format!(
                "Falling back to directly renderable original for id={media_item_id}: '{}'.",
                current.to_string_lossy()
            ),
        );
        return read_as_data_url(&current).await;
    }
    runtime_log::warn(
        "commands.metadata",
        format!(
            "No renderable thumbnail found for id={media_item_id}: '{}'.",
            current.to_string_lossy()
        ),
    );
    Ok(None)
}

fn thumbnail_candidates(current: &Path, media_item_id: i64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(parent) = current.parent() {
        let thumbs_dir = parent.join(".thumbnails");
        out.push(thumbs_dir.join(format!("{media_item_id}.jpg")));
        out.push(thumbs_dir.join(format!("{media_item_id}.jpeg")));
        out.push(thumbs_dir.join(format!("{media_item_id}.png")));
        out.push(thumbs_dir.join(format!("{media_item_id}.tif")));
        out.push(thumbs_dir.join(format!("{media_item_id}.tiff")));
    }
    out
}

async fn generate_thumbnail_if_possible(current: &Path, media_item_id: i64) -> Result<Option<PathBuf>> {
    let Some(parent) = current.parent() else {
        return Ok(None);
    };
    let thumbs_dir = parent.join(".thumbnails");
    tokio::fs::create_dir_all(&thumbs_dir).await?;

    let ffmpeg_target = thumbs_dir.join(format!("{media_item_id}.jpg"));
    if exiftool::create_thumbnail_ffmpeg(current, &ffmpeg_target).await.is_ok() {
        return Ok(Some(ffmpeg_target));
    }

    if is_copyable_image(current) {
        let ext = current
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let copy_target = thumbs_dir.join(format!("{media_item_id}.{ext}"));
        tokio::fs::copy(current, &copy_target).await?;
        return Ok(Some(copy_target));
    }
    Ok(None)
}

async fn read_as_data_url(path: &Path) -> Result<Option<String>> {
    if !is_directly_renderable_image(path) {
        return Ok(None);
    }
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

fn is_copyable_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png")
}

fn is_directly_renderable_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp")
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
        "heic" | "heif" => "image/heic",
        "mp4" | "mov" | "m4v" => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::get_date_media_thumbnail_for_path;
    use crate::db::init_db;
    use rusqlite::params;
    use std::fs;

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
        0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63,
        0xF8, 0xCF, 0x00, 0x00, 0x02, 0x05, 0x01, 0x02, 0xA7, 0x69, 0xC2, 0xCF, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    const TINY_JPEG: &[u8] = &[
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
        0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
        0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D,
        0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
        0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28,
        0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
        0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xC4, 0x00, 0x1F,
        0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
        0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20, 0xFF,
        0xD9,
    ];

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-date-thumb-test-{}.db", rand::random::<u64>()));
        p
    }

    #[tokio::test]
    async fn loads_existing_thumbnail_file_for_date_item() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        let root = std::env::temp_dir().join(format!("memoria-date-thumb-assets-{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&root);
        let media_path = root.join("sample.png");
        fs::write(&media_path, TINY_PNG).expect("write media");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_needs_review)
             VALUES(?1, ?2, ?3, 'date_review_pending', 1)",
            params!["thumb-1", "sample.png", media_path.to_string_lossy().to_string()],
        )
        .expect("insert media");
        let id = conn.last_insert_rowid();

        let thumb_dir = root.join(".thumbnails");
        let _ = fs::create_dir_all(&thumb_dir);
        let thumb_path = thumb_dir.join(format!("{id}.jpg"));
        fs::write(&thumb_path, TINY_JPEG).expect("write thumbnail");

        let data_url = get_date_media_thumbnail_for_path(media_path, id)
            .await
            .expect("get thumbnail")
            .expect("thumbnail data url");
        assert!(data_url.starts_with("data:image/jpeg;base64,"));

        drop(conn);
        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn does_not_return_unrenderable_original_media_payload() {
        let root = std::env::temp_dir().join(format!("memoria-date-thumb-unrenderable-{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&root);
        let media_path = root.join("sample.mov");
        fs::write(&media_path, b"not-a-real-video").expect("write fake mov");

        let result = get_date_media_thumbnail_for_path(media_path, 99)
            .await
            .expect("thumbnail lookup");
        assert!(result.is_none());

        let _ = fs::remove_dir_all(root);
    }
}

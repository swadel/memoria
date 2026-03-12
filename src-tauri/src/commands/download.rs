use anyhow::Result;
use rusqlite::params;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{
    models::SessionInput,
    services::{date_enforcer, exiftool},
    AppState,
};

#[tauri::command]
pub fn start_download_session(input: SessionInput, state: State<'_, AppState>) -> Result<i64, String> {
    tauri::async_runtime::block_on(start_download_session_impl(input, &state))
        .map_err(|e| e.to_string())
}

pub async fn start_download_session_impl(input: SessionInput, state: &AppState) -> Result<i64> {
    let conn = state.open_conn()?;
    let working_dir = PathBuf::from(input.working_directory.trim());
    let output_dir = PathBuf::from(input.output_directory.trim());
    if !working_dir.exists() || !working_dir.is_dir() {
        return Err(anyhow::anyhow!(
            "Working directory does not exist or is not a folder: {}",
            working_dir.to_string_lossy()
        ));
    }
    if input.output_directory.trim().is_empty() {
        return Err(anyhow::anyhow!("Output directory cannot be empty."));
    }
    tokio::fs::create_dir_all(&output_dir).await?;
    if let Ok(mut lock) = state.default_output_dir.lock() {
        *lock = Some(output_dir.to_string_lossy().to_string());
    }
    conn.execute(
        "INSERT INTO download_sessions(date_range_start, date_range_end, status, output_directory)
         VALUES(?1, ?2, 'active', ?3)",
        params!["local", "local", output_dir.to_string_lossy().to_string()],
    )?;
    let session_id = conn.last_insert_rowid();

    let files = collect_media_files(&working_dir)?;
    conn.execute(
        "UPDATE download_sessions SET total_items=?1 WHERE id=?2",
        params![files.len() as i64, session_id],
    )?;

    let staging_dir = state.root_output().join("staging");
    tokio::fs::create_dir_all(&staging_dir).await?;
    for (idx, source_path) in files.iter().enumerate() {
        let filename = source_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("item_{idx}"));
        let icloud_id = source_path.to_string_lossy().to_string();
        let staged_name = format!("{:05}_{}", idx + 1, filename);
        let staged_path = staging_dir.join(staged_name);
        tokio::fs::copy(source_path, &staged_path).await?;
        let file_size = tokio::fs::metadata(&staged_path).await?.len() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO media_items(icloud_id, filename, status, classification, current_path, original_path, file_size, mime_type)
             VALUES(?1, ?2, 'downloading', NULL, '', '', ?3, ?4)",
            params![icloud_id, filename, file_size, guess_mime(source_path)],
        )?;
        let meta = exiftool::read_metadata(staged_path.as_path()).await.unwrap_or_default();
        conn.execute(
            "UPDATE media_items
             SET current_path=?1, original_path=?2, status='downloaded', width=?3, height=?4, mime_type=COALESCE(?5, mime_type), date_taken=?6, duration_secs=?7, content_identifier=?8, date_taken_source='exif', updated_at=CURRENT_TIMESTAMP
             WHERE icloud_id=?9",
            params![
                staged_path.to_string_lossy().to_string(),
                source_path.to_string_lossy().to_string(),
                meta.width,
                meta.height,
                meta.mime_type,
                meta.date_time_original.map(exif_to_iso),
                meta.duration_secs,
                meta.content_identifier,
                icloud_id
            ],
        )?;
        conn.execute(
            "UPDATE download_sessions SET downloaded_count=?1 WHERE id=?2",
            params![(idx + 1) as i64, session_id],
        )?;
    }
    conn.execute(
        "UPDATE download_sessions SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=?1",
        [session_id],
    )?;

    let ai = state.ai_client().await;
    date_enforcer::evaluate(&conn, &ai).await?;
    Ok(session_id)
}

fn collect_media_files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                visit(&path, out)?;
            } else if is_supported_media(&path) {
                out.push(path);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, &mut files)?;
    Ok(files)
}

fn is_supported_media(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("jpg")
            | Some("jpeg")
            | Some("png")
            | Some("heic")
            | Some("heif")
            | Some("gif")
            | Some("webp")
            | Some("bmp")
            | Some("tif")
            | Some("tiff")
            | Some("mp4")
            | Some("mov")
            | Some("m4v")
    )
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("heic") | Some("heif") => "image/heic",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn exif_to_iso(value: String) -> String {
    if value.len() >= 10 && value.chars().nth(4) == Some(':') {
        let date = &value[..10];
        return date.replace(':', "-");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{exif_to_iso, guess_mime, is_supported_media};
    use std::path::Path;

    #[test]
    fn exif_to_iso_converts_standard_exif_date() {
        let out = exif_to_iso("2026:03:12 10:11:12".to_string());
        assert_eq!(out, "2026-03-12");
    }

    #[test]
    fn exif_to_iso_keeps_non_exif_format() {
        let out = exif_to_iso("2026-03-12T10:11:12Z".to_string());
        assert_eq!(out, "2026-03-12T10:11:12Z");
    }

    #[test]
    fn supports_common_media_extensions() {
        assert!(is_supported_media(Path::new("IMG_1.HEIC")));
        assert!(is_supported_media(Path::new("IMG_2.jpg")));
        assert!(is_supported_media(Path::new("VID_1.mp4")));
        assert!(!is_supported_media(Path::new("notes.txt")));
    }

    #[test]
    fn guess_mime_maps_known_extensions() {
        assert_eq!(guess_mime(Path::new("foo.jpeg")), "image/jpeg");
        assert_eq!(guess_mime(Path::new("foo.heic")), "image/heic");
        assert_eq!(guess_mime(Path::new("foo.mov")), "video/quicktime");
        assert_eq!(guess_mime(Path::new("foo.unknown")), "application/octet-stream");
    }
}

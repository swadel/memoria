use anyhow::Result;
use rusqlite::params;
use tauri::State;

use crate::{
    models::SessionInput,
    services::{date_enforcer, exiftool, icloud_bridge::ICloudBridge, settings},
    AppState,
};

#[tauri::command]
pub fn start_download_session(input: SessionInput, state: State<'_, AppState>) -> Result<i64, String> {
    tauri::async_runtime::block_on(start_download_session_impl(input, &state))
        .map_err(|e| e.to_string())
}

pub async fn start_download_session_impl(input: SessionInput, state: &AppState) -> Result<i64> {
    let conn = state.open_conn()?;
    conn.execute(
        "INSERT INTO download_sessions(date_range_start, date_range_end, status, output_directory)
         VALUES(?1, ?2, 'active', ?3)",
        params![input.date_range_start, input.date_range_end, input.output_directory],
    )?;
    let session_id = conn.last_insert_rowid();

    let username = settings::get_secret("icloud_username")?
        .ok_or_else(|| anyhow::anyhow!("Missing iCloud username. Set it in Settings tab."))?;
    let password = settings::get_secret("icloud_password")?
        .ok_or_else(|| anyhow::anyhow!("Missing iCloud password. Set it in Settings tab."))?;
    let two_factor_code = settings::get_secret("icloud_2fa_code")?;

    let bridge = ICloudBridge::new("sidecar/icloud_bridge.exe");
    bridge
        .authenticate(&username, &password, two_factor_code.as_deref())
        .await?;
    let assets = bridge
        .fetch_assets_in_range(
            &username,
            &password,
            &input.date_range_start,
            &input.date_range_end,
            two_factor_code.as_deref(),
        )
        .await?;
    conn.execute(
        "UPDATE download_sessions SET total_items=?1 WHERE id=?2",
        params![assets.len() as i64, session_id],
    )?;

    let staging_dir = state.root_output().join("staging");
    for (idx, asset) in assets.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO media_items(icloud_id, filename, status, classification, current_path, original_path, file_size, mime_type)
             VALUES(?1, ?2, 'downloading', NULL, '', '', ?3, ?4)",
            params![asset.icloud_id, asset.filename, asset.file_size, asset.mime_type],
        )?;
        let path = bridge
            .download_original(
                &username,
                &password,
                asset,
                &staging_dir,
                two_factor_code.as_deref(),
            )
            .await?;
        let meta = exiftool::read_metadata(path.as_path()).await.unwrap_or_default();
        conn.execute(
            "UPDATE media_items
             SET current_path=?1, original_path=?1, status='downloaded', width=?2, height=?3, mime_type=COALESCE(?4, mime_type), date_taken=?5, date_taken_source='exif', updated_at=CURRENT_TIMESTAMP
             WHERE icloud_id=?6",
            params![
                path.to_string_lossy().to_string(),
                meta.width,
                meta.height,
                meta.mime_type,
                meta.date_time_original.map(exif_to_iso),
                asset.icloud_id
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

fn exif_to_iso(value: String) -> String {
    if value.len() >= 10 && value.chars().nth(4) == Some(':') {
        let date = &value[..10];
        return date.replace(':', "-");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::exif_to_iso;

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
}

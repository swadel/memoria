use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::db;

const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
    0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
    0xCF, 0x00, 0x00, 0x02, 0x05, 0x01, 0x02, 0xA7, 0x69, 0xC2, 0xCF, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureSeedSummary {
    pub profile: String,
    pub media_root: String,
    pub output_root: String,
    pub media_items: i64,
    pub event_groups: i64,
}

pub fn seed_fixture(
    conn: &Connection,
    profile: &str,
    media_root: &Path,
    output_root: &Path,
) -> Result<FixtureSeedSummary> {
    reset_fixture_data(conn)?;
    db::set_setting(conn, "working_directory", media_root.to_string_lossy().as_ref())?;
    db::set_setting(conn, "output_directory", output_root.to_string_lossy().as_ref())?;

    let inbox_dir = media_root.join("inbox");
    let organized_dir = output_root.join("organized").join("2026").join("2026 - Ski Trip");
    let recycle_dir = output_root.join("recycle");
    let staging_dir = output_root.join("staging");

    fs::create_dir_all(&inbox_dir)?;
    fs::create_dir_all(&organized_dir)?;
    fs::create_dir_all(&recycle_dir)?;
    fs::create_dir_all(&staging_dir)?;

    let mut media_count = 0_i64;
    let mut event_groups = 0_i64;

    media_count += insert_indexed(conn, &staging_dir.join("IMG_INDEXED_001.png"))?;
    media_count += insert_date_review_item(conn, &staging_dir.join("IMG_DATE_REVIEW_001.png"))?;
    media_count += insert_date_verified(conn, &staging_dir.join("IMG_VERIFIED_001.png"))?;

    match profile {
        "dashboard-baseline" => {}
        "date-approval" => {}
        "event-groups" => {
            let group_id = insert_event_group(conn, "Ski Trip", "2026 - Ski Trip", 2)?;
            event_groups += 1;
            media_count += insert_grouped_item(conn, &organized_dir.join("IMG_GROUP_01.png"), group_id)?;
            media_count += insert_grouped_item(conn, &organized_dir.join("IMG_GROUP_02.png"), group_id)?;
        }
        "finalize-output" => {
            media_count += insert_filed_item(conn, &organized_dir.join("IMG_FILED_01.png"))?;
        }
        "error-state" => {
            media_count += insert_error_item(conn, &staging_dir.join("IMG_ERR_01.png"))?;
        }
        "all" | "regression-mixed" => {
            let group_id = insert_event_group(conn, "Ski Trip", "2026 - Ski Trip", 2)?;
            event_groups += 1;
            media_count += insert_grouped_item(conn, &organized_dir.join("IMG_GROUP_01.png"), group_id)?;
            media_count += insert_grouped_item(conn, &organized_dir.join("IMG_GROUP_02.png"), group_id)?;
            media_count += insert_filed_item(conn, &organized_dir.join("IMG_FILED_01.png"))?;
            media_count += insert_error_item(conn, &staging_dir.join("IMG_ERR_01.png"))?;
        }
        _ => anyhow::bail!("Unknown fixture profile: {profile}"),
    }

    Ok(FixtureSeedSummary {
        profile: profile.to_string(),
        media_root: media_root.to_string_lossy().to_string(),
        output_root: output_root.to_string_lossy().to_string(),
        media_items: media_count,
        event_groups,
    })
}

fn reset_fixture_data(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM audit_log;
         DELETE FROM media_items;
         DELETE FROM event_groups;
         DELETE FROM download_sessions;",
    )?;
    Ok(())
}

fn write_tiny_image(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, TINY_PNG)?;
    Ok(())
}

fn insert_media_row(
    conn: &Connection,
    filename: &str,
    current_path: &Path,
    status: &str,
    date_taken: Option<&str>,
    date_needs_review: bool,
    ai_date_estimate_raw: Option<String>,
    event_group_id: Option<i64>,
    final_path: Option<&Path>,
    error_message: Option<&str>,
) -> Result<i64> {
    write_tiny_image(current_path)?;
    if let Some(fp) = final_path {
        write_tiny_image(fp)?;
    }
    conn.execute(
        "INSERT INTO media_items(
            icloud_id, filename, original_path, current_path, final_path, file_size, mime_type, width, height,
            date_needs_review, ai_date_estimate_raw, event_group_id, status, error_message, date_taken, date_taken_source
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            format!("fixture:{filename}"),
            filename,
            current_path.to_string_lossy().to_string(),
            current_path.to_string_lossy().to_string(),
            final_path.map(|p| p.to_string_lossy().to_string()),
            TINY_PNG.len() as i64,
            "image/png",
            if date_needs_review { 1 } else { 0 },
            ai_date_estimate_raw,
            event_group_id,
            status,
            error_message,
            date_taken,
            if date_taken.is_some() { Some("fixture".to_string()) } else { None }
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn insert_indexed(conn: &Connection, path: &Path) -> Result<i64> {
    insert_media_row(
        conn,
        "indexed_fixture.png",
        path,
        "metadata_extracted",
        None,
        false,
        None,
        None,
        None,
        None,
    )?;
    Ok(1)
}

fn insert_date_review_item(conn: &Connection, path: &Path) -> Result<i64> {
    insert_media_row(
        conn,
        "date_review_fixture.png",
        path,
        "date_review_pending",
        None,
        true,
        Some(
            serde_json::json!({
                "ai_date":"2026-03-11",
                "confidence":0.82,
                "reasoning":"Fixture seeded date estimate"
            })
            .to_string(),
        ),
        None,
        None,
        None,
    )?;
    Ok(1)
}

fn insert_date_verified(conn: &Connection, path: &Path) -> Result<i64> {
    insert_media_row(
        conn,
        "date_verified_fixture.png",
        path,
        "date_verified",
        Some("2026-03-12"),
        false,
        None,
        None,
        None,
        None,
    )?;
    Ok(1)
}

fn insert_event_group(conn: &Connection, name: &str, folder_name: &str, item_count: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO event_groups(year, name, folder_name, item_count, user_approved) VALUES(?1, ?2, ?3, ?4, 0)",
        params![2026_i64, name, folder_name, item_count],
    )?;
    Ok(conn.last_insert_rowid())
}

fn insert_grouped_item(conn: &Connection, path: &Path, group_id: i64) -> Result<i64> {
    insert_media_row(
        conn,
        path.file_name().and_then(|v| v.to_str()).unwrap_or("grouped_fixture.png"),
        path,
        "grouped",
        Some("2026-03-12"),
        false,
        None,
        Some(group_id),
        None,
        None,
    )?;
    Ok(1)
}

fn insert_filed_item(conn: &Connection, final_path: &Path) -> Result<i64> {
    let current_path = final_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("filed_fixture_current.png");
    insert_media_row(
        conn,
        "filed_fixture.png",
        &current_path,
        "filed",
        Some("2026-03-12"),
        false,
        None,
        None,
        Some(final_path),
        None,
    )?;
    Ok(1)
}

fn insert_error_item(conn: &Connection, path: &Path) -> Result<i64> {
    insert_media_row(
        conn,
        "error_fixture.png",
        path,
        "error",
        None,
        false,
        None,
        None,
        None,
        Some("Fixture injected error"),
    )?;
    Ok(1)
}

pub fn default_fixture_paths(base_dir: &Path) -> (PathBuf, PathBuf) {
    (base_dir.join("e2e-media"), base_dir.join("e2e-output"))
}

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Datelike, Utc};
use rusqlite::{params, types::Value};
use tauri::State;

use crate::{
    db,
    models::{EventGroupDto, EventGroupItemDto},
    services::event_grouper,
    services::file_organizer,
    services::runtime_log,
    AppState,
};

const DUPLICATE_GROUP_NAME_ERROR: &str = "A group with this name already exists";

#[tauri::command]
pub fn run_event_grouping(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        runtime_log::info("commands.organize", "Invoked run_event_grouping.");
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let video_total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE mime_type LIKE 'video/%' AND status IN ('image_reviewed', 'excluded')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let video_phase = crate::db::get_setting(&conn, "video_review_phase_state")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "pending".to_string());
        if video_total > 0 && video_phase != "complete" {
            return Err("Video Review must be completed before Event Grouping.".to_string());
        }
        let ai = state.ai_client().await;
        event_grouper::run(&conn, &ai, Some(&app_handle))
            .await
            .map_err(|e| e.to_string())?;
        runtime_log::info("commands.organize", "run_event_grouping completed successfully.");
        Ok(())
    })
}

#[tauri::command]
pub fn get_event_groups(state: State<'_, AppState>) -> Result<Vec<EventGroupDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_event_groups(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_event_group_items(group_id: i64, show_excluded: bool, state: State<'_, AppState>) -> Result<Vec<EventGroupItemDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::get_event_group_items(&conn, group_id, show_excluded).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_event_group_media_preview(media_item_id: i64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let (path, mime): (String, Option<String>) = conn
        .query_row(
            "SELECT current_path, mime_type FROM media_items WHERE id=?1",
            [media_item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Preview is too large to render inline".to_string());
    }
    let mime_type = mime.unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(Some(format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))))
}

#[tauri::command]
pub fn rename_event_group(group_id: i64, name: String, state: State<'_, AppState>) -> Result<(), String> {
    runtime_log::info(
        "commands.organize",
        format!("Invoked rename_event_group id={group_id} new_name='{}'.", name),
    );
    tauri::async_runtime::block_on(rename_event_group_impl(group_id, name, &state))
        .map_err(|e| e.to_string())
}

async fn rename_event_group_impl(group_id: i64, name: String, state: &AppState) -> Result<()> {
    let conn = state.open_conn()?;
    rename_event_group_conn(&conn, group_id, &name)?;
    Ok(())
}

#[tauri::command]
pub fn create_event_group(name: String, state: State<'_, AppState>) -> Result<EventGroupDto, String> {
    runtime_log::info(
        "commands.organize",
        format!("Invoked create_event_group name='{}'.", name),
    );
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let group = create_event_group_conn(&conn, &name, None).map_err(|e| e.to_string())?;
    Ok(group)
}

#[tauri::command]
pub fn delete_event_group(group_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    runtime_log::info("commands.organize", format!("Invoked delete_event_group id={group_id}."));
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    delete_event_group_conn(&conn, group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_event_group_items(
    media_item_ids: Vec<i64>,
    destination_group_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    runtime_log::info(
        "commands.organize",
        format!(
            "Invoked move_event_group_items count={} destination_group_id={destination_group_id}.",
            media_item_ids.len()
        ),
    );
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    move_event_group_items_conn(&conn, &media_item_ids, destination_group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_event_group_and_move(
    name: String,
    media_item_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<EventGroupDto, String> {
    runtime_log::info(
        "commands.organize",
        format!(
            "Invoked create_event_group_and_move name='{}' count={}.",
            name,
            media_item_ids.len()
        ),
    );
    let mut conn = state.open_conn().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let derived_year = derive_group_year_from_items(&tx, &media_item_ids).map_err(|e| e.to_string())?;
    let group = create_event_group_conn(&tx, &name, Some(derived_year))
        .map_err(|e| e.to_string())?;
    move_event_group_items_conn(&tx, &media_item_ids, group.id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(group)
}

#[tauri::command]
pub fn finalize_organization(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        runtime_log::info("commands.organize", "Invoked finalize_organization.");
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let output = state
            .default_output_dir
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| "C:\\Memoria".to_string());
        file_organizer::finalize(&conn, &output, Some(&app_handle))
            .await
            .map_err(|e| e.to_string())?;
        runtime_log::info("commands.organize", "finalize_organization completed successfully.");
        Ok(())
    })
}

fn normalize_group_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("Group name is required"));
    }
    Ok(trimmed.to_string())
}

fn ensure_unique_group_name(
    conn: &rusqlite::Connection,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<()> {
    if db::event_group_name_exists(conn, name, exclude_id)? {
        return Err(anyhow::anyhow!(DUPLICATE_GROUP_NAME_ERROR));
    }
    Ok(())
}

fn rename_event_group_conn(conn: &rusqlite::Connection, group_id: i64, name: &str) -> Result<()> {
    let normalized = normalize_group_name(name)?;
    ensure_unique_group_name(conn, &normalized, Some(group_id))?;
    let year: i64 = conn.query_row("SELECT year FROM event_groups WHERE id=?1", [group_id], |r| r.get(0))?;
    let folder = format!("{year} - {normalized}");
    conn.execute(
        "UPDATE event_groups SET name=?1, folder_name=?2, user_approved=1 WHERE id=?3",
        params![normalized, folder, group_id],
    )?;
    Ok(())
}

fn create_event_group_conn(
    conn: &rusqlite::Connection,
    name: &str,
    year: Option<i64>,
) -> Result<EventGroupDto> {
    let normalized = normalize_group_name(name)?;
    ensure_unique_group_name(conn, &normalized, None)?;
    let event_year = year.unwrap_or_else(|| Utc::now().year() as i64);
    let folder = format!("{event_year} - {normalized}");
    conn.execute(
        "INSERT INTO event_groups(year, name, folder_name, user_approved, item_count, is_misc)
         VALUES(?1, ?2, ?3, 1, 0, 0)",
        params![event_year, normalized, folder],
    )?;
    let id = conn.last_insert_rowid();
    Ok(EventGroupDto {
        id,
        year: event_year,
        name: normalized,
        folder_name: folder,
        item_count: 0,
        user_approved: true,
    })
}

fn delete_event_group_conn(conn: &rusqlite::Connection, group_id: i64) -> Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE event_group_id=?1 AND status != 'excluded'",
        [group_id],
        |r| r.get(0),
    )?;
    if count > 0 {
        return Err(anyhow::anyhow!("Cannot delete a group that still has items"));
    }
    conn.execute("DELETE FROM event_groups WHERE id=?1", [group_id])?;
    Ok(())
}

fn move_event_group_items_conn(
    conn: &rusqlite::Connection,
    media_item_ids: &[i64],
    destination_group_id: i64,
) -> Result<()> {
    if media_item_ids.is_empty() {
        return Err(anyhow::anyhow!("Select at least one media item"));
    }
    let destination_exists: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM event_groups WHERE id=?1)",
        [destination_group_id],
        |r| r.get(0),
    )?;
    if destination_exists != 1 {
        return Err(anyhow::anyhow!("Destination group was not found"));
    }

    let source_group_ids = fetch_distinct_group_ids_for_items(conn, media_item_ids)?;

    let placeholders = std::iter::repeat("?")
        .take(media_item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut values = Vec::with_capacity(media_item_ids.len() + 1);
    values.push(Value::from(destination_group_id));
    for id in media_item_ids {
        values.push(Value::from(*id));
    }
    let sql = format!(
        "UPDATE media_items
         SET event_group_id=?, updated_at=CURRENT_TIMESTAMP
         WHERE id IN ({placeholders})"
    );
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;

    let mut touched_group_ids = source_group_ids;
    touched_group_ids.push(destination_group_id);
    touched_group_ids.sort_unstable();
    touched_group_ids.dedup();
    db::refresh_event_group_item_counts(conn, &touched_group_ids)?;
    Ok(())
}

fn fetch_distinct_group_ids_for_items(conn: &rusqlite::Connection, media_item_ids: &[i64]) -> Result<Vec<i64>> {
    let placeholders = std::iter::repeat("?")
        .take(media_item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT DISTINCT event_group_id
         FROM media_items
         WHERE id IN ({placeholders}) AND event_group_id IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(media_item_ids.iter()))?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        ids.push(row.get(0)?);
    }
    Ok(ids)
}

fn derive_group_year_from_items(conn: &rusqlite::Connection, media_item_ids: &[i64]) -> Result<i64> {
    if media_item_ids.is_empty() {
        return Ok(Utc::now().year() as i64);
    }
    let placeholders = std::iter::repeat("?")
        .take(media_item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT date_taken
         FROM media_items
         WHERE id IN ({placeholders})
         ORDER BY date_taken ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(media_item_ids.iter()), |row| {
        row.get::<_, Option<String>>(0)
    })?;
    for row in rows {
        if let Some(date) = row? {
            if let Some(prefix) = date.get(0..4) {
                if let Ok(parsed) = prefix.parse::<i64>() {
                    return Ok(parsed);
                }
            }
        }
    }
    Ok(Utc::now().year() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use std::fs;
    use std::path::PathBuf;

    fn temp_db_path() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-organize-test-{}.db", rand::random::<u64>()));
        p
    }

    fn seed_group(conn: &rusqlite::Connection, id: i64, year: i64, name: &str, count: i64) {
        conn.execute(
            "INSERT INTO event_groups(id, year, name, folder_name, item_count, user_approved)
             VALUES(?1, ?2, ?3, ?4, ?5, 1)",
            params![id, year, name, format!("{year} - {name}"), count],
        )
        .expect("seed group");
    }

    fn seed_media(conn: &rusqlite::Connection, id: i64, filename: &str, date_taken: &str, group_id: i64) {
        conn.execute(
            "INSERT INTO media_items(id, icloud_id, filename, current_path, status, date_taken, event_group_id)
             VALUES(?1, ?2, ?3, ?4, 'grouped', ?5, ?6)",
            params![id, format!("i-{id}"), filename, format!(r"C:\tmp\{filename}"), date_taken, group_id],
        )
        .expect("seed media");
    }

    #[test]
    fn rename_rejects_case_insensitive_duplicates() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");
        seed_group(&conn, 1, 2026, "Family Christmas", 0);
        seed_group(&conn, 2, 2026, "Ski Trip", 0);

        let err = rename_event_group_conn(&conn, 2, "family christmas").expect_err("duplicate rename should fail");
        assert!(err.to_string().contains(DUPLICATE_GROUP_NAME_ERROR));

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn create_rejects_case_insensitive_duplicates() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");
        seed_group(&conn, 1, 2026, "Road Trip", 0);

        let err = create_event_group_conn(&conn, "road trip", Some(2026)).expect_err("duplicate create should fail");
        assert!(err.to_string().contains(DUPLICATE_GROUP_NAME_ERROR));

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn move_updates_counts_and_keeps_empty_source_group() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");
        seed_group(&conn, 1, 2026, "Group A", 2);
        seed_group(&conn, 2, 2026, "Group B", 0);
        seed_media(&conn, 10, "a.jpg", "2026-01-01", 1);
        seed_media(&conn, 11, "b.jpg", "2026-01-02", 1);

        move_event_group_items_conn(&conn, &[10, 11], 2).expect("move succeeds");

        let source_count: i64 = conn
            .query_row("SELECT item_count FROM event_groups WHERE id=1", [], |r| r.get(0))
            .expect("source count");
        let destination_count: i64 = conn
            .query_row("SELECT item_count FROM event_groups WHERE id=2", [], |r| r.get(0))
            .expect("destination count");
        assert_eq!(source_count, 0);
        assert_eq!(destination_count, 2);
        let source_still_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_groups WHERE id=1", [], |r| r.get(0))
            .expect("source exists");
        assert_eq!(source_still_exists, 1);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn delete_requires_empty_group() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");
        seed_group(&conn, 1, 2026, "Busy", 1);
        seed_group(&conn, 2, 2026, "Empty", 0);
        seed_media(&conn, 10, "busy.jpg", "2026-01-01", 1);

        let err = delete_event_group_conn(&conn, 1).expect_err("busy group cannot be deleted");
        assert!(err.to_string().contains("still has items"));

        delete_event_group_conn(&conn, 2).expect("empty group can be deleted");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_groups WHERE id=2", [], |r| r.get(0))
            .expect("remaining");
        assert_eq!(remaining, 0);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

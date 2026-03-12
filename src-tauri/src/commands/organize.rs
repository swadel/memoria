use anyhow::Result;
use rusqlite::params;
use tauri::State;

use crate::{models::EventGroupDto, services::event_grouper, services::file_organizer, AppState};

#[tauri::command]
pub fn run_event_grouping(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let ai = state.ai_client().await;
        event_grouper::run(&conn, &ai)
            .await
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn get_event_groups(state: State<'_, AppState>) -> Result<Vec<EventGroupDto>, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::get_event_groups(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_event_group(group_id: i64, name: String, state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(rename_event_group_impl(group_id, name, &state))
        .map_err(|e| e.to_string())
}

async fn rename_event_group_impl(group_id: i64, name: String, state: &AppState) -> Result<()> {
    let conn = state.open_conn()?;
    let year: i64 = conn.query_row("SELECT year FROM event_groups WHERE id=?1", [group_id], |r| r.get(0))?;
    let folder = format!("{year} - {name}");
    conn.execute(
        "UPDATE event_groups SET name=?1, folder_name=?2, user_approved=1 WHERE id=?3",
        params![name, folder, group_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn finalize_organization(state: State<'_, AppState>) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let conn = state.open_conn().map_err(|e| e.to_string())?;
        let output = state
            .default_output_dir
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| "C:\\Memoria".to_string());
        file_organizer::finalize(&conn, &output)
            .await
            .map_err(|e| e.to_string())
    })
}

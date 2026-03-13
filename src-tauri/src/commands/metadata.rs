use tauri::State;

use crate::{models::{DashboardStats, DateEstimateDto}, services::date_enforcer, AppState};

#[tauri::command]
pub async fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::dashboard_stats(&conn).map_err(|e| e.to_string())
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

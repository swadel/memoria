use tauri::State;

use crate::{models::DashboardStats, AppState};

#[tauri::command]
pub async fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    crate::db::dashboard_stats(&conn).map_err(|e| e.to_string())
}

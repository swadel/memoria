use tauri::State;

use crate::{db, services::settings, AppState};

#[tauri::command]
pub async fn initialize_app(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "grouping_threshold_days", "3").map_err(|e| e.to_string())?;
    db::set_setting(&conn, "classification_confidence_threshold", "0.9").map_err(|e| e.to_string())?;
    if let Ok(Some(path)) = db::get_setting(&conn, "output_directory") {
        if let Ok(mut lock) = state.default_output_dir.lock() {
            *lock = Some(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_icloud_credentials(
    username: String,
    password: String,
    two_factor_code: Option<String>,
) -> Result<(), String> {
    settings::set_secret("icloud_username", &username).map_err(|e| e.to_string())?;
    settings::set_secret("icloud_password", &password).map_err(|e| e.to_string())?;
    if let Some(code) = two_factor_code {
        if !code.trim().is_empty() {
            settings::set_secret("icloud_2fa_code", code.trim()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_openai_key(api_key: String) -> Result<(), String> {
    settings::set_secret("openai_api_key", &api_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_output_directory(path: String, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut lock = state.default_output_dir.lock().map_err(|e| e.to_string())?;
        *lock = Some(path.clone());
    }
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "output_directory", &path).map_err(|e| e.to_string())
}

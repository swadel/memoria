use anyhow::Result as AnyResult;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use crate::{db, services::settings, AppState};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskModelSelection {
    pub provider: String,
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskModels {
    pub classification: TaskModelSelection,
    pub date_estimation: TaskModelSelection,
    pub event_naming: TaskModelSelection,
    pub duplicate_ranking: TaskModelSelection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfiguration {
    pub working_directory: String,
    pub output_directory: String,
    pub ai_task_models: AiTaskModels,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResetSessionResult {
    pub deleted_generated_files: bool,
    pub removed_directories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSessionInput {
    #[serde(alias = "delete_generated_files")]
    pub delete_generated_files: bool,
}

#[tauri::command]
pub async fn initialize_app(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "grouping_threshold_days", "3").map_err(|e| e.to_string())?;
    db::set_setting(&conn, "classification_confidence_threshold", "0.9").map_err(|e| e.to_string())?;
    if db::get_setting(&conn, "ai_model_classification").map_err(|e| e.to_string())?.is_none() {
        db::set_setting(&conn, "ai_model_classification_provider", "openai").map_err(|e| e.to_string())?;
        db::set_setting(&conn, "ai_model_classification", "gpt-4o-mini").map_err(|e| e.to_string())?;
    }
    if db::get_setting(&conn, "ai_model_date_estimation").map_err(|e| e.to_string())?.is_none() {
        db::set_setting(&conn, "ai_model_date_estimation_provider", "anthropic").map_err(|e| e.to_string())?;
        db::set_setting(&conn, "ai_model_date_estimation", "claude-sonnet-4-6").map_err(|e| e.to_string())?;
    }
    if db::get_setting(&conn, "ai_model_event_naming").map_err(|e| e.to_string())?.is_none() {
        db::set_setting(&conn, "ai_model_event_naming_provider", "anthropic").map_err(|e| e.to_string())?;
        db::set_setting(&conn, "ai_model_event_naming", "claude-sonnet-4-6").map_err(|e| e.to_string())?;
    }
    if db::get_setting(&conn, "ai_model_duplicate_ranking").map_err(|e| e.to_string())?.is_none() {
        db::set_setting(&conn, "ai_model_duplicate_ranking_provider", "anthropic").map_err(|e| e.to_string())?;
        db::set_setting(&conn, "ai_model_duplicate_ranking", "claude-sonnet-4-6").map_err(|e| e.to_string())?;
    }

    let output = db::get_setting(&conn, "output_directory")
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "C:\\Memoria".to_string());
    if let Ok(mut lock) = state.default_output_dir.lock() {
        *lock = Some(output);
    }
    Ok(())
}

#[tauri::command]
pub fn get_app_configuration(state: State<'_, AppState>) -> Result<AppConfiguration, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let working_directory = db::get_setting(&conn, "working_directory")
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "C:\\Memoria\\inbox".to_string());
    let output_directory = db::get_setting(&conn, "output_directory")
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "C:\\Memoria".to_string());
    let ai_task_models = AiTaskModels {
        classification: read_task_model(
            &conn,
            "ai_model_classification_provider",
            "ai_model_classification",
            TaskModelSelection {
                provider: "openai".to_string(),
                model: "gpt-4o-mini".to_string(),
            },
        )?,
        date_estimation: read_task_model(
            &conn,
            "ai_model_date_estimation_provider",
            "ai_model_date_estimation",
            TaskModelSelection {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
        )?,
        event_naming: read_task_model(
            &conn,
            "ai_model_event_naming_provider",
            "ai_model_event_naming",
            TaskModelSelection {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
        )?,
        duplicate_ranking: read_task_model(
            &conn,
            "ai_model_duplicate_ranking_provider",
            "ai_model_duplicate_ranking",
            TaskModelSelection {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
        )?,
    };
    Ok(AppConfiguration {
        working_directory,
        output_directory,
        ai_task_models,
    })
}

#[tauri::command]
pub async fn set_working_directory(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("Working directory cannot be empty.".to_string());
    }
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "working_directory", &path).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "last_settings_write_ts", &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_output_directory(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("Output directory cannot be empty.".to_string());
    }
    {
        let mut lock = state.default_output_dir.lock().map_err(|e| e.to_string())?;
        *lock = Some(path.clone());
    }
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "output_directory", &path).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "last_settings_write_ts", &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_openai_key(api_key: String, state: State<'_, AppState>) -> Result<(), String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("OpenAI API key cannot be empty.".to_string());
    }
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    settings::set_secret_with_fallback(&conn, "openai_api_key", &api_key).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "last_settings_write_ts", &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_anthropic_key(api_key: String, state: State<'_, AppState>) -> Result<(), String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("Anthropic API key cannot be empty.".to_string());
    }
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    settings::set_secret_with_fallback(&conn, "anthropic_api_key", &api_key).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "last_settings_write_ts", &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_ai_task_model(
    task: String,
    provider: String,
    model: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let task = task.trim().to_string();
    let provider = provider.trim().to_ascii_lowercase();
    let model = model.trim().to_string();
    if task.is_empty() || provider.is_empty() || model.is_empty() {
        return Err("Task, provider, and model are required.".to_string());
    }
    if provider != "openai" && provider != "anthropic" {
        return Err("Provider must be 'openai' or 'anthropic'.".to_string());
    }
    let (provider_key, model_key) = match task.as_str() {
        "classification" => ("ai_model_classification_provider", "ai_model_classification"),
        "dateEstimation" => ("ai_model_date_estimation_provider", "ai_model_date_estimation"),
        "eventNaming" => ("ai_model_event_naming_provider", "ai_model_event_naming"),
        "duplicateRanking" => ("ai_model_duplicate_ranking_provider", "ai_model_duplicate_ranking"),
        _ => return Err("Unknown AI task. Expected classification/dateEstimation/eventNaming/duplicateRanking.".to_string()),
    };
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    db::set_setting(&conn, provider_key, &provider).map_err(|e| e.to_string())?;
    db::set_setting(&conn, model_key, &model).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "last_settings_write_ts", &chrono::Utc::now().to_rfc3339())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reset_session(
    input: ResetSessionInput,
    state: State<'_, AppState>,
) -> Result<ResetSessionResult, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    clear_pipeline_state(&conn).map_err(|e| e.to_string())?;
    let output = state.root_output();
    let removed_directories = if input.delete_generated_files {
        remove_generated_directories(&output)
            .await
            .map_err(|e| e.to_string())?
    } else {
        vec![]
    };
    Ok(ResetSessionResult {
        deleted_generated_files: input.delete_generated_files,
        removed_directories,
    })
}

fn clear_pipeline_state(conn: &rusqlite::Connection) -> AnyResult<()> {
    conn.execute_batch(
        "DELETE FROM audit_log;
         DELETE FROM media_items;
         DELETE FROM event_groups;
         DELETE FROM download_sessions;",
    )?;
    Ok(())
}

async fn remove_generated_directories(output_root: &Path) -> AnyResult<Vec<String>> {
    let mut removed = Vec::new();
    for dir in ["staging", "review", "organized", "recycle"] {
        let path = output_root.join(dir);
        if path.exists() {
            tokio::fs::remove_dir_all(&path).await?;
            removed.push(path.to_string_lossy().to_string());
        }
    }
    Ok(removed)
}

fn read_task_model(
    conn: &rusqlite::Connection,
    provider_key: &str,
    model_key: &str,
    fallback: TaskModelSelection,
) -> Result<TaskModelSelection, String> {
    let provider = db::get_setting(conn, provider_key)
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(fallback.provider);
    let model = db::get_setting(conn, model_key)
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(fallback.model);
    Ok(TaskModelSelection { provider, model })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-settings-cmd-test-{}.db", rand::random::<u64>()));
        p
    }

    #[test]
    fn settings_roundtrip_for_local_configuration() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        settings::set_secret_with_fallback(&conn, "openai_api_key", "sk-test").expect("set key");
        settings::set_secret_with_fallback(&conn, "anthropic_api_key", "ak-test").expect("set anthropic key");
        db::set_setting(&conn, "working_directory", r"C:\Photos\Inbox").expect("set working");
        db::set_setting(&conn, "output_directory", r"C:\Memoria\Output").expect("set output");
        db::set_setting(&conn, "ai_model_classification_provider", "openai").expect("set provider");
        db::set_setting(&conn, "ai_model_classification", "gpt-4o-mini").expect("set model");

        assert_eq!(
            settings::get_secret_with_fallback(&conn, "openai_api_key")
                .expect("get key")
                .as_deref(),
            Some("sk-test")
        );
        assert_eq!(
            db::get_setting(&conn, "working_directory")
                .expect("get working")
                .as_deref(),
            Some(r"C:\Photos\Inbox")
        );
        assert_eq!(
            db::get_setting(&conn, "output_directory")
                .expect("get output")
                .as_deref(),
            Some(r"C:\Memoria\Output")
        );
        assert_eq!(
            settings::get_secret_with_fallback(&conn, "anthropic_api_key")
                .expect("get anthropic key")
                .as_deref(),
            Some("ak-test")
        );
        assert_eq!(
            db::get_setting(&conn, "ai_model_classification")
                .expect("get ai model")
                .as_deref(),
            Some("gpt-4o-mini")
        );

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn clear_pipeline_state_preserves_settings() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        db::set_setting(&conn, "working_directory", r"C:\Photos\Inbox").expect("set working");
        db::set_setting(&conn, "output_directory", r"C:\Memoria\Output").expect("set output");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, status) VALUES(?1, ?2, 'classified')",
            ["reset-1", "IMG_1.JPG"],
        )
        .expect("insert media");
        conn.execute(
            "INSERT INTO event_groups(year, name, folder_name) VALUES(2026, 'Trip', '2026 - Trip')",
            [],
        )
        .expect("insert group");
        conn.execute(
            "INSERT INTO download_sessions(date_range_start, date_range_end, status, output_directory)
             VALUES('local', 'local', 'completed', ?1)",
            [r"C:\Memoria\Output"],
        )
        .expect("insert session");

        clear_pipeline_state(&conn).expect("clear state");

        let media_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items", [], |r| r.get(0))
            .expect("media count");
        let group_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_groups", [], |r| r.get(0))
            .expect("group count");
        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM download_sessions", [], |r| r.get(0))
            .expect("session count");
        assert_eq!(media_count, 0);
        assert_eq!(group_count, 0);
        assert_eq!(session_count, 0);
        assert_eq!(
            db::get_setting(&conn, "working_directory")
                .expect("working setting")
                .as_deref(),
            Some(r"C:\Photos\Inbox")
        );
        assert_eq!(
            db::get_setting(&conn, "output_directory")
                .expect("output setting")
                .as_deref(),
            Some(r"C:\Memoria\Output")
        );

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn remove_generated_directories_only_removes_managed_folders() {
        let root = std::env::temp_dir().join(format!("memoria-reset-test-{}", rand::random::<u64>()));
        let keep_dir = root.join("keep");
        let staging = root.join("staging");
        let review = root.join("review");
        let organized = root.join("organized");
        let recycle = root.join("recycle");
        fs::create_dir_all(&keep_dir).expect("create keep");
        fs::create_dir_all(&staging).expect("create staging");
        fs::create_dir_all(&review).expect("create review");
        fs::create_dir_all(&organized).expect("create organized");
        fs::create_dir_all(&recycle).expect("create recycle");
        fs::write(keep_dir.join("safe.txt"), b"keep").expect("write keep marker");

        let removed = remove_generated_directories(&root).await.expect("remove generated");
        assert_eq!(removed.len(), 4);
        assert!(!staging.exists());
        assert!(!review.exists());
        assert!(!organized.exists());
        assert!(!recycle.exists());
        assert!(keep_dir.exists());
        assert!(keep_dir.join("safe.txt").exists());

        let _ = fs::remove_dir_all(root);
    }
}

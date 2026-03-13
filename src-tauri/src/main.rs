#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod models;
mod services;

use anyhow::Result;
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use std::sync::Mutex;
use tauri::Manager;

use services::{ai_client::{AiClient, AiRoutingConfig, TaskModelConfig}, settings::get_secret};

pub struct AppState {
    pub db_path: PathBuf,
    pub base_dir: PathBuf,
    pub default_output_dir: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn open_conn(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    pub fn root_output(&self) -> PathBuf {
        if let Some(p) = self.default_output_dir.lock().ok().and_then(|g| g.clone()) {
            return PathBuf::from(p);
        }
        self.base_dir.join("workspace")
    }

    pub async fn ai_client(&self) -> AiClient {
        let (openai_key, anthropic_key, routing) = match self.open_conn() {
            Ok(conn) => {
                let openai = crate::services::settings::get_secret_with_fallback(&conn, "openai_api_key")
                    .ok()
                    .flatten();
                let anthropic = crate::services::settings::get_secret_with_fallback(&conn, "anthropic_api_key")
                    .ok()
                    .flatten();
                let mut routing = AiRoutingConfig::default();
                routing.classification = task_model_from_settings(
                    &conn,
                    "ai_model_classification_provider",
                    "ai_model_classification",
                    routing.classification.clone(),
                );
                routing.date_estimation = task_model_from_settings(
                    &conn,
                    "ai_model_date_estimation_provider",
                    "ai_model_date_estimation",
                    routing.date_estimation.clone(),
                );
                routing.event_naming = task_model_from_settings(
                    &conn,
                    "ai_model_event_naming_provider",
                    "ai_model_event_naming",
                    routing.event_naming.clone(),
                );
                routing.duplicate_ranking = task_model_from_settings(
                    &conn,
                    "ai_model_duplicate_ranking_provider",
                    "ai_model_duplicate_ranking",
                    routing.duplicate_ranking.clone(),
                );
                (openai, anthropic, routing)
            }
            Err(_) => (
                get_secret("openai_api_key").ok().flatten(),
                get_secret("anthropic_api_key").ok().flatten(),
                AiRoutingConfig::default(),
            ),
        };
        AiClient::new(openai_key, anthropic_key, routing)
    }
}

fn task_model_from_settings(
    conn: &Connection,
    provider_key: &str,
    model_key: &str,
    fallback: TaskModelConfig,
) -> TaskModelConfig {
    let provider = crate::db::get_setting(conn, provider_key)
        .ok()
        .flatten()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(fallback.provider);
    let model = crate::db::get_setting(conn, model_key)
        .ok()
        .flatten()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(fallback.model);
    TaskModelConfig { provider, model }
}

fn app_dir() -> Result<PathBuf> {
    if let Ok(override_dir) = std::env::var("MEMORIA_APP_DIR") {
        let path = PathBuf::from(override_dir);
        std::fs::create_dir_all(&path)?;
        return Ok(path);
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let path = base.join("Memoria");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

fn db_path(base: &Path) -> PathBuf {
    base.join("memoria.db")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let base_dir = app_dir()?;
            let db_path = db_path(&base_dir);
            let _ = db::init_db(&db_path)?;
            app.manage(AppState {
                db_path,
                base_dir,
                default_output_dir: Arc::new(Mutex::new(Some("C:\\Memoria".to_string()))),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::initialize_app,
            commands::settings::get_app_configuration,
            commands::settings::set_working_directory,
            commands::settings::set_openai_key,
            commands::settings::set_anthropic_key,
            commands::settings::set_ai_task_model,
            commands::settings::set_output_directory,
            commands::download::start_download_session,
            commands::metadata::get_dashboard_stats,
            commands::classify::run_classification,
            commands::classify::get_review_queue,
            commands::classify::apply_review_action,
            commands::classify::confirm_duplicate_keep,
            commands::classify::get_date_review_queue,
            commands::classify::apply_date_approval,
            commands::organize::run_event_grouping,
            commands::organize::get_event_groups,
            commands::organize::rename_event_group,
            commands::organize::finalize_organization,
            commands::testing::seed_test_fixture
        ])
        .run(tauri::generate_context!())
        .expect("error while running memoria");
}

fn main() {
    if handle_cli_fixture_seed() {
        return;
    }
    run();
}

fn handle_cli_fixture_seed() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) != Some("--seed-fixture") {
        return false;
    }
    let profile = args
        .get(2)
        .map(|s| s.as_str())
        .unwrap_or("all")
        .to_string();
    let mut media_root: Option<PathBuf> = None;
    let mut output_root: Option<PathBuf> = None;
    let mut idx = 3;
    while idx < args.len() {
        match args[idx].as_str() {
            "--media-root" => {
                if let Some(v) = args.get(idx + 1) {
                    media_root = Some(PathBuf::from(v));
                    idx += 1;
                }
            }
            "--output-root" => {
                if let Some(v) = args.get(idx + 1) {
                    output_root = Some(PathBuf::from(v));
                    idx += 1;
                }
            }
            _ => {}
        }
        idx += 1;
    }

    let result = (|| -> Result<services::test_fixtures::FixtureSeedSummary> {
        let base_dir = app_dir()?;
        let db_path = db_path(&base_dir);
        let conn = db::init_db(&db_path)?;
        let (default_media, default_output) = services::test_fixtures::default_fixture_paths(&base_dir);
        let media = media_root.unwrap_or(default_media);
        let output = output_root.unwrap_or(default_output);
        services::test_fixtures::seed_fixture(&conn, profile.as_str(), &media, &output)
    })();

    match result {
        Ok(summary) => {
            println!(
                "{}",
                serde_json::to_string(&summary).unwrap_or_else(|_| "{\"ok\":true}".to_string())
            );
            std::process::exit(0);
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

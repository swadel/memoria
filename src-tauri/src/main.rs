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

use services::{ai_client::AiClient, settings::get_secret};

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
        let key = get_secret("openai_api_key").ok().flatten();
        AiClient::new(key)
    }
}

fn app_dir() -> Result<PathBuf> {
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
            commands::settings::set_icloud_credentials,
            commands::settings::set_openai_key,
            commands::settings::set_output_directory,
            commands::download::start_download_session,
            commands::metadata::get_dashboard_stats,
            commands::classify::run_classification,
            commands::classify::get_review_queue,
            commands::classify::apply_review_action,
            commands::classify::get_date_review_queue,
            commands::classify::apply_date_approval,
            commands::organize::run_event_grouping,
            commands::organize::get_event_groups,
            commands::organize::rename_event_group,
            commands::organize::finalize_organization
        ])
        .run(tauri::generate_context!())
        .expect("error while running memoria");
}

fn main() {
    run();
}

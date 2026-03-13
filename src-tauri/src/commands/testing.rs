use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

use crate::{services::test_fixtures, AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedFixtureResult {
    pub profile: String,
    pub media_root: String,
    pub output_root: String,
    pub media_items: i64,
    pub event_groups: i64,
}

#[tauri::command]
pub fn seed_test_fixture(
    profile: String,
    media_root: Option<String>,
    output_root: Option<String>,
    state: State<'_, AppState>,
) -> Result<SeedFixtureResult, String> {
    let conn = state.open_conn().map_err(|e| e.to_string())?;
    let (default_media, default_output) = test_fixtures::default_fixture_paths(&state.base_dir);
    let media = media_root
        .map(PathBuf::from)
        .unwrap_or(default_media);
    let output = output_root
        .map(PathBuf::from)
        .unwrap_or(default_output);
    let summary = test_fixtures::seed_fixture(&conn, profile.as_str(), &media, &output)
        .map_err(|e| e.to_string())?;
    Ok(SeedFixtureResult {
        profile: summary.profile,
        media_root: summary.media_root,
        output_root: summary.output_root,
        media_items: summary.media_items,
        event_groups: summary.event_groups,
    })
}

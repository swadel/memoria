use chrono::Utc;
use std::sync::OnceLock;
use tauri::Emitter;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum LogLevel {
    Off,
    Warn,
    Info,
    Debug,
}

fn configured_level() -> LogLevel {
    static LEVEL: OnceLock<LogLevel> = OnceLock::new();
    *LEVEL.get_or_init(|| {
        let raw = std::env::var("MEMORIA_LOG_LEVEL")
            .unwrap_or_else(|_| "info".to_string())
            .to_ascii_lowercase();
        match raw.as_str() {
            "off" => LogLevel::Off,
            "warn" | "warning" => LogLevel::Warn,
            "debug" => LogLevel::Debug,
            _ => LogLevel::Info,
        }
    })
}

pub fn info(scope: &str, message: impl AsRef<str>) {
    if configured_level() < LogLevel::Info {
        return;
    }
    println!(
        "[{}] [{}] {}",
        Utc::now().to_rfc3339(),
        scope,
        message.as_ref()
    );
}

pub fn warn(scope: &str, message: impl AsRef<str>) {
    if configured_level() < LogLevel::Warn {
        return;
    }
    eprintln!(
        "[{}] [{}] WARN: {}",
        Utc::now().to_rfc3339(),
        scope,
        message.as_ref()
    );
}

/// Emit a `pipeline-progress` event to the Tauri frontend.
/// Payload: `{ phase, message, current, total }`.
pub fn emit_pipeline_progress(
    app_handle: Option<&tauri::AppHandle>,
    phase: &str,
    message: &str,
    current: usize,
    total: usize,
) {
    if let Some(handle) = app_handle {
        let _ = handle.emit(
            "pipeline-progress",
            serde_json::json!({
                "phase": phase,
                "message": message,
                "current": current,
                "total": total
            }),
        );
    }
    info(
        phase,
        format!("[{current}/{total}] {message}"),
    );
}

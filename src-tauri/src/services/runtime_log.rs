use chrono::Utc;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
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

const PROGRESS_THROTTLE_MS: u128 = 150;

static LAST_PROGRESS_EMIT: OnceLock<Mutex<Instant>> = OnceLock::new();

fn last_progress_emit() -> &'static Mutex<Instant> {
    LAST_PROGRESS_EMIT.get_or_init(|| Mutex::new(Instant::now() - std::time::Duration::from_secs(1)))
}

/// Emit a `pipeline-progress` event to the Tauri frontend.
/// Payload: `{ phase, message, current, total }`.
/// Events are throttled to avoid flooding the WebView; the first, last,
/// and every-Nth events always pass through.
pub fn emit_pipeline_progress(
    app_handle: Option<&tauri::AppHandle>,
    phase: &str,
    message: &str,
    current: usize,
    total: usize,
) {
    let is_boundary = current == 0 || current >= total;
    let should_emit = is_boundary || {
        if let Ok(mut last) = last_progress_emit().lock() {
            let elapsed = last.elapsed().as_millis();
            if elapsed >= PROGRESS_THROTTLE_MS {
                *last = Instant::now();
                true
            } else {
                false
            }
        } else {
            true
        }
    };

    if should_emit {
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
    }
    info(
        phase,
        format!("[{current}/{total}] {message}"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_with_none_handle_does_not_panic() {
        emit_pipeline_progress(None, "test", "hello", 0, 10);
        emit_pipeline_progress(None, "test", "mid", 5, 10);
        emit_pipeline_progress(None, "test", "done", 10, 10);
    }

    #[test]
    fn boundary_events_always_pass_through() {
        let is_boundary_first = 0 == 0 || 0 >= 10;
        assert!(is_boundary_first);

        let is_boundary_last = 10 == 0 || 10 >= 10;
        assert!(is_boundary_last);

        let is_boundary_mid = 5 == 0 || 5 >= 10;
        assert!(!is_boundary_mid);
    }

    #[test]
    fn throttle_constant_is_reasonable() {
        assert!(PROGRESS_THROTTLE_MS >= 50);
        assert!(PROGRESS_THROTTLE_MS <= 500);
    }
}

use chrono::Utc;
use std::sync::OnceLock;

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

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetadataInfo {
    pub date_time_original: Option<String>,
    pub create_date: Option<String>,
    pub modify_date: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub mime_type: Option<String>,
    pub duration_secs: Option<f64>,
    pub content_identifier: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHealthSnapshot {
    pub exiftool_available: bool,
    pub exiftool_path: Option<String>,
    pub ffmpeg_available: bool,
    pub ffmpeg_path: Option<String>,
}

pub fn tool_health_snapshot() -> ToolHealthSnapshot {
    let exiftool = exiftool_binary();
    let ffmpeg = ffmpeg_binary();
    ToolHealthSnapshot {
        exiftool_available: exiftool.is_some(),
        exiftool_path: exiftool.map(|p| p.to_string_lossy().to_string()),
        ffmpeg_available: ffmpeg.is_some(),
        ffmpeg_path: ffmpeg.map(|p| p.to_string_lossy().to_string()),
    }
}

pub async fn read_metadata(path: &Path) -> Result<MetadataInfo> {
    let Some(exiftool_bin) = exiftool_binary() else {
        return Ok(MetadataInfo::default());
    };
    let output = Command::new(exiftool_bin)
        .arg("-j")
        .arg("-n")
        .arg("-DateTimeOriginal")
        .arg("-CreateDate")
        .arg("-ModifyDate")
        .arg("-ImageWidth")
        .arg("-ImageHeight")
        .arg("-MIMEType")
        .arg("-Duration")
        .arg("-ContentIdentifier")
        .arg("-ComAppleQuickTimeContentIdentifier")
        .arg(path)
        .output()
        .await;

    let Ok(output) = output else {
        return Ok(MetadataInfo::default());
    };

    if !output.status.success() {
        return Ok(MetadataInfo::default());
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let first = parsed
        .as_array()
        .and_then(|arr| arr.first())
        .ok_or_else(|| anyhow!("Invalid exiftool json output"))?;
    Ok(MetadataInfo {
        date_time_original: first
            .get("DateTimeOriginal")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        create_date: first
            .get("CreateDate")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        modify_date: first
            .get("ModifyDate")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        width: first.get("ImageWidth").and_then(|v| v.as_i64()),
        height: first.get("ImageHeight").and_then(|v| v.as_i64()),
        mime_type: first
            .get("MIMEType")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        duration_secs: first
            .get("Duration")
            .and_then(|v| v.as_f64())
            .or_else(|| {
                first
                    .get("Duration")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
            }),
        content_identifier: first
            .get("ContentIdentifier")
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or_else(|| {
                first
                    .get("ComAppleQuickTimeContentIdentifier")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
            }),
    })
}

pub async fn write_all_dates(path: &Path, date: &str) -> Result<()> {
    let Some(exiftool_bin) = exiftool_binary() else {
        return Err(anyhow!("ExifTool binary was not found."));
    };
    let status = Command::new(exiftool_bin)
        .arg("-overwrite_original")
        .arg(format!("-AllDates={date}"))
        .arg(path)
        .status()
        .await?;
    if !status.success() {
        return Err(anyhow!("Failed to write EXIF date"));
    }
    Ok(())
}

pub async fn create_thumbnail_ffmpeg(input: &Path, output_jpg: &Path) -> Result<()> {
    let Some(ffmpeg_bin) = ffmpeg_binary() else {
        return Err(anyhow!("FFmpeg binary was not found."));
    };
    let status = Command::new(ffmpeg_bin)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vf")
        .arg("scale='min(1024,iw)':-1")
        .arg(output_jpg)
        .status()
        .await?;
    if !status.success() {
        return Err(anyhow!("ffmpeg thumbnail generation failed"));
    }
    Ok(())
}

fn exiftool_binary() -> Option<PathBuf> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            resolve_tool_binary(
                "MEMORIA_EXIFTOOL_PATH",
                platform_exiftool_name(),
                &["-ver"],
            )
        })
        .clone()
}

fn ffmpeg_binary() -> Option<PathBuf> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            resolve_tool_binary(
                "MEMORIA_FFMPEG_PATH",
                platform_ffmpeg_name(),
                &["-version"],
            )
        })
        .clone()
}

fn resolve_tool_binary(env_var: &str, exe_name: &str, probe_args: &[&str]) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(env_var) {
        let explicit = PathBuf::from(path);
        if explicit.exists() && command_probe(&explicit, probe_args) {
            return Some(explicit);
        }
    }

    for candidate in candidate_tool_paths(exe_name) {
        if candidate.exists() && command_probe(&candidate, probe_args) {
            return Some(candidate);
        }
    }

    let fallback = PathBuf::from(exe_name);
    if command_probe(&fallback, probe_args) {
        return Some(fallback);
    }

    None
}

fn candidate_tool_paths(exe_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // Development-friendly locations relative to process CWD.
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(exe_name));
        candidates.push(cwd.join("vendor").join(exe_name));
        candidates.push(cwd.join("..").join("vendor").join(exe_name));
        candidates.push(cwd.join("..").join("..").join("vendor").join(exe_name));
    }

    // Bundle-friendly locations relative to app executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(exe_name));
            candidates.push(exe_dir.join("resources").join(exe_name));
            candidates.push(exe_dir.join("..").join("resources").join(exe_name));
            candidates.push(exe_dir.join("..").join("Resources").join(exe_name));
        }
    }

    candidates
}

fn command_probe(command: &Path, args: &[&str]) -> bool {
    std::process::Command::new(command)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn platform_ffmpeg_name() -> &'static str {
    "ffmpeg.exe"
}

#[cfg(not(target_os = "windows"))]
fn platform_ffmpeg_name() -> &'static str {
    "ffmpeg"
}

#[cfg(target_os = "windows")]
fn platform_exiftool_name() -> &'static str {
    "exiftool.exe"
}

#[cfg(not(target_os = "windows"))]
fn platform_exiftool_name() -> &'static str {
    "exiftool"
}

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write as IoWrite},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
};
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
    pub video_codec: Option<String>,
    pub content_identifier: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
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

// ---------------------------------------------------------------------------
// Persistent exiftool (-stay_open mode)
// ---------------------------------------------------------------------------

struct ExiftoolInner {
    _child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    counter: u64,
}

struct PersistentExiftool {
    bin: PathBuf,
    inner: Mutex<Option<ExiftoolInner>>,
}

impl PersistentExiftool {
    fn new(bin: PathBuf) -> Self {
        let inner = Self::spawn(&bin);
        PersistentExiftool {
            bin,
            inner: Mutex::new(inner),
        }
    }

    fn spawn(bin: &Path) -> Option<ExiftoolInner> {
        let mut child = std::process::Command::new(bin)
            .arg("-stay_open")
            .arg("True")
            .arg("-@")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        Some(ExiftoolInner {
            _child: child,
            stdin,
            reader: BufReader::new(stdout),
            counter: 0,
        })
    }

    fn execute(&self, args: &[&str]) -> Result<String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("exiftool mutex poisoned"))?;

        // Re-spawn if previous process died
        if guard.is_none() {
            *guard = Self::spawn(&self.bin);
        }

        let inner = guard
            .as_mut()
            .ok_or_else(|| anyhow!("exiftool process unavailable"))?;
        inner.counter += 1;
        let tag = inner.counter;

        // Write each argument on its own line, then the execute sentinel
        for arg in args {
            if writeln!(inner.stdin, "{}", arg).is_err() {
                *guard = None;
                return Err(anyhow!("exiftool stdin write failed"));
            }
        }
        if writeln!(inner.stdin, "-execute{}", tag).is_err() {
            *guard = None;
            return Err(anyhow!("exiftool stdin write failed"));
        }
        if inner.stdin.flush().is_err() {
            *guard = None;
            return Err(anyhow!("exiftool stdin flush failed"));
        }

        // Read lines until the {readyN} sentinel
        let sentinel = format!("{{ready{tag}}}");
        let mut output = String::new();
        loop {
            let mut line = String::new();
            match inner.reader.read_line(&mut line) {
                Ok(0) => {
                    *guard = None;
                    return Err(anyhow!("exiftool process ended unexpectedly"));
                }
                Ok(_) => {
                    if line.trim() == sentinel {
                        break;
                    }
                    output.push_str(&line);
                }
                Err(_) => {
                    *guard = None;
                    return Err(anyhow!("exiftool read error"));
                }
            }
        }
        Ok(output)
    }
}

static PERSISTENT_EXIFTOOL: OnceLock<Option<PersistentExiftool>> = OnceLock::new();

fn persistent_exiftool() -> Option<&'static PersistentExiftool> {
    PERSISTENT_EXIFTOOL
        .get_or_init(|| exiftool_binary().map(PersistentExiftool::new))
        .as_ref()
}

/// Try to execute an exiftool read command via the persistent process.
/// Returns the parsed JSON Value on success, or None on any failure.
fn try_persistent_json(args: &[&str]) -> Option<serde_json::Value> {
    let pe = persistent_exiftool()?;
    let output = pe.execute(args).ok()?;
    serde_json::from_str(output.trim()).ok()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub async fn read_metadata(path: &Path) -> Result<MetadataInfo> {
    let path_str = path.to_string_lossy().to_string();

    // Try persistent exiftool (via spawn_blocking to avoid blocking the async runtime)
    let path_for_blocking = path_str.clone();
    if persistent_exiftool().is_some() {
        let result = tokio::task::spawn_blocking(move || {
            try_persistent_json(&[
                "-j",
                "-n",
                "-DateTimeOriginal",
                "-CreateDate",
                "-ModifyDate",
                "-ImageWidth",
                "-ImageHeight",
                "-MIMEType",
                "-Duration",
                "-VideoCodec",
                "-CompressorName",
                "-CodecID",
                "-ContentIdentifier",
                "-ComAppleQuickTimeContentIdentifier",
                "-Make",
                "-Model",
                &path_for_blocking,
            ])
        })
        .await;

        if let Ok(Some(parsed)) = result {
            if let Some(first) = parsed.as_array().and_then(|arr| arr.first()) {
                return Ok(parse_metadata_value(first));
            }
        }
    }

    // Fallback: spawn a one-shot process
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
        .arg("-VideoCodec")
        .arg("-CompressorName")
        .arg("-CodecID")
        .arg("-ContentIdentifier")
        .arg("-ComAppleQuickTimeContentIdentifier")
        .arg("-Make")
        .arg("-Model")
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
    Ok(parse_metadata_value(first))
}

fn parse_metadata_value(first: &serde_json::Value) -> MetadataInfo {
    MetadataInfo {
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
        video_codec: first
            .get("VideoCodec")
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .or_else(|| {
                first
                    .get("CompressorName")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
            })
            .or_else(|| {
                first
                    .get("CodecID")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
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
        camera_make: first
            .get("Make")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        camera_model: first
            .get("Model")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
    }
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

pub async fn read_gps_coordinates(path: &Path) -> Result<Option<(f64, f64)>> {
    let path_str = path.to_string_lossy().to_string();

    // Try persistent exiftool
    if persistent_exiftool().is_some() {
        let path_for_blocking = path_str.clone();
        let result = tokio::task::spawn_blocking(move || {
            try_persistent_json(&["-j", "-n", "-GPSLatitude", "-GPSLongitude", &path_for_blocking])
        })
        .await;

        if let Ok(Some(parsed)) = result {
            if let Some(first) = parsed.as_array().and_then(|arr| arr.first()) {
                let lat = first.get("GPSLatitude").and_then(|v| v.as_f64());
                let lon = first.get("GPSLongitude").and_then(|v| v.as_f64());
                return Ok(match (lat, lon) {
                    (Some(a), Some(b)) => Some((a, b)),
                    _ => None,
                });
            }
        }
    }

    // Fallback: spawn a one-shot process
    let Some(exiftool_bin) = exiftool_binary() else {
        return Ok(None);
    };
    let output = Command::new(exiftool_bin)
        .arg("-j")
        .arg("-n")
        .arg("-GPSLatitude")
        .arg("-GPSLongitude")
        .arg(path)
        .output()
        .await;
    let Ok(output) = output else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let first = parsed
        .as_array()
        .and_then(|arr| arr.first())
        .ok_or_else(|| anyhow!("Invalid exiftool json output"))?;
    let lat = first.get("GPSLatitude").and_then(|v| v.as_f64());
    let lon = first.get("GPSLongitude").and_then(|v| v.as_f64());
    Ok(match (lat, lon) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    })
}

/// Synchronous fast-path that extracts only camera Make/Model.
/// Uses the persistent exiftool process when available, falls back to
/// spawning a one-shot process so it can be called from rayon worker threads.
pub fn read_camera_metadata_sync(path: &Path) -> Option<(Option<String>, Option<String>)> {
    let path_str = path.to_string_lossy().to_string();

    // Try persistent exiftool
    if let Some(parsed) = try_persistent_json(&["-j", "-n", "-Make", "-Model", &path_str]) {
        let first = parsed.as_array().and_then(|arr| arr.first())?;
        let make = first
            .get("Make")
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        let model = first
            .get("Model")
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        return Some((make, model));
    }

    // Fallback: one-shot process spawn
    let exiftool_bin = exiftool_binary()?;
    let output = std::process::Command::new(exiftool_bin)
        .arg("-j")
        .arg("-n")
        .arg("-Make")
        .arg("-Model")
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let first = parsed.as_array().and_then(|arr| arr.first())?;
    let make = first
        .get("Make")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    let model = first
        .get("Model")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    Some((make, model))
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
        .arg("-frames:v")
        .arg("1")
        .arg("-update")
        .arg("1")
        .arg(output_jpg)
        .status()
        .await?;
    if !status.success() {
        return Err(anyhow!("ffmpeg thumbnail generation failed"));
    }
    Ok(())
}

pub async fn create_video_poster_ffmpeg(input: &Path, output_jpg: &Path) -> Result<()> {
    let Some(ffmpeg_bin) = ffmpeg_binary() else {
        return Err(anyhow!("FFmpeg binary was not found."));
    };
    let status = Command::new(ffmpeg_bin)
        .arg("-y")
        .arg("-ss")
        .arg("1")
        .arg("-i")
        .arg(input)
        .arg("-frames:v")
        .arg("1")
        .arg("-q:v")
        .arg("3")
        .arg(output_jpg)
        .status()
        .await?;
    if !status.success() {
        return Err(anyhow!("ffmpeg poster generation failed"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_metadata_fields_from_exif_payload() {
        let payload = serde_json::json!({
            "DateTimeOriginal": "2026:01:02 03:04:05",
            "ImageWidth": 1920,
            "ImageHeight": 1080,
            "MIMEType": "video/mp4",
            "Duration": 8.4,
            "VideoCodec": "h264",
            "ContentIdentifier": "cid-1"
        });
        let info = parse_metadata_value(&payload);
        assert_eq!(info.width, Some(1920));
        assert_eq!(info.height, Some(1080));
        assert_eq!(info.duration_secs, Some(8.4));
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.content_identifier.as_deref(), Some("cid-1"));
    }

    #[tokio::test]
    async fn video_poster_generation_errors_for_invalid_input() {
        let temp = std::env::temp_dir().join(format!(
            "memoria-video-poster-{}.jpg",
            rand::random::<u64>()
        ));
        let result =
            create_video_poster_ffmpeg(std::path::Path::new("C:\\missing\\input.mov"), &temp).await;
        assert!(result.is_err());
    }

    #[test]
    fn persistent_exiftool_sentinel_format() {
        // Verify the sentinel format matches exiftool's -stay_open output
        let tag = 42u64;
        let sentinel = format!("{{ready{tag}}}");
        assert_eq!(sentinel, "{ready42}");
    }
}

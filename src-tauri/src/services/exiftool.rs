use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
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

pub async fn read_metadata(path: &Path) -> Result<MetadataInfo> {
    let output = Command::new("exiftool")
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
    let status = Command::new("exiftool")
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
    let status = Command::new("ffmpeg")
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

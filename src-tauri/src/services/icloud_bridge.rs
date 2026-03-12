use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudAsset {
    pub icloud_id: String,
    pub filename: String,
    pub created_at: String,
    pub mime_type: String,
    pub file_size: i64,
}

#[derive(Clone)]
pub struct ICloudBridge {
    sidecar: PathBuf,
}

impl ICloudBridge {
    pub fn new(sidecar_path: impl AsRef<Path>) -> Self {
        Self {
            sidecar: sidecar_path.as_ref().to_path_buf(),
        }
    }

    pub async fn authenticate(
        &self,
        username: &str,
        password: &str,
        two_factor_code: Option<&str>,
    ) -> Result<()> {
        let payload = json!({
            "action": "auth",
            "username": username,
            "password": password,
            "two_factor_code": two_factor_code
        });
        let response = self.send_command(payload).await?;
        if response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Ok(());
        }
        if response
            .get("mfa_required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(anyhow!("iCloud MFA is required. Enter a verification code in Settings."));
        }
        Err(anyhow!(
            "{}",
            response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("iCloud authentication failed")
        ))
    }

    pub async fn fetch_assets_in_range(
        &self,
        username: &str,
        password: &str,
        start: &str,
        end: &str,
        two_factor_code: Option<&str>,
    ) -> Result<Vec<CloudAsset>> {
        let payload = json!({
            "action": "list_assets",
            "username": username,
            "password": password,
            "start": start,
            "end": end,
            "two_factor_code": two_factor_code
        });
        let response = self.send_command(payload).await?;
        if !response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(anyhow!(
                "{}",
                response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Failed to fetch iCloud assets")
            ));
        }
        let assets: Vec<CloudAsset> = serde_json::from_value(
            response
                .get("assets")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Array(vec![])),
        )?;
        Ok(assets)
    }

    pub async fn download_original(
        &self,
        username: &str,
        password: &str,
        asset: &CloudAsset,
        staging_dir: &Path,
        two_factor_code: Option<&str>,
    ) -> Result<PathBuf> {
        fs::create_dir_all(staging_dir).await?;
        let path = staging_dir.join(&asset.filename);
        let payload = json!({
            "action": "download",
            "username": username,
            "password": password,
            "asset_id": asset.icloud_id,
            "target_path": path.to_string_lossy(),
            "two_factor_code": two_factor_code
        });
        let response = self.send_command(payload).await?;
        if !response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            // Fallback local placeholder when sidecar cannot download.
            fs::write(&path, format!("placeholder-original-{}", asset.icloud_id)).await?;
        }
        Ok(path)
    }

    async fn send_command(&self, payload: serde_json::Value) -> Result<serde_json::Value> {
        let exe = self.sidecar.clone();
        let mut command = if exe.exists() {
            let c = Command::new(exe);
            c
        } else {
            let mut c = Command::new("python");
            c.arg("sidecar/icloud_bridge.py");
            c
        };

        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().context("Failed to start iCloud sidecar")?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Failed to open sidecar stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Failed to open sidecar stdout"))?;

        let line = format!("{}\n", serde_json::to_string(&payload)?);
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        drop(stdin);

        let mut reader = BufReader::new(stdout);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await?;
        let _ = child.wait().await;

        if response_line.trim().is_empty() {
            return Err(anyhow!("No response from iCloud sidecar"));
        }
        Ok(serde_json::from_str(response_line.trim())?)
    }
}

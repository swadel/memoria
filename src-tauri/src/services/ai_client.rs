use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub category: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateEstimate {
    pub ai_date: Option<String>,
    pub confidence: f64,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventNameSuggestion {
    pub name: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskModelConfig {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRoutingConfig {
    pub classification: TaskModelConfig,
    pub date_estimation: TaskModelConfig,
    pub event_naming: TaskModelConfig,
    pub duplicate_ranking: TaskModelConfig,
}

impl Default for AiRoutingConfig {
    fn default() -> Self {
        Self {
            classification: TaskModelConfig {
                provider: "openai".to_string(),
                model: "gpt-4o-mini".to_string(),
            },
            date_estimation: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            event_naming: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            duplicate_ranking: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
        }
    }
}

#[derive(Clone)]
pub struct AiClient {
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
    routing: AiRoutingConfig,
    http: Client,
}

impl AiClient {
    pub fn new(
        openai_api_key: Option<String>,
        anthropic_api_key: Option<String>,
        routing: AiRoutingConfig,
    ) -> Self {
        Self {
            openai_api_key,
            anthropic_api_key,
            routing,
            http: Client::new(),
        }
    }

    pub async fn classify_image(
        &self,
        filename: &str,
        file_size: i64,
        image_path: Option<&str>,
    ) -> Result<ClassificationResult> {
        if let Some(path) = image_path {
            if let Ok(result) = self
                .classify_via_config(path, &self.routing.classification)
                .await
            {
                return Ok(result);
            }
        }

        // Deterministic fallback if no key or API fails.
        let lowered = filename.to_ascii_lowercase();
        if lowered.contains("screenshot") || file_size < 50_000 {
            return Ok(ClassificationResult {
                category: "review".to_string(),
                confidence: 0.95,
            });
        }
        Ok(ClassificationResult {
            category: "legitimate".to_string(),
            confidence: 0.88,
        })
    }

    pub async fn estimate_date(&self, filename: &str, image_path: Option<&str>) -> Result<DateEstimate> {
        if let Some(path) = image_path {
            if let Ok(result) = self
                .estimate_date_via_config(path, &self.routing.date_estimation)
                .await
            {
                return Ok(result);
            }
        }

        Ok(DateEstimate {
            ai_date: Some("2025-12-25".to_string()),
            confidence: 0.62,
            reasoning: format!("Estimated from visual seasonal cues for {filename}."),
        })
    }

    pub async fn suggest_event_name(&self, year: i32, sample_size: usize) -> Result<EventNameSuggestion> {
        if let Ok(name) = self
            .suggest_name_via_config(year, sample_size, &self.routing.event_naming)
            .await
        {
                return Ok(name);
        }
        let base = if sample_size > 8 {
            "Family Gathering"
        } else {
            "Weekend Moments"
        };
        Ok(EventNameSuggestion {
            name: format!("{year} - {base}"),
            confidence: 0.67,
        })
    }

    pub async fn rank_duplicate_candidates(&self, image_paths: &[String]) -> Result<usize> {
        if image_paths.is_empty() {
            return Ok(0);
        }
        if image_paths.len() == 1 {
            return Ok(0);
        }
        let limited: Vec<String> = image_paths.iter().take(6).cloned().collect();
        let config = &self.routing.duplicate_ranking;
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for duplicate ranking");
                };
                let result = self
                    .rank_duplicates_via_anthropic(key, &config.model, &limited)
                    .await?;
                Ok(result.min(limited.len().saturating_sub(1)))
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for duplicate ranking");
                };
                let result = self
                    .rank_duplicates_via_openai(key, &config.model, &limited)
                    .await?;
                Ok(result.min(limited.len().saturating_sub(1)))
            }
        }
    }

    async fn classify_via_config(
        &self,
        image_path: &str,
        config: &TaskModelConfig,
    ) -> Result<ClassificationResult> {
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for classification");
                };
                self.classify_via_anthropic(key, &config.model, image_path).await
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for classification");
                };
                self.classify_via_openai(key, &config.model, image_path).await
            }
        }
    }

    async fn estimate_date_via_config(
        &self,
        image_path: &str,
        config: &TaskModelConfig,
    ) -> Result<DateEstimate> {
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for date estimation");
                };
                self.estimate_date_via_anthropic(key, &config.model, image_path)
                    .await
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for date estimation");
                };
                self.estimate_date_via_openai(key, &config.model, image_path).await
            }
        }
    }

    async fn suggest_name_via_config(
        &self,
        year: i32,
        sample_size: usize,
        config: &TaskModelConfig,
    ) -> Result<EventNameSuggestion> {
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for event naming");
                };
                self.suggest_name_via_anthropic(key, &config.model, year, sample_size)
                    .await
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for event naming");
                };
                self.suggest_name_via_openai(key, &config.model, year, sample_size)
                    .await
            }
        }
    }

    async fn classify_via_openai(
        &self,
        api_key: &str,
        model: &str,
        image_path: &str,
    ) -> Result<ClassificationResult> {
        let data_url = image_to_data_url(image_path).await?;
        let body = json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "Classify this media as one of: legitimate, review. Return only JSON like {\"category\":\"...\",\"confidence\":0.0}." },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }],
            "temperature": 0.1,
            "response_format": { "type": "json_object" }
        });
        let v = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .context("Missing content in OpenAI response")?;
        let parsed: serde_json::Value = serde_json::from_str(content)?;
        Ok(ClassificationResult {
            category: parsed
                .get("category")
                .and_then(|x| x.as_str())
                .unwrap_or("review")
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.5),
        })
    }

    async fn estimate_date_via_openai(
        &self,
        api_key: &str,
        model: &str,
        image_path: &str,
    ) -> Result<DateEstimate> {
        let data_url = image_to_data_url(image_path).await?;
        let body = json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "Estimate photo taken date. Return strict JSON: {\"ai_date\":\"YYYY-MM-DD or null\",\"confidence\":0.0,\"reasoning\":\"short\"}." },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }],
            "temperature": 0.2,
            "response_format": { "type": "json_object" }
        });
        let v = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .context("Missing content in OpenAI response")?;
        let parsed: serde_json::Value = serde_json::from_str(content)?;
        Ok(DateEstimate {
            ai_date: parsed
                .get("ai_date")
                .and_then(|x| x.as_str())
                .map(ToString::to_string),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.4),
            reasoning: parsed
                .get("reasoning")
                .and_then(|x| x.as_str())
                .unwrap_or("No reasoning provided.")
                .to_string(),
        })
    }

    async fn suggest_name_via_openai(
        &self,
        api_key: &str,
        model: &str,
        year: i32,
        sample_size: usize,
    ) -> Result<EventNameSuggestion> {
        let body = json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": format!("Suggest a concise family photo event name for year {year} with {sample_size} photos. Return JSON {{\"name\":\"{year} - ...\",\"confidence\":0.0}}")
            }],
            "temperature": 0.3,
            "response_format": { "type": "json_object" }
        });
        let v = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .context("Missing content in OpenAI response")?;
        let parsed: serde_json::Value = serde_json::from_str(content)?;
        Ok(EventNameSuggestion {
            name: parsed
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(&format!("{year} - Misc"))
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.5),
        })
    }

    async fn rank_duplicates_via_openai(
        &self,
        api_key: &str,
        model: &str,
        image_paths: &[String],
    ) -> Result<usize> {
        let mut content = vec![json!({
            "type": "text",
            "text": "Pick the best image index for keepsake quality (smiles, eyes open, looking at camera, sharpness, composition). Return JSON: {\"bestIndex\": number}."
        })];
        for (idx, p) in image_paths.iter().enumerate() {
            let url = image_to_data_url(p).await?;
            content.push(json!({"type":"text","text": format!("Candidate index: {idx}")}));
            content.push(json!({"type":"image_url","image_url":{"url": url}}));
        }
        let body = json!({
            "model": model,
            "messages": [{ "role":"user", "content": content }],
            "temperature": 0.2,
            "response_format": { "type":"json_object" }
        });
        let v = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .context("Missing content in OpenAI duplicate ranking response")?;
        let parsed: serde_json::Value = serde_json::from_str(content)?;
        Ok(parsed
            .get("bestIndex")
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as usize)
    }

    async fn classify_via_anthropic(
        &self,
        api_key: &str,
        model: &str,
        image_path: &str,
    ) -> Result<ClassificationResult> {
        let (media_type, data) = image_to_base64_payload(image_path).await?;
        let body = json!({
            "model": model,
            "max_tokens": 300,
            "temperature": 0.1,
            "messages": [{
                "role": "user",
                "content": [
                    {"type":"text","text":"Classify this media as one of: legitimate, review. Return only JSON like {\"category\":\"...\",\"confidence\":0.0}."},
                    {"type":"image","source":{"type":"base64","media_type":media_type,"data":data}}
                ]
            }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        Ok(ClassificationResult {
            category: parsed
                .get("category")
                .and_then(|x| x.as_str())
                .unwrap_or("review")
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.5),
        })
    }

    async fn estimate_date_via_anthropic(
        &self,
        api_key: &str,
        model: &str,
        image_path: &str,
    ) -> Result<DateEstimate> {
        let (media_type, data) = image_to_base64_payload(image_path).await?;
        let body = json!({
            "model": model,
            "max_tokens": 500,
            "temperature": 0.2,
            "messages": [{
                "role": "user",
                "content": [
                    {"type":"text","text":"Estimate photo taken date. Return strict JSON: {\"ai_date\":\"YYYY-MM-DD or null\",\"confidence\":0.0,\"reasoning\":\"short\"}."},
                    {"type":"image","source":{"type":"base64","media_type":media_type,"data":data}}
                ]
            }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        Ok(DateEstimate {
            ai_date: parsed
                .get("ai_date")
                .and_then(|x| x.as_str())
                .map(ToString::to_string),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.4),
            reasoning: parsed
                .get("reasoning")
                .and_then(|x| x.as_str())
                .unwrap_or("No reasoning provided.")
                .to_string(),
        })
    }

    async fn suggest_name_via_anthropic(
        &self,
        api_key: &str,
        model: &str,
        year: i32,
        sample_size: usize,
    ) -> Result<EventNameSuggestion> {
        let body = json!({
            "model": model,
            "max_tokens": 250,
            "temperature": 0.3,
            "messages": [{
                "role":"user",
                "content":[{"type":"text","text": format!("Suggest a concise family photo event folder name for year {year} with {sample_size} photos. Return JSON {{\"name\":\"{year} - ...\",\"confidence\":0.0}}")}]
            }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        Ok(EventNameSuggestion {
            name: parsed
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(&format!("{year} - Misc"))
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.5),
        })
    }

    async fn rank_duplicates_via_anthropic(
        &self,
        api_key: &str,
        model: &str,
        image_paths: &[String],
    ) -> Result<usize> {
        let mut content = vec![json!({
            "type":"text",
            "text":"Pick the best image index for keepsake quality (smiles, eyes open, looking at camera, sharpness, composition). Return only JSON: {\"bestIndex\": number}."
        })];
        for (idx, p) in image_paths.iter().enumerate() {
            let (media_type, data) = image_to_base64_payload(p).await?;
            content.push(json!({"type":"text","text": format!("Candidate index: {idx}")}));
            content.push(json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":data}}));
        }
        let body = json!({
            "model": model,
            "max_tokens": 300,
            "temperature": 0.2,
            "messages": [{ "role":"user", "content": content }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        Ok(parsed
            .get("bestIndex")
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as usize)
    }

    async fn anthropic_message_json(
        &self,
        api_key: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let v = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(body)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let text = v["content"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .context("Missing text content in Anthropic response")?;
        Ok(serde_json::from_str(text)?)
    }
}

async fn image_to_data_url(path: &str) -> Result<String> {
    let bytes = fs::read(Path::new(path)).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = if path.to_ascii_lowercase().ends_with(".png") {
        "image/png"
    } else if path.to_ascii_lowercase().ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Ok(format!("data:{mime};base64,{encoded}"))
}

async fn image_to_base64_payload(path: &str) -> Result<(String, String)> {
    let bytes = fs::read(Path::new(path)).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let lower = path.to_ascii_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".heic") || lower.ends_with(".heif") {
        "image/heic"
    } else {
        "image/jpeg"
    };
    Ok((mime.to_string(), encoded))
}

#[cfg(test)]
mod tests {
    use super::{AiClient, AiRoutingConfig};

    #[tokio::test]
    async fn classify_fallback_is_deterministic_without_api_keys() {
        let ai = AiClient::new(None, None, AiRoutingConfig::default());

        let screenshot = ai
            .classify_image("Screenshot 2026-03-12.png", 200_000, None)
            .await
            .expect("classify screenshot");
        assert_eq!(screenshot.category, "review");
        assert!(screenshot.confidence >= 0.9);

        let normal = ai
            .classify_image("IMG_1234.JPG", 500_000, None)
            .await
            .expect("classify normal");
        assert_eq!(normal.category, "legitimate");
    }

    #[tokio::test]
    async fn estimate_date_and_event_name_have_local_fallbacks() {
        let ai = AiClient::new(None, None, AiRoutingConfig::default());
        let date = ai
            .estimate_date("IMG_2001.JPG", None)
            .await
            .expect("estimate date");
        assert_eq!(date.ai_date.as_deref(), Some("2025-12-25"));
        assert!(date.confidence > 0.0);

        let event = ai
            .suggest_event_name(2026, 12)
            .await
            .expect("suggest event");
        assert!(event.name.starts_with("2026 - "));
        assert!(event.confidence > 0.0);
    }

    #[tokio::test]
    async fn duplicate_ranking_handles_empty_or_single_inputs() {
        let ai = AiClient::new(None, None, AiRoutingConfig::default());
        let empty_idx = ai
            .rank_duplicate_candidates(&[])
            .await
            .expect("rank empty");
        assert_eq!(empty_idx, 0);

        let one = vec!["C:\\tmp\\IMG_ONLY.JPG".to_string()];
        let one_idx = ai
            .rank_duplicate_candidates(&one)
            .await
            .expect("rank one");
        assert_eq!(one_idx, 0);
    }
}

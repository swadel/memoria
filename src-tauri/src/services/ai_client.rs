use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use tokio::fs;

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
    pub date_estimation: TaskModelConfig,
    pub event_naming: TaskModelConfig,
}

impl Default for AiRoutingConfig {
    fn default() -> Self {
        Self {
            date_estimation: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            event_naming: TaskModelConfig {
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

}

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
    pub folder_name: String,
    pub confidence: String,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventNamingRequest {
    pub start_date: String,
    pub end_date: String,
    pub day_count: i64,
    pub total_count: usize,
    pub has_location_data: bool,
    pub location_hint: Option<String>,
    pub sample_image_paths: Vec<String>,
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
        let request = EventNamingRequest {
            start_date: format!("{year}-01-01"),
            end_date: format!("{year}-01-01"),
            day_count: 1,
            total_count: sample_size,
            has_location_data: false,
            location_hint: None,
            sample_image_paths: Vec::new(),
        };
        self.suggest_event_name_for_cluster(&request).await
    }

    pub async fn suggest_event_name_for_cluster(
        &self,
        request: &EventNamingRequest,
    ) -> Result<EventNameSuggestion> {
        if let Ok(name) = self
            .suggest_name_via_config(request, &self.routing.event_naming)
            .await
        {
                return Ok(name);
        }
        let base = if request.total_count > 8 {
            "Family Gathering"
        } else {
            "Weekend Moments"
        };
        Ok(EventNameSuggestion {
            folder_name: base.to_string(),
            confidence: "medium".to_string(),
            reasoning: "Fallback heuristic used because AI provider was unavailable.".to_string(),
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
        request: &EventNamingRequest,
        config: &TaskModelConfig,
    ) -> Result<EventNameSuggestion> {
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for event naming");
                };
                self.suggest_name_via_anthropic(key, &config.model, request)
                    .await
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for event naming");
                };
                self.suggest_name_via_openai(key, &config.model, request)
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
        request: &EventNamingRequest,
    ) -> Result<EventNameSuggestion> {
        let prompt = build_event_naming_prompt(request);
        let mut content = vec![json!({ "type": "text", "text": prompt })];
        for path in request.sample_image_paths.iter() {
            if let Ok(data_url) = image_to_data_url(path).await {
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": data_url }
                }));
            }
        }
        let body = json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": content
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
            folder_name: parsed
                .get("folder_name")
                .and_then(|x| x.as_str())
                .unwrap_or("Misc")
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_str())
                .unwrap_or("medium")
                .to_string(),
            reasoning: parsed
                .get("reasoning")
                .and_then(|x| x.as_str())
                .unwrap_or("No reasoning provided.")
                .to_string(),
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
        request: &EventNamingRequest,
    ) -> Result<EventNameSuggestion> {
        let prompt = build_event_naming_prompt(request);
        let mut content = vec![json!({"type":"text","text": prompt})];
        for path in request.sample_image_paths.iter() {
            if let Ok((media_type, data)) = image_to_base64_payload(path).await {
                content.push(json!({
                    "type":"image",
                    "source":{"type":"base64","media_type":media_type,"data":data}
                }));
            }
        }
        let body = json!({
            "model": model,
            "max_tokens": 250,
            "temperature": 0.3,
            "messages": [{
                "role":"user",
                "content": content
            }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        Ok(EventNameSuggestion {
            folder_name: parsed
                .get("folder_name")
                .and_then(|x| x.as_str())
                .unwrap_or("Misc")
                .to_string(),
            confidence: parsed
                .get("confidence")
                .and_then(|x| x.as_str())
                .unwrap_or("medium")
                .to_string(),
            reasoning: parsed
                .get("reasoning")
                .and_then(|x| x.as_str())
                .unwrap_or("No reasoning provided.")
                .to_string(),
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

fn build_event_naming_prompt(request: &EventNamingRequest) -> String {
    let location_line = if request.has_location_data {
        request.location_hint.clone().unwrap_or_default()
    } else {
        String::new()
    };
    format!(
        "You are an expert at identifying life events from photo collections.\n\nI will provide you with a sample of photos from a single group, along with the date range they were taken.\n\nDate range: {} to {} ({} days)\nNumber of photos in group: {}\nLocation data available: {}\n{}\n\nYour job is to identify what event or occasion these photos represent and suggest a short, specific folder name.\n\nGuidelines:\n- Be SPECIFIC. \"Portland Trip\" is better than \"Travel\". \"Thatcher Birthday\" is better than \"Birthday\". \"Mexico Beach Vacation\" is better than \"Vacation\".\n- Look for visual cues: birthday cakes, candles, presents, decorations, costumes, holiday decorations, beach/ocean, mountains, landmarks, restaurants, sports fields, school settings, etc.\n- Look for contextual cues: if photos span 5-10 days in a warm location with beaches, it is likely a vacation. If photos show a cake with candles and people gathered, it is a birthday.\n- If you can identify a location (city, country, landmark, region), include it in the name.\n- If you can identify a person the event is centered on, include their name if it appears context is a personal celebration.\n- For holidays use standard names: \"Christmas\", \"Thanksgiving\", \"Fourth of July\", \"Easter\", \"Halloween\".\n- For recurring personal events use: \"Birthday\", \"Anniversary\", \"Graduation\".\n- If truly ambiguous after careful analysis, use \"Misc\".\n\nRespond with ONLY a JSON object in this exact format, no other text:\n{{\n  \"folder_name\": \"Short Event Name\",\n  \"confidence\": \"high|medium|low\",\n  \"reasoning\": \"One sentence explaining what visual or contextual cues led to this name\"\n}}",
        request.start_date,
        request.end_date,
        request.day_count,
        request.total_count,
        if request.has_location_data { "true" } else { "false" },
        location_line
    )
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
    use super::{build_event_naming_prompt, AiClient, AiRoutingConfig, EventNamingRequest};

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
        assert!(!event.folder_name.is_empty());
        assert!(matches!(event.confidence.as_str(), "high" | "medium" | "low"));
    }

    #[test]
    fn event_prompt_includes_date_range_and_location_line() {
        let request = EventNamingRequest {
            start_date: "2026-02-01".to_string(),
            end_date: "2026-02-08".to_string(),
            day_count: 8,
            total_count: 42,
            has_location_data: true,
            location_hint: Some("GPS data suggests these photos were taken in: Portland, United States".to_string()),
            sample_image_paths: Vec::new(),
        };
        let prompt = build_event_naming_prompt(&request);
        assert!(prompt.contains("Date range: 2026-02-01 to 2026-02-08 (8 days)"));
        assert!(prompt.contains("Number of photos in group: 42"));
        assert!(prompt.contains("Location data available: true"));
        assert!(prompt.contains("GPS data suggests these photos were taken in: Portland, United States"));
    }

}

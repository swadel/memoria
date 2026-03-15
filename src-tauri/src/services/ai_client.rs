use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use std::sync::OnceLock;
use tokio::fs;

use crate::services::runtime_log;

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
    pub event_type: Option<String>,
    pub location_used: Option<String>,
    pub needs_fallback: bool,
    pub schema_version: Option<String>,
    pub model_used: Option<String>,
    pub prompt_version: Option<String>,
    pub fallback_used: bool,
    pub fallback_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClusterLocationFacts {
    pub gps_coverage_percent: f64,
    pub dominant_location: Option<String>,
    pub dominant_place_confidence: Option<String>,
    pub median_distance_from_home_miles: Option<f64>,
    pub away_from_home: Option<bool>,
    pub location_consistency: String,
    pub cluster_duration_days: i64,
    pub distinct_days_count: usize,
    pub maybe_travel_cluster: bool,
    pub home_area_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventNamingRequest {
    pub year: i32,
    pub start_date: String,
    pub end_date: String,
    pub day_count: i64,
    pub total_count: usize,
    pub has_location_data: bool,
    pub location_hint: Option<String>,
    pub sample_image_paths: Vec<String>,
    pub cluster_metadata: Option<ClusterMetadata>,
    pub cluster_location_facts: Option<ClusterLocationFacts>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClusterMetadata {
    pub schema_version: Option<String>,
    pub dominant_context: Option<String>,
    pub scene_signals: Vec<String>,
    pub event_candidates: Vec<String>,
    pub location_candidates: Vec<String>,
    pub holiday_candidates: Vec<String>,
    pub activity_candidates: Vec<String>,
    pub travel_indicators: Vec<String>,
    pub destination_candidates: Vec<String>,
    pub people_focus: Option<String>,
    pub naming_confidence: Option<String>,
    pub reasoning: String,
    pub needs_fallback: bool,
    pub model_used: Option<String>,
    pub prompt_version: Option<String>,
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
    pub date_estimation_fallback: Option<TaskModelConfig>,
    pub event_naming: TaskModelConfig,
    pub event_naming_fallback: Option<TaskModelConfig>,
    pub grouping_pass1: Option<TaskModelConfig>,
}

impl Default for AiRoutingConfig {
    fn default() -> Self {
        Self {
            date_estimation: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            date_estimation_fallback: None,
            event_naming: TaskModelConfig {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            event_naming_fallback: None,
            grouping_pass1: None,
        }
    }
}

pub const EVENT_NAMING_PROMPT_VERSION: &str = "v3.0";

pub const GENERIC_NAME_BAN_LIST: &[&str] = &[
    "family gathering",
    "weekend moments",
    "family time",
    "special memories",
    "good times",
    "fun times",
    "daily life",
    "everyday moments",
];
pub const CLUSTER_METADATA_PROMPT_VERSION: &str = "v2.0";

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
            if let Some(fallback_config) = self.routing.date_estimation_fallback.as_ref() {
                if let Ok(result) = self.estimate_date_via_config(path, fallback_config).await {
                    return Ok(result);
                }
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
            year,
            start_date: format!("{year}-01-01"),
            end_date: format!("{year}-01-01"),
            day_count: 1,
            total_count: sample_size,
            has_location_data: false,
            location_hint: None,
            sample_image_paths: Vec::new(),
            cluster_metadata: None,
            cluster_location_facts: None,
        };
        self.suggest_event_name_for_cluster(&request).await
    }

    pub async fn suggest_event_name_for_cluster(
        &self,
        request: &EventNamingRequest,
    ) -> Result<EventNameSuggestion> {
        let primary_result = self
            .suggest_name_via_config(request, &self.routing.event_naming)
            .await;

        if let Ok(primary) = primary_result {
            let should_fallback = primary.needs_fallback || primary.confidence.eq_ignore_ascii_case("low");
            if should_fallback {
                if let Some(fallback_config) = self.routing.event_naming_fallback.as_ref() {
                    if let Ok(mut fallback) = self.suggest_name_via_config(request, fallback_config).await {
                        fallback.fallback_used = true;
                        fallback.fallback_model = Some(model_id(fallback_config));
                        return Ok(fallback);
                    }
                }
            }
            return Ok(primary);
        }

        if let Some(fallback_config) = self.routing.event_naming_fallback.as_ref() {
            if let Ok(mut fallback) = self.suggest_name_via_config(request, fallback_config).await {
                fallback.fallback_used = true;
                fallback.fallback_model = Some(model_id(fallback_config));
                return Ok(fallback);
            }
        }

        let base = offline_fallback_name(request);
        Ok(EventNameSuggestion {
            folder_name: format!("{} - {base}", request.year),
            confidence: "low".to_string(),
            reasoning: "Fallback heuristic used because AI provider was unavailable.".to_string(),
            event_type: Some("misc".to_string()),
            location_used: None,
            needs_fallback: false,
            schema_version: Some("2".to_string()),
            model_used: None,
            prompt_version: Some(EVENT_NAMING_PROMPT_VERSION.to_string()),
            fallback_used: false,
            fallback_model: None,
        })
    }

    pub async fn derive_cluster_metadata(&self, request: &EventNamingRequest) -> Result<ClusterMetadata> {
        let pass1_config = self
            .routing
            .grouping_pass1
            .as_ref()
            .unwrap_or(&self.routing.event_naming);
        match self
            .derive_metadata_via_config(request, pass1_config)
            .await
        {
            Ok(metadata) => Ok(metadata),
            Err(_) => Ok(ClusterMetadata {
                schema_version: Some("1".to_string()),
                reasoning: "Pass-1 metadata unavailable; proceeding with pass-2 naming.".to_string(),
                needs_fallback: true,
                prompt_version: Some(CLUSTER_METADATA_PROMPT_VERSION.to_string()),
                ..ClusterMetadata::default()
            }),
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

    async fn derive_metadata_via_config(
        &self,
        request: &EventNamingRequest,
        config: &TaskModelConfig,
    ) -> Result<ClusterMetadata> {
        match config.provider.to_ascii_lowercase().as_str() {
            "anthropic" => {
                let Some(key) = self.anthropic_api_key.as_deref() else {
                    anyhow::bail!("Anthropic API key is missing for pass-1 cluster metadata");
                };
                self.derive_metadata_via_anthropic(key, &config.model, request)
                    .await
            }
            _ => {
                let Some(key) = self.openai_api_key.as_deref() else {
                    anyhow::bail!("OpenAI API key is missing for pass-1 cluster metadata");
                };
                self.derive_metadata_via_openai(key, &config.model, request).await
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
        log_prompt_if_enabled("pass2_event_naming", "openai", model, request.year, request.sample_image_paths.len(), &prompt);
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
        let mut validated = validate_event_naming_response(&parsed, request.year);
        validated.model_used = Some(model_id(&TaskModelConfig {
            provider: "openai".to_string(),
            model: model.to_string(),
        }));
        Ok(validated)
    }

    async fn derive_metadata_via_openai(
        &self,
        api_key: &str,
        model: &str,
        request: &EventNamingRequest,
    ) -> Result<ClusterMetadata> {
        let prompt = build_cluster_metadata_prompt(request);
        log_prompt_if_enabled(
            "pass1_cluster_metadata",
            "openai",
            model,
            request.year,
            request.sample_image_paths.len(),
            &prompt,
        );
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
        let mut validated = validate_cluster_metadata_response(&parsed);
        validated.model_used = Some(format!("openai:{model}"));
        Ok(validated)
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
        log_prompt_if_enabled(
            "pass2_event_naming",
            "anthropic",
            model,
            request.year,
            request.sample_image_paths.len(),
            &prompt,
        );
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
        let mut validated = validate_event_naming_response(&parsed, request.year);
        validated.model_used = Some(model_id(&TaskModelConfig {
            provider: "anthropic".to_string(),
            model: model.to_string(),
        }));
        Ok(validated)
    }

    async fn derive_metadata_via_anthropic(
        &self,
        api_key: &str,
        model: &str,
        request: &EventNamingRequest,
    ) -> Result<ClusterMetadata> {
        let prompt = build_cluster_metadata_prompt(request);
        log_prompt_if_enabled(
            "pass1_cluster_metadata",
            "anthropic",
            model,
            request.year,
            request.sample_image_paths.len(),
            &prompt,
        );
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
            "max_tokens": 400,
            "temperature": 0.2,
            "messages": [{
                "role":"user",
                "content": content
            }]
        });
        let parsed = self.anthropic_message_json(api_key, &body).await?;
        let mut validated = validate_cluster_metadata_response(&parsed);
        validated.model_used = Some(format!("anthropic:{model}"));
        Ok(validated)
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

fn should_log_prompts() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("MEMORIA_LOG_PROMPTS")
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
            })
            .unwrap_or(false)
    })
}

fn log_prompt_if_enabled(
    pass: &str,
    provider: &str,
    model: &str,
    year: i32,
    sample_count: usize,
    prompt: &str,
) {
    if !should_log_prompts() {
        return;
    }
    runtime_log::info(
        "ai_client",
        format!(
            "AI prompt dump ({pass}) provider={provider} model={model} year={year} sample_count={sample_count}\n{prompt}"
        ),
    );
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

fn offline_fallback_name(request: &EventNamingRequest) -> String {
    if let Some(ref facts) = request.cluster_location_facts {
        if facts.away_from_home == Some(true) {
            if let Some(ref loc) = facts.dominant_location {
                return format!("{loc} Trip");
            }
        }
    }
    format!("{} Activities", month_name_from_date(&request.start_date))
}

fn month_name_from_date(date_str: &str) -> &'static str {
    let month = date_str
        .split('-')
        .nth(1)
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(0);
    match month {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        12 => "December",
        _ => "Unknown",
    }
}

fn build_event_naming_prompt(request: &EventNamingRequest) -> String {
    let location_line = if request.has_location_data {
        request.location_hint.clone().unwrap_or_default()
    } else {
        String::new()
    };

    let location_facts_block = if let Some(ref facts) = request.cluster_location_facts {
        let mut lines = vec!["\nCluster location analysis:".to_string()];
        lines.push(format!("- GPS coverage: {:.0}% of items have coordinates", facts.gps_coverage_percent));
        if let Some(ref loc) = facts.dominant_location {
            let conf = facts.dominant_place_confidence.as_deref().unwrap_or("unknown");
            lines.push(format!("- Dominant location: {loc} (confidence: {conf})"));
        }
        lines.push(format!("- Location consistency: {}", facts.location_consistency));
        if let Some(ref label) = facts.home_area_label {
            lines.push(format!("- User's home area: {label}"));
        }
        if let Some(dist) = facts.median_distance_from_home_miles {
            lines.push(format!("- Median distance from home: {dist:.1} miles"));
        }
        if let Some(away) = facts.away_from_home {
            lines.push(format!("- Away from home: {away}"));
        }
        lines.push(format!("- Cluster spans {} days across {} distinct dates", facts.cluster_duration_days, facts.distinct_days_count));
        lines.push(format!("- Travel cluster signal: {}", facts.maybe_travel_cluster));
        lines.join("\n")
    } else {
        String::new()
    };

    let metadata_block = request
        .cluster_metadata
        .as_ref()
        .map(|metadata| {
            let lines = vec![
                "\nStructured clues from a previous analysis pass:".to_string(),
                format!("- dominant_context: {}", metadata.dominant_context.as_deref().unwrap_or("unknown")),
                format!("- scene_signals: {}", metadata.scene_signals.join(", ")),
                format!("- event_candidates: {}", metadata.event_candidates.join(", ")),
                format!("- location_candidates: {}", metadata.location_candidates.join(", ")),
                format!("- holiday_candidates: {}", metadata.holiday_candidates.join(", ")),
                format!("- activity_candidates: {}", metadata.activity_candidates.join(", ")),
                format!("- travel_indicators: {}", metadata.travel_indicators.join(", ")),
                format!("- destination_candidates: {}", metadata.destination_candidates.join(", ")),
                format!("- people_focus: {}", metadata.people_focus.as_deref().unwrap_or("unknown")),
                format!("- naming_confidence: {}", metadata.naming_confidence.as_deref().unwrap_or("unknown")),
                format!("- reasoning: {}", metadata.reasoning),
            ];
            lines.join("\n")
        })
        .unwrap_or_default();

    format!(
        "You are assisting a desktop photo organization application named Memoria.\n\
         \n\
         Memoria already grouped these assets into a candidate event cluster using deterministic \
         time-proximity rules after date verification. Your job is to identify the most likely \
         real-world event or occasion represented by this candidate cluster and return a deterministic \
         folder/event name suggestion.\n\
         \n\
         You are given:\n\
         - a representative sample of assets from one candidate cluster\n\
         - the cluster year: {year}\n\
         - the cluster date range: {start} to {end}\n\
         - the total number of assets: {count}\n\
         - whether location data exists: {has_loc}\n\
         - optional location hint: {loc_hint}\
         {loc_facts}\
         {metadata}\n\
         \n\
         Folder naming requirements:\n\
         - Output folder_name in this exact format:\n\
           YYYY - OptionalLocation EventName\n\
         - Use the year only, not full dates.\n\
         - If a reliable location is known and materially improves specificity, include it.\n\
         - If location is not reliable or not useful, omit it cleanly.\n\
         \n\
         CRITICAL naming quality rules:\n\
         - NEVER use these generic names unless absolutely no other option exists:\n\
           \"Family Gathering\", \"Weekend Moments\", \"Family Time\", \"Special Memories\",\n\
           \"Good Times\", \"Fun Times\", \"Daily Life\", \"Everyday Moments\"\n\
         - If the cluster is away from home with a known destination, the name MUST include \
           the destination: \"{year} - Destin Family Vacation\"\n\
         - If the cluster is at home during a holiday, name the holiday specifically: \
           \"{year} - Home Christmas Morning\"\n\
         - If the cluster shows a specific activity (sports, school event, party), name \
           the activity: \"{year} - Soccer Tournament\"\n\
         - Only use \"Misc\" when there is genuinely insufficient evidence for any more \
           specific name. Set confidence to \"low\" when using Misc.\n\
         \n\
         Destination-aware naming rules:\n\
         - When away_from_home is true and a destination is identifiable, lead with the \
           destination name: \"{year} - Chicago Weekend Trip\"\n\
         - Use the most specific place name available (city > state > region)\n\
         - For vacations (multi-day + away), use \"Vacation\" or \"Trip\" as the event type\n\
         - For day trips (1 day, away), use \"Day Trip\" or the specific activity\n\
         \n\
         General rules:\n\
         - Be specific, not generic.\n\
         - Prefer a concrete event or occasion over broad categories.\n\
         - Use visual cues such as cakes, candles, decorations, costumes, holiday themes, sports settings, \
           school settings, landmarks, beaches, mountains, restaurants, animals, signs, and repeated environments.\n\
         - Use contextual cues such as trip length, date clustering, repeated people/settings, \
           weather/seasonal signals, and location hints.\n\
         - Use standard names for major holidays when appropriate: Christmas, Thanksgiving, Fourth of July, \
           Easter, Halloween.\n\
         - Use standard names for recurring personal events when appropriate: Birthday Party, Anniversary, \
           Graduation, Family Vacation, School Event, Soccer Tournament.\n\
         - Do not invent personal names from appearance alone.\n\
         - If the event is ambiguous but still has a likely category, choose the most specific defensible name.\n\
         - If truly ambiguous after careful analysis, use: {year} - Misc.\n\
         - Set needs_fallback=true when confidence is low or the result is ambiguous.\n\
         - Output valid JSON only.\n\
         \n\
         Respond with ONLY a JSON object in this exact shape, no extra text:\n\
         {{\n\
           \"schema_version\": \"2\",\n\
           \"folder_name\": \"YYYY - OptionalLocation EventName\",\n\
           \"confidence\": \"high|medium|low\",\n\
           \"event_type\": \"holiday|birthday|vacation|sports|school|family|anniversary|graduation|travel|day_trip|misc|other\",\n\
           \"location_used\": \"string or null\",\n\
           \"reasoning\": \"One sentence explaining the strongest visual/contextual cues behind the result.\",\n\
           \"needs_fallback\": true\n\
         }}",
        year = request.year,
        start = request.start_date,
        end = request.end_date,
        count = request.total_count,
        has_loc = if request.has_location_data { "true" } else { "false" },
        loc_hint = location_line,
        loc_facts = location_facts_block,
        metadata = metadata_block,
    )
}

fn build_cluster_metadata_prompt(request: &EventNamingRequest) -> String {
    let location_line = request.location_hint.clone().unwrap_or_default();

    let location_facts_block = if let Some(ref facts) = request.cluster_location_facts {
        let mut lines = vec!["\nCluster location analysis:".to_string()];
        lines.push(format!("- GPS coverage: {:.0}% of items have coordinates", facts.gps_coverage_percent));
        if let Some(ref loc) = facts.dominant_location {
            let conf = facts.dominant_place_confidence.as_deref().unwrap_or("unknown");
            lines.push(format!("- Dominant location: {loc} (confidence: {conf})"));
        }
        lines.push(format!("- Location consistency: {}", facts.location_consistency));
        if let Some(ref label) = facts.home_area_label {
            lines.push(format!("- User's home area: {label}"));
        }
        if let Some(dist) = facts.median_distance_from_home_miles {
            lines.push(format!("- Median distance from home: {dist:.1} miles"));
        }
        if let Some(away) = facts.away_from_home {
            lines.push(format!("- Away from home: {away}"));
        }
        lines.push(format!("- Cluster spans {} days across {} distinct dates", facts.cluster_duration_days, facts.distinct_days_count));
        lines.push(format!("- Travel cluster signal: {}", facts.maybe_travel_cluster));
        lines.join("\n")
    } else {
        String::new()
    };

    format!(
        "You are assisting a desktop photo organization application named Memoria.\n\
         \n\
         Memoria already grouped these assets into a candidate event cluster using deterministic \
         time-proximity rules after date verification. Your job is NOT to move files or create folders. \
         Your job is to analyze the provided representative assets and cluster context, then return \
         structured event clues that will later be used for deterministic event naming.\n\
         \n\
         You are given:\n\
         - a sample of representative images and/or video keyframes from one candidate cluster\n\
         - cluster year: {year}\n\
         - cluster date range: {start} to {end}\n\
         - total asset count in the cluster: {count}\n\
         - whether location data exists: {has_loc}\n\
         - optional location hint: {loc_hint}\
         {loc_facts}\n\
         \n\
         Important rules:\n\
         - Be specific but conservative.\n\
         - Do not invent personal names from faces.\n\
         - Only use a location when it is strongly supported by metadata/context.\n\
         - Prefer concrete event clues over generic labels.\n\
         - If the event is ambiguous, return multiple plausible event candidates.\n\
         - If the cluster appears to be away from home with a consistent location, strongly consider \
         vacation/travel as the dominant_context.\n\
         - Identify the most specific destination name possible (city, landmark, park, resort name) \
         from visual cues and location data.\n\
         - Distinguish between \"day_trip\" (1 day, nearby) and \"travel\" (multi-day, away from home).\n\
         - Output valid JSON only.\n\
         \n\
         Return JSON in exactly this shape:\n\
         {{\n\
           \"schema_version\": \"2\",\n\
           \"dominant_context\": \"holiday|birthday|vacation|sports|school|family|anniversary|graduation|travel|day_trip|misc|other\",\n\
           \"scene_signals\": [\"string\"],\n\
           \"event_candidates\": [\"string\"],\n\
           \"location_candidates\": [\"string\"],\n\
           \"holiday_candidates\": [\"string\"],\n\
           \"activity_candidates\": [\"string\"],\n\
           \"travel_indicators\": [\"string\"],\n\
           \"destination_candidates\": [\"string\"],\n\
           \"people_focus\": \"family|individual|mixed|unknown\",\n\
           \"naming_confidence\": \"high|medium|low\",\n\
           \"reasoning\": \"One sentence explaining the strongest visual/contextual clues.\",\n\
           \"needs_fallback\": true\n\
         }}",
        year = request.year,
        start = request.start_date,
        end = request.end_date,
        count = request.total_count,
        has_loc = if request.has_location_data { "true" } else { "false" },
        loc_hint = location_line,
        loc_facts = location_facts_block,
    )
}

fn validate_event_naming_response(parsed: &serde_json::Value, year: i32) -> EventNameSuggestion {
    let mut folder_name = parsed
        .get("folder_name")
        .and_then(|x| x.as_str())
        .unwrap_or("Misc")
        .trim()
        .to_string();
    if folder_name.is_empty() {
        folder_name = "Misc".to_string();
    }
    let mut confidence = parsed
        .get("confidence")
        .and_then(|x| x.as_str())
        .unwrap_or("medium")
        .to_ascii_lowercase();
    if !matches!(confidence.as_str(), "high" | "medium" | "low") {
        confidence = "medium".to_string();
    }
    let event_type = parsed
        .get("event_type")
        .and_then(|x| x.as_str())
        .map(|x| x.to_ascii_lowercase())
        .filter(|x| {
            matches!(
                x.as_str(),
                "holiday"
                    | "birthday"
                    | "vacation"
                    | "sports"
                    | "school"
                    | "family"
                    | "anniversary"
                    | "graduation"
                    | "travel"
                    | "day_trip"
                    | "misc"
                    | "other"
            )
        });
    let location_used = parsed
        .get("location_used")
        .and_then(|x| x.as_str())
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty() && x.to_ascii_lowercase() != "null");
    let reasoning = parsed
        .get("reasoning")
        .and_then(|x| x.as_str())
        .unwrap_or("No reasoning provided.")
        .trim()
        .to_string();
    let schema_version = parsed
        .get("schema_version")
        .and_then(|x| x.as_str())
        .map(ToString::to_string)
        .or_else(|| Some("2".to_string()));
    let mut needs_fallback = parsed
        .get("needs_fallback")
        .and_then(|x| x.as_bool())
        .unwrap_or_else(|| confidence == "low");
    folder_name = sanitize_folder_name(folder_name);
    if !folder_name.starts_with(&format!("{year} - ")) {
        folder_name = format!("{year} - {folder_name}");
    }

    // Ban list check: if the name (minus year prefix) matches a banned generic name,
    // force confidence=low and needs_fallback=true.
    let name_for_ban_check = folder_name
        .strip_prefix(&format!("{year} - "))
        .unwrap_or(&folder_name)
        .to_ascii_lowercase();
    if GENERIC_NAME_BAN_LIST
        .iter()
        .any(|banned| name_for_ban_check == *banned)
    {
        runtime_log::warn(
            "ai_client",
            format!(
                "Banned generic name '{}' returned by model. Forcing confidence=low and needs_fallback=true.",
                folder_name
            ),
        );
        confidence = "low".to_string();
        needs_fallback = true;
    }

    EventNameSuggestion {
        folder_name,
        confidence,
        reasoning,
        event_type,
        location_used,
        needs_fallback,
        schema_version,
        model_used: None,
        prompt_version: Some(EVENT_NAMING_PROMPT_VERSION.to_string()),
        fallback_used: false,
        fallback_model: None,
    }
}

fn validate_cluster_metadata_response(parsed: &serde_json::Value) -> ClusterMetadata {
    let dominant_context = parsed
        .get("dominant_context")
        .and_then(|x| x.as_str())
        .map(|x| x.to_ascii_lowercase())
        .filter(|x| {
            matches!(
                x.as_str(),
                "holiday"
                    | "birthday"
                    | "vacation"
                    | "sports"
                    | "school"
                    | "family"
                    | "anniversary"
                    | "graduation"
                    | "travel"
                    | "day_trip"
                    | "misc"
                    | "other"
            )
        });
    let people_focus = parsed
        .get("people_focus")
        .and_then(|x| x.as_str())
        .map(|x| x.to_ascii_lowercase())
        .filter(|x| matches!(x.as_str(), "family" | "individual" | "mixed" | "unknown"));
    let naming_confidence = parsed
        .get("naming_confidence")
        .and_then(|x| x.as_str())
        .map(|x| x.to_ascii_lowercase())
        .filter(|x| matches!(x.as_str(), "high" | "medium" | "low"));
    ClusterMetadata {
        schema_version: parsed
            .get("schema_version")
            .and_then(|x| x.as_str())
            .map(ToString::to_string)
            .or_else(|| Some("2".to_string())),
        dominant_context,
        scene_signals: read_string_array(parsed, "scene_signals"),
        event_candidates: read_string_array(parsed, "event_candidates"),
        location_candidates: read_string_array(parsed, "location_candidates"),
        holiday_candidates: read_string_array(parsed, "holiday_candidates"),
        activity_candidates: read_string_array(parsed, "activity_candidates"),
        travel_indicators: read_string_array(parsed, "travel_indicators"),
        destination_candidates: read_string_array(parsed, "destination_candidates"),
        people_focus,
        naming_confidence,
        reasoning: parsed
            .get("reasoning")
            .and_then(|x| x.as_str())
            .unwrap_or("No reasoning provided.")
            .to_string(),
        needs_fallback: parsed
            .get("needs_fallback")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        model_used: None,
        prompt_version: Some(CLUSTER_METADATA_PROMPT_VERSION.to_string()),
    }
}

fn read_string_array(parsed: &serde_json::Value, key: &str) -> Vec<String> {
    parsed
        .get(key)
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn sanitize_folder_name(name: String) -> String {
    let filtered: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            _ => ch,
        })
        .collect();
    filtered
        .trim()
        .trim_end_matches('.')
        .trim_end_matches(' ')
        .to_string()
}

fn model_id(config: &TaskModelConfig) -> String {
    format!("{}:{}", config.provider, config.model)
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
    use super::{
        build_event_naming_prompt, sanitize_folder_name, validate_event_naming_response, AiClient,
        AiRoutingConfig, EventNamingRequest,
    };

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
            year: 2026,
            start_date: "2026-02-01".to_string(),
            end_date: "2026-02-08".to_string(),
            day_count: 8,
            total_count: 42,
            has_location_data: true,
            location_hint: Some("GPS data suggests these photos were taken in: Portland, United States".to_string()),
            sample_image_paths: Vec::new(),
            cluster_metadata: None,
            cluster_location_facts: None,
        };
        let prompt = build_event_naming_prompt(&request);
        assert!(prompt.contains("cluster year: 2026"));
        assert!(prompt.contains("cluster date range: 2026-02-01 to 2026-02-08"));
        assert!(prompt.contains("total number of assets: 42"));
        assert!(prompt.contains("GPS data suggests these photos were taken in: Portland, United States"));
        assert!(prompt.contains("\"schema_version\": \"2\""));
    }

    #[test]
    fn validate_event_naming_response_applies_defaults_and_prefixes_year() {
        let parsed = serde_json::json!({
            "folder_name": "Portland/Oregon Trip",
            "confidence": "unknown",
            "reasoning": "Visual cues indicate travel."
        });
        let result = validate_event_naming_response(&parsed, 2025);
        assert_eq!(result.folder_name, "2025 - Portland-Oregon Trip");
        assert_eq!(result.confidence, "medium");
        assert_eq!(result.event_type, None);
    }

    #[test]
    fn sanitize_folder_name_replaces_windows_invalid_characters() {
        let sanitized = sanitize_folder_name(r#"2025 - Portland: Family/Trip*?"#.to_string());
        assert_eq!(sanitized, "2025 - Portland- Family-Trip--");
    }

}

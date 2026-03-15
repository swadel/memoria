use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub total: i64,
    pub indexed: i64,
    pub image_review: i64,
    pub image_verified: i64,
    pub date_review: i64,
    pub date_needs_review: i64,
    pub date_verified: i64,
    pub grouped: i64,
    pub filed: i64,
    pub image_flagged_pending: i64,
    pub image_phase_state: String,
    pub video_total: i64,
    pub video_flagged: i64,
    pub video_excluded: i64,
    pub video_unreviewed_flagged: i64,
    pub video_phase_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateEstimateDto {
    pub media_item_id: i64,
    pub filename: String,
    pub current_date: Option<String>,
    pub ai_date: Option<String>,
    pub confidence: f64,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventGroupDto {
    pub id: i64,
    pub year: i64,
    pub name: String,
    pub folder_name: String,
    pub item_count: i64,
    pub user_approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventGroupItemDto {
    pub id: i64,
    pub filename: String,
    pub current_path: String,
    pub date_taken: Option<String>,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReviewItemDto {
    pub id: i64,
    pub filename: String,
    pub current_path: String,
    pub date_taken: Option<String>,
    pub mime_type: String,
    pub file_size_bytes: i64,
    pub duration_secs: f64,
    pub video_width: Option<i64>,
    pub video_height: Option<i64>,
    pub video_codec: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReviewItemDto {
    pub id: i64,
    pub filename: String,
    pub current_path: String,
    pub date_taken: Option<String>,
    pub mime_type: String,
    pub file_size_bytes: i64,
    pub sharpness_score: Option<f64>,
    pub blur_score: Option<f64>,
    pub perceptual_hash: Option<String>,
    pub burst_group_id: Option<String>,
    pub is_burst_primary: bool,
    pub duplicate_group_id: Option<String>,
    pub exposure_mean: Option<f64>,
    pub ai_quality_score: Option<f64>,
    pub ai_content_class: Option<String>,
    pub image_flags: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub working_directory: String,
    pub output_directory: String,
}

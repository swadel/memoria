use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub total: i64,
    pub downloading: i64,
    pub review: i64,
    pub legitimate: i64,
    pub date_needs_review: i64,
    pub grouped: i64,
    pub filed: i64,
    pub errors: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItemDto {
    pub id: i64,
    pub filename: String,
    pub current_path: String,
    pub classification: Option<String>,
    pub review_reason: Option<String>,
    pub review_reason_details: Option<String>,
    pub duplicate_cluster_id: Option<String>,
    pub status: String,
    pub date_taken: Option<String>,
    pub date_needs_review: bool,
    pub ai_confidence: Option<f64>,
    pub event_group_id: Option<i64>,
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
pub struct SessionInput {
    pub working_directory: String,
    pub output_directory: String,
}

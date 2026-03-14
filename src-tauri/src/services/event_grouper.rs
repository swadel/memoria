use anyhow::Result;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use reqwest::Client;
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use tokio::time::{Duration, Instant};

use super::{
    ai_client::{
        AiClient, ClusterMetadata, EventNameSuggestion, EventNamingRequest, CLUSTER_METADATA_PROMPT_VERSION,
        EVENT_NAMING_PROMPT_VERSION,
    },
    exiftool, runtime_log,
};

const CLUSTER_GAP_DAYS: i64 = 2;
const CLUSTER_SPAN_SPLIT_DAYS: i64 = 14;
const PASS1_MIN_CLUSTER_SIZE: usize = 5;
const NOMINATIM_REVERSE_URL: &str = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_USER_AGENT: &str = "Memoria/1.0 (photo organizer app)";
const NOMINATIM_MIN_REQUEST_INTERVAL_MS: u64 = 1100;

#[derive(Debug, Clone)]
struct ClusterItem {
    id: i64,
    capture_at: NaiveDateTime,
    filename: String,
    current_path: String,
}

#[derive(Debug, Clone)]
struct ClusterNamingOutcome {
    suggestion: EventNameSuggestion,
    pass1: Option<ClusterMetadata>,
}

pub async fn run(conn: &Connection, ai: &AiClient) -> Result<()> {
    runtime_log::info("event_grouper", "Starting event grouping run.");
    conn.execute("DELETE FROM event_groups", [])?;
    conn.execute("UPDATE media_items SET event_group_id=NULL WHERE status='date_verified'", [])?;

    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(date_taken, ''), filename, COALESCE(current_path, '')
         FROM media_items
         WHERE status='date_verified' AND (date_needs_review=0 OR date_needs_review IS NULL)",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut by_year: BTreeMap<i32, Vec<ClusterItem>> = BTreeMap::new();
    for row in rows {
        let (id, date_raw, filename, current_path) = row?;
        if let Some(capture_at) = parse_capture_datetime(&date_raw) {
            by_year
                .entry(capture_at.date().year())
                .or_default()
                .push(ClusterItem {
                    id,
                    capture_at,
                    filename,
                    current_path,
                });
        }
    }
    runtime_log::info(
        "event_grouper",
        format!("Found date-verified items across {} years.", by_year.len()),
    );

    let http = Client::new();
    let mut geocoder = ReverseGeocoder::new();
    let mut total_groups = 0_i64;
    for (year, mut items) in by_year {
        items.sort_by_key(|x| x.capture_at);
        let mut clusters = cluster_by_days(items, CLUSTER_GAP_DAYS);
        clusters = split_long_span_clusters(clusters, CLUSTER_SPAN_SPLIT_DAYS);
        runtime_log::info(
            "event_grouper",
            format!("Year {year}: building {} clusters.", clusters.len()),
        );

        let mut queue = clusters;
        while let Some(cluster) = queue.pop() {
            let outcome = name_cluster(year, &cluster, ai, &http, &mut geocoder).await?;
            let naming = outcome.suggestion;
            let normalized_for_split = naming
                .folder_name
                .strip_prefix(&format!("{year} - "))
                .unwrap_or(naming.folder_name.as_str());
            let lowered = normalized_for_split.to_ascii_lowercase();
            if cluster.len() > 20 && (lowered == "family gathering" || lowered == "misc") {
                let split = split_cluster_at_largest_gap(&cluster);
                if split.len() > 1 {
                    runtime_log::info(
                        "event_grouper",
                        format!(
                            "Cluster '{}' with {} items split at largest gap and queued for renaming.",
                            naming.folder_name,
                            cluster.len()
                        ),
                    );
                    for part in split {
                        queue.push(part);
                    }
                    continue;
                }
            }

            let start_date = cluster.first().map(|x| x.capture_at.date()).expect("cluster has item");
            let end_date = cluster.last().map(|x| x.capture_at.date()).expect("cluster has item");
            let final_folder_name = apply_low_confidence_fallback_if_needed(conn, year, start_date, &naming)?;
            let final_folder_name = resolve_folder_name_collision(conn, year, &final_folder_name)?;
            let simple_name = final_folder_name
                .strip_prefix(&format!("{year} - "))
                .unwrap_or(final_folder_name.as_str())
                .to_string();
            let pass1_json = outcome
                .pass1
                .as_ref()
                .and_then(|metadata| serde_json::to_string(metadata).ok());
            let pass1_model = outcome.pass1.as_ref().and_then(|m| m.model_used.clone());
            let needs_fallback = if naming.needs_fallback { 1 } else { 0 };
            let fallback_used = if naming.fallback_used { 1 } else { 0 };
            let is_misc = if naming
                .event_type
                .as_deref()
                .map(|x| x.eq_ignore_ascii_case("misc"))
                .unwrap_or_else(|| simple_name.eq_ignore_ascii_case("misc"))
            {
                1
            } else {
                0
            };

            conn.execute(
                "INSERT INTO event_groups(
                    year, name, folder_name, ai_suggested_name, is_misc, user_approved, item_count, start_date, end_date,
                    ai_event_type, ai_confidence, ai_reasoning, ai_prompt_version, ai_model_used, ai_location_used,
                    ai_needs_fallback, ai_fallback_used, ai_fallback_model, ai_pass1_result, ai_pass1_model
                 )
                 VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                params![
                    year,
                    simple_name,
                    final_folder_name,
                    naming.folder_name,
                    is_misc,
                    cluster.len() as i64,
                    start_date.to_string(),
                    end_date.to_string(),
                    naming.event_type,
                    naming.confidence,
                    naming.reasoning,
                    naming
                        .prompt_version
                        .clone()
                        .unwrap_or_else(|| EVENT_NAMING_PROMPT_VERSION.to_string()),
                    naming.model_used,
                    naming.location_used,
                    needs_fallback,
                    fallback_used,
                    naming.fallback_model,
                    pass1_json,
                    pass1_model
                ],
            )?;
            conn.execute(
                "INSERT INTO audit_log(media_item_id, action, source, details)
                 VALUES(NULL, 'ai_event_naming_decision', 'event_grouper', ?1)",
                params![json!({
                    "year": year,
                    "cluster_size": cluster.len(),
                    "start_date": start_date.to_string(),
                    "end_date": end_date.to_string(),
                    "final_folder_name": final_folder_name,
                    "prompt_version": naming
                        .prompt_version
                        .clone()
                        .unwrap_or_else(|| EVENT_NAMING_PROMPT_VERSION.to_string()),
                    "model_used": naming.model_used,
                    "confidence": naming.confidence,
                    "event_type": naming.event_type,
                    "needs_fallback": naming.needs_fallback,
                    "fallback_used": naming.fallback_used,
                    "fallback_model": naming.fallback_model,
                    "pass1_prompt_version": outcome
                        .pass1
                        .as_ref()
                        .and_then(|m| m.prompt_version.clone())
                        .unwrap_or_else(|| CLUSTER_METADATA_PROMPT_VERSION.to_string()),
                })
                .to_string()],
            )?;
            let group_id = conn.last_insert_rowid();
            total_groups += 1;
            for item in cluster {
                conn.execute(
                    "UPDATE media_items SET event_group_id=?1, status='grouped', updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![group_id, item.id],
                )?;
            }
        }
    }
    runtime_log::info("event_grouper", format!("Grouping complete. total_groups={total_groups}."));
    Ok(())
}

async fn name_cluster(
    year: i32,
    cluster: &[ClusterItem],
    ai: &AiClient,
    http: &Client,
    geocoder: &mut ReverseGeocoder,
) -> Result<ClusterNamingOutcome> {
    if cluster.len() < 3 {
        return Ok(ClusterNamingOutcome {
            suggestion: EventNameSuggestion {
                folder_name: format!("{year} - Misc"),
                confidence: "medium".to_string(),
                reasoning: "Small cluster default.".to_string(),
                event_type: Some("misc".to_string()),
                location_used: None,
                needs_fallback: false,
                schema_version: Some("1".to_string()),
                model_used: None,
                prompt_version: Some(EVENT_NAMING_PROMPT_VERSION.to_string()),
                fallback_used: false,
                fallback_model: None,
            },
            pass1: None,
        });
    }
    let holiday_default = if is_holiday_cluster(cluster) {
        Some(EventNameSuggestion {
            folder_name: format!("{year} - Family Christmas"),
            confidence: "high".to_string(),
            reasoning: "Date window matches holiday period.".to_string(),
            event_type: Some("holiday".to_string()),
            location_used: None,
            needs_fallback: false,
            schema_version: Some("1".to_string()),
            model_used: None,
            prompt_version: Some(EVENT_NAMING_PROMPT_VERSION.to_string()),
            fallback_used: false,
            fallback_model: None,
        })
    } else {
        None
    };

    let sampled = sample_cluster_items(cluster);
    let start_date = cluster.first().map(|x| x.capture_at.date()).expect("cluster item");
    let end_date = cluster.last().map(|x| x.capture_at.date()).expect("cluster item");
    let day_count = (end_date - start_date).num_days() + 1;
    let location_hint = find_location_hint(cluster, http, geocoder).await?;
    let request = EventNamingRequest {
        year,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        day_count,
        total_count: cluster.len(),
        has_location_data: location_hint.is_some(),
        location_hint,
        sample_image_paths: sampled.into_iter().map(|x| x.current_path).collect(),
        cluster_metadata: None,
    };
    let pass1 = if cluster.len() >= PASS1_MIN_CLUSTER_SIZE {
        Some(ai.derive_cluster_metadata(&request).await?)
    } else {
        None
    };
    let mut request_with_metadata = request.clone();
    request_with_metadata.cluster_metadata = pass1.clone();
    let mut suggestion = ai.suggest_event_name_for_cluster(&request_with_metadata).await?;
    if let Some(default_holiday) = holiday_default {
        if !suggestion.confidence.eq_ignore_ascii_case("high") {
            suggestion = default_holiday;
        }
    }
    if suggestion.folder_name.trim().is_empty() {
        suggestion.folder_name = format!("{year} - Misc");
    }
    Ok(ClusterNamingOutcome { suggestion, pass1 })
}

fn apply_low_confidence_fallback_if_needed(
    conn: &Connection,
    year: i32,
    start_date: NaiveDate,
    naming: &EventNameSuggestion,
) -> Result<String> {
    if !naming.confidence.eq_ignore_ascii_case("low") {
        return Ok(naming.folder_name.trim().to_string());
    }
    let fallback = if naming
        .event_type
        .as_deref()
        .map(|x| x.eq_ignore_ascii_case("misc"))
        .unwrap_or(false)
    {
        format!("{year} - {} Memories", start_date.format("%B"))
    } else {
        naming.folder_name.trim().to_string()
    };
    conn.execute(
        "INSERT INTO audit_log(media_item_id, action, old_value, new_value, source, details)
         VALUES(NULL, 'event_name_low_confidence', ?1, ?2, 'ai_event_naming', ?3)",
        params![naming.folder_name, fallback, naming.reasoning],
    )?;
    Ok(fallback)
}

fn resolve_folder_name_collision(conn: &Connection, year: i32, folder_name: &str) -> Result<String> {
    let mut candidate = folder_name.trim().to_string();
    let mut counter = 2;
    loop {
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM event_groups WHERE year=?1 AND lower(trim(folder_name))=lower(trim(?2)))",
            params![year, candidate],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Ok(candidate);
        }
        runtime_log::warn(
            "event_grouper",
            format!("Folder name collision detected for year {year}: '{candidate}'. Applying suffix."),
        );
        let base = folder_name.trim();
        candidate = format!("{base} {counter}");
        counter += 1;
    }
}

async fn find_location_hint(
    cluster: &[ClusterItem],
    http: &Client,
    geocoder: &mut ReverseGeocoder,
) -> Result<Option<String>> {
    for item in cluster {
        let path = Path::new(item.current_path.as_str());
        if let Some((lat, lon)) = exiftool::read_gps_coordinates(path).await? {
            let result = geocoder.reverse_geocode(http, lat, lon).await;
            if let Some(hint) = location_hint_from_geocode_result(lat, lon, result) {
                return Ok(Some(hint));
            }
        }
    }
    Ok(None)
}

fn location_hint_from_geocode_result(
    lat: f64,
    lon: f64,
    result: Result<Option<(String, String)>>,
) -> Option<String> {
    match result {
        Ok(Some((city, country))) => Some(format!(
            "GPS data suggests these photos were taken in: {city}, {country}"
        )),
        Ok(None) => None,
        Err(err) => {
            runtime_log::warn(
                "event_grouper",
                format!("Reverse geocoding failed for ({lat}, {lon}): {err}"),
            );
            None
        }
    }
}

struct ReverseGeocoder {
    cache: HashMap<String, Option<(String, String)>>,
    last_request_at: Option<Instant>,
    min_interval: Duration,
}

impl ReverseGeocoder {
    fn new() -> Self {
        Self {
            cache: HashMap::new(),
            last_request_at: None,
            min_interval: Duration::from_millis(NOMINATIM_MIN_REQUEST_INTERVAL_MS),
        }
    }

    async fn reverse_geocode(&mut self, http: &Client, latitude: f64, longitude: f64) -> Result<Option<(String, String)>> {
        self.reverse_geocode_with_transport(latitude, longitude, |lat, lon| async move {
            reverse_geocode_nominatim(http, lat, lon).await
        })
        .await
    }

    async fn reverse_geocode_with_transport<F, Fut>(
        &mut self,
        latitude: f64,
        longitude: f64,
        transport: F,
    ) -> Result<Option<(String, String)>>
    where
        F: FnOnce(f64, f64) -> Fut,
        Fut: std::future::Future<Output = Result<Option<(String, String)>>>,
    {
        let key = geocode_cache_key(latitude, longitude);
        if let Some(cached) = self.cache.get(&key) {
            return Ok(cached.clone());
        }
        self.enforce_rate_limit().await;
        let value = transport(latitude, longitude).await?;
        self.cache.insert(key, value.clone());
        Ok(value)
    }

    async fn enforce_rate_limit(&mut self) {
        if let Some(last_request_at) = self.last_request_at {
            let elapsed = last_request_at.elapsed();
            if elapsed < self.min_interval {
                tokio::time::sleep(self.min_interval - elapsed).await;
            }
        }
        self.last_request_at = Some(Instant::now());
    }
}

fn geocode_cache_key(latitude: f64, longitude: f64) -> String {
    format!("{latitude:.2}:{longitude:.2}")
}

fn build_nominatim_reverse_request(
    http: &Client,
    latitude: f64,
    longitude: f64,
) -> Result<reqwest::Request> {
    Ok(http
        .get(NOMINATIM_REVERSE_URL)
        .query(&[
            ("lat", latitude.to_string()),
            ("lon", longitude.to_string()),
            ("format", "json".to_string()),
        ])
        .header("User-Agent", NOMINATIM_USER_AGENT)
        .build()?)
}

async fn reverse_geocode_nominatim(
    http: &Client,
    latitude: f64,
    longitude: f64,
) -> Result<Option<(String, String)>> {
    let request = build_nominatim_reverse_request(http, latitude, longitude)?;
    let value = http
        .execute(request)
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    Ok(extract_city_country(&value))
}

fn extract_city_country(value: &serde_json::Value) -> Option<(String, String)> {
    if let Some(result) = value
        .get("results")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
    {
        let city = result
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let country = result
            .get("country")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !city.is_empty() && !country.is_empty() {
            return Some((city, country));
        }
    }

    let city = value
        .get("address")
        .and_then(|x| x.get("city").or_else(|| x.get("town")).or_else(|| x.get("village")))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let country = value
        .get("address")
        .and_then(|x| x.get("country"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !city.is_empty() && !country.is_empty() {
        return Some((city, country));
    }
    None
}

fn sample_cluster_items(cluster: &[ClusterItem]) -> Vec<ClusterItem> {
    if cluster.is_empty() {
        return Vec::new();
    }
    let deduped = filter_near_duplicates(cluster);
    let target = if deduped.len() < 5 {
        deduped.len()
    } else {
        deduped.len().min(10)
    };
    evenly_distributed_sample(&deduped, target)
}

fn evenly_distributed_sample(items: &[ClusterItem], target: usize) -> Vec<ClusterItem> {
    if target == 0 || items.is_empty() {
        return Vec::new();
    }
    if target >= items.len() {
        return items.to_vec();
    }
    if target == 1 {
        return vec![items[0].clone()];
    }

    let last = items.len() - 1;
    let mut out = Vec::with_capacity(target);
    let mut seen = std::collections::BTreeSet::new();
    for idx in 0..target {
        let pos = (idx as f64 * last as f64 / (target as f64 - 1.0)).round() as usize;
        let bounded = pos.min(last);
        if seen.insert(bounded) {
            out.push(items[bounded].clone());
        }
    }
    out
}

fn filter_near_duplicates(items: &[ClusterItem]) -> Vec<ClusterItem> {
    let mut selected: Vec<ClusterItem> = Vec::new();
    for item in items {
        let prefix = filename_prefix(item.filename.as_str());
        let duplicate = selected.iter().any(|existing| {
            let same_prefix = filename_prefix(existing.filename.as_str()) == prefix;
            let diff = (item.capture_at - existing.capture_at).num_seconds().abs();
            same_prefix && diff <= 5
        });
        if !duplicate {
            selected.push(item.clone());
        }
    }
    selected
}

fn filename_prefix(filename: &str) -> String {
    let stem = filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(filename)
        .to_ascii_lowercase();
    stem.trim_end_matches(|c: char| c.is_ascii_digit() || c == '_' || c == '-' || c == ' ')
        .to_string()
}

fn is_holiday_cluster(items: &[ClusterItem]) -> bool {
    items
        .iter()
        .any(|x| x.capture_at.month() == 12 && x.capture_at.day() >= 20 && x.capture_at.day() <= 31)
}

fn cluster_by_days(sorted_items: Vec<ClusterItem>, max_gap_days: i64) -> Vec<Vec<ClusterItem>> {
    if sorted_items.is_empty() {
        return vec![];
    }
    let mut clusters: Vec<Vec<ClusterItem>> = vec![];
    let mut current: Vec<ClusterItem> = vec![sorted_items[0].clone()];
    for item in sorted_items.iter().skip(1) {
        let prev = current.last().expect("cluster not empty");
        let gap = (item.capture_at.date() - prev.capture_at.date()).num_days();
        if gap <= max_gap_days {
            current.push(item.clone());
        } else {
            clusters.push(current);
            current = vec![item.clone()];
        }
    }
    clusters.push(current);
    clusters
}

fn split_long_span_clusters(clusters: Vec<Vec<ClusterItem>>, max_span_days: i64) -> Vec<Vec<ClusterItem>> {
    let mut output = Vec::new();
    for cluster in clusters {
        let span = cluster_span_days(cluster.as_slice());
        if span > max_span_days {
            let split = split_cluster_at_largest_gap(cluster.as_slice());
            if split.len() > 1 {
                output.extend(split);
                continue;
            }
        }
        output.push(cluster);
    }
    output
}

fn split_cluster_at_largest_gap(cluster: &[ClusterItem]) -> Vec<Vec<ClusterItem>> {
    if cluster.len() < 2 {
        return vec![cluster.to_vec()];
    }
    let mut largest_gap = i64::MIN;
    let mut split_index = 0_usize;
    for idx in 1..cluster.len() {
        let gap = (cluster[idx].capture_at - cluster[idx - 1].capture_at).num_seconds();
        if gap > largest_gap {
            largest_gap = gap;
            split_index = idx;
        }
    }
    if split_index == 0 || split_index >= cluster.len() {
        return vec![cluster.to_vec()];
    }
    vec![cluster[..split_index].to_vec(), cluster[split_index..].to_vec()]
}

fn cluster_span_days(cluster: &[ClusterItem]) -> i64 {
    match (cluster.first(), cluster.last()) {
        (Some(first), Some(last)) => (last.capture_at.date() - first.capture_at.date()).num_days(),
        _ => 0,
    }
}

fn parse_capture_datetime(value: &str) -> Option<NaiveDateTime> {
    let formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d",
    ];
    for format in formats {
        if format == "%Y-%m-%d" {
            if let Ok(date) = NaiveDate::parse_from_str(value, format) {
                return Some(NaiveDateTime::new(date, NaiveTime::from_hms_opt(12, 0, 0)?));
            }
        } else if let Ok(dt) = NaiveDateTime::parse_from_str(value, format) {
            return Some(dt);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        parse_capture_datetime(s).expect("valid datetime")
    }

    fn item(id: i64, ts: &str, filename: &str) -> ClusterItem {
        ClusterItem {
            id,
            capture_at: dt(ts),
            filename: filename.to_string(),
            current_path: format!(r"C:\tmp\{filename}"),
        }
    }

    #[test]
    fn sampling_filters_near_duplicates_and_distributes_evenly() {
        let cluster = vec![
            item(1, "2026-01-01 10:00:00", "IMG_001.jpg"),
            item(2, "2026-01-01 10:00:03", "IMG_002.jpg"),
            item(3, "2026-01-02 10:00:00", "IMG_100.jpg"),
            item(4, "2026-01-03 10:00:00", "IMG_101.jpg"),
            item(5, "2026-01-04 10:00:00", "IMG_200.jpg"),
            item(6, "2026-01-05 10:00:00", "IMG_201.jpg"),
            item(7, "2026-01-06 10:00:00", "IMG_300.jpg"),
        ];
        let sampled = sample_cluster_items(cluster.as_slice());
        assert!(sampled.len() >= 5);
        assert!(sampled.iter().all(|x| x.id != 2));
        assert_eq!(sampled.first().map(|x| x.id), Some(1));
        assert_eq!(sampled.last().map(|x| x.id), Some(7));
    }

    #[test]
    fn low_confidence_uses_date_based_fallback_name() {
        let start = NaiveDate::parse_from_str("2026-02-14", "%Y-%m-%d").expect("date");
        let suggestion = EventNameSuggestion {
            folder_name: "2026 - Misc".to_string(),
            confidence: "low".to_string(),
            reasoning: "Ambiguous".to_string(),
            event_type: Some("misc".to_string()),
            location_used: None,
            needs_fallback: true,
            schema_version: Some("1".to_string()),
            model_used: None,
            prompt_version: Some(EVENT_NAMING_PROMPT_VERSION.to_string()),
            fallback_used: false,
            fallback_model: None,
        };
        let db_path = {
            let mut p = std::env::temp_dir();
            p.push(format!("memoria-event-fallback-{}.db", rand::random::<u64>()));
            p
        };
        let conn = crate::db::init_db(db_path.as_path()).expect("db init");
        let result = apply_low_confidence_fallback_if_needed(&conn, 2026, start, &suggestion).expect("fallback");
        assert_eq!(result, "2026 - February Memories");
    }

    #[test]
    fn cluster_span_over_14_days_splits_at_largest_gap() {
        let clusters = split_long_span_clusters(
            vec![vec![
                item(1, "2026-01-01 10:00:00", "a.jpg"),
                item(2, "2026-01-02 10:00:00", "b.jpg"),
                item(3, "2026-01-03 10:00:00", "c.jpg"),
                item(4, "2026-01-20 10:00:00", "d.jpg"),
                item(5, "2026-01-21 10:00:00", "e.jpg"),
            ]],
            14,
        );
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0].len(), 3);
        assert_eq!(clusters[1].len(), 2);
    }

    #[test]
    fn location_hint_parses_when_present_or_absent() {
        let nominatim_city = serde_json::json!({
            "address": {"city":"Portland","country":"United States"}
        });
        assert_eq!(
            extract_city_country(&nominatim_city),
            Some(("Portland".to_string(), "United States".to_string()))
        );

        let nominatim_town = serde_json::json!({
            "address": {"town":"Bend","country":"United States"}
        });
        assert_eq!(
            extract_city_country(&nominatim_town),
            Some(("Bend".to_string(), "United States".to_string()))
        );

        let nominatim_village = serde_json::json!({
            "address": {"village":"Cannon Beach","country":"United States"}
        });
        assert_eq!(
            extract_city_country(&nominatim_village),
            Some(("Cannon Beach".to_string(), "United States".to_string()))
        );

        let none = serde_json::json!({});
        assert_eq!(extract_city_country(&none), None);
    }

    #[test]
    fn nominatim_request_uses_correct_url_and_query() {
        let client = Client::new();
        let req = build_nominatim_reverse_request(&client, 45.5231, -122.6765).expect("request");
        assert_eq!(req.url().scheme(), "https");
        assert_eq!(req.url().host_str(), Some("nominatim.openstreetmap.org"));
        assert_eq!(req.url().path(), "/reverse");
        let query = req.url().query().unwrap_or_default();
        assert!(query.contains("lat=45.5231"));
        assert!(query.contains("lon=-122.6765"));
        assert!(query.contains("format=json"));
    }

    #[test]
    fn nominatim_request_contains_user_agent_header() {
        let client = Client::new();
        let req = build_nominatim_reverse_request(&client, 45.52, -122.67).expect("request");
        let ua = req
            .headers()
            .get("User-Agent")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert_eq!(ua, NOMINATIM_USER_AGENT);
    }

    #[tokio::test]
    async fn geocoding_failure_is_non_fatal_for_location_hint_resolution() {
        let hint = location_hint_from_geocode_result(
            45.52,
            -122.67,
            Err(anyhow::anyhow!("mocked geocoder failure")),
        );
        assert!(hint.is_none());
    }

    #[test]
    fn cache_key_rounds_to_two_decimals() {
        let k1 = geocode_cache_key(45.5231, -122.6765);
        let k2 = geocode_cache_key(45.5249, -122.6789);
        assert_eq!(k1, k2);
    }

    #[tokio::test]
    async fn rounded_coordinate_cache_hits_without_second_transport_call() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let mut geocoder = ReverseGeocoder::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        let first = geocoder
            .reverse_geocode_with_transport(45.5231, -122.6765, move |_lat, _lon| async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(("Portland".to_string(), "United States".to_string())))
            })
            .await
            .expect("first geocode");
        let second_calls = Arc::clone(&calls);
        let second = geocoder
            .reverse_geocode_with_transport(45.5249, -122.6789, move |_lat, _lon| async move {
                second_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(("Portland".to_string(), "United States".to_string())))
            })
            .await
            .expect("second geocode");
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rate_limiter_delays_second_uncached_request() {
        let mut geocoder = ReverseGeocoder {
            cache: HashMap::new(),
            last_request_at: None,
            min_interval: Duration::from_millis(200),
        };
        let _ = geocoder
            .reverse_geocode_with_transport(45.10, -122.10, |_lat, _lon| async {
                Ok(Some(("A".to_string(), "B".to_string())))
            })
            .await
            .expect("first");
        let started = Instant::now();
        let _ = geocoder
            .reverse_geocode_with_transport(46.10, -123.10, |_lat, _lon| async {
                Ok(Some(("A".to_string(), "B".to_string())))
            })
            .await
            .expect("second");
        assert!(started.elapsed() >= Duration::from_millis(180));
    }

    #[test]
    fn clusters_split_when_gap_exceeds_threshold() {
        let items = vec![
            item(1, "2025-07-01", "a.jpg"),
            item(2, "2025-07-02", "b.jpg"),
            item(3, "2025-07-10", "c.jpg"),
        ];
        let clusters = cluster_by_days(items, 2);
        assert_eq!(clusters.len(), 2);
    }

    #[test]
    fn folder_name_collision_appends_numeric_suffix() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-group-collision-{}.db", rand::random::<u64>()));
        let conn = crate::db::init_db(&db_path).expect("db");
        conn.execute(
            "INSERT INTO event_groups(year, name, folder_name, user_approved, item_count)
             VALUES(2026, 'Birthday Party', '2026 - Birthday Party', 0, 3)",
            [],
        )
        .expect("seed existing");
        let resolved = resolve_folder_name_collision(&conn, 2026, "2026 - Birthday Party").expect("resolve");
        assert_eq!(resolved, "2026 - Birthday Party 2");
    }

    #[test]
    fn holiday_cluster_detects_christmas_window() {
        let cluster = vec![
            item(1, "2025-12-24 09:00:00", "x.jpg"),
            item(2, "2025-12-26 09:00:00", "y.jpg"),
        ];
        assert!(is_holiday_cluster(&cluster));
    }

    #[tokio::test]
    async fn excluded_items_are_not_included_in_grouping_query() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-group-excluded-{}.db", rand::random::<u64>()));
        let conn = crate::db::init_db(&db_path).expect("db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_taken, date_needs_review, mime_type)
             VALUES('a1', 'active.jpg', 'C:\\tmp\\active.jpg', 'date_verified', '2026-01-01', 0, 'image/jpeg')",
            [],
        )
        .expect("active");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_taken, date_needs_review, mime_type)
             VALUES('e1', 'excluded.mov', 'C:\\tmp\\excluded.mov', 'excluded', '2026-01-01', 0, 'video/quicktime')",
            [],
        )
        .expect("excluded");
        let ai = crate::services::ai_client::AiClient::new(None, None, crate::services::ai_client::AiRoutingConfig::default());
        run(&conn, &ai).await.expect("run");
        let grouped_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items WHERE status='grouped'", [], |r| r.get(0))
            .expect("grouped count");
        let excluded_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items WHERE status='excluded'", [], |r| r.get(0))
            .expect("excluded count");
        assert_eq!(grouped_count, 1);
        assert_eq!(excluded_count, 1);
    }
}

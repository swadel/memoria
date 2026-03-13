use anyhow::Result;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use reqwest::Client;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::path::Path;

use super::{
    ai_client::{AiClient, EventNameSuggestion, EventNamingRequest},
    exiftool, runtime_log,
};

const CLUSTER_GAP_DAYS: i64 = 2;
const CLUSTER_SPAN_SPLIT_DAYS: i64 = 14;

#[derive(Debug, Clone)]
struct ClusterItem {
    id: i64,
    capture_at: NaiveDateTime,
    filename: String,
    current_path: String,
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
            let naming = name_cluster(year, &cluster, ai, &http).await?;
            let lowered = naming.folder_name.to_ascii_lowercase();
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
            let simple_name = final_folder_name
                .strip_prefix(&format!("{year} - "))
                .unwrap_or(final_folder_name.as_str())
                .to_string();

            conn.execute(
                "INSERT INTO event_groups(year, name, folder_name, ai_suggested_name, is_misc, user_approved, item_count, start_date, end_date)
                 VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)",
                params![
                    year,
                    simple_name,
                    final_folder_name,
                    format!("{year} - {}", naming.folder_name),
                    if naming.folder_name.eq_ignore_ascii_case("Misc") { 1 } else { 0 },
                    cluster.len() as i64,
                    start_date.to_string(),
                    end_date.to_string()
                ],
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
) -> Result<EventNameSuggestion> {
    if cluster.len() < 3 {
        return Ok(EventNameSuggestion {
            folder_name: "Misc".to_string(),
            confidence: "medium".to_string(),
            reasoning: "Small cluster default.".to_string(),
        });
    }
    if is_holiday_cluster(cluster) {
        return Ok(EventNameSuggestion {
            folder_name: "Family Christmas".to_string(),
            confidence: "high".to_string(),
            reasoning: "Date window matches holiday period.".to_string(),
        });
    }

    let sampled = sample_cluster_items(cluster);
    let start_date = cluster.first().map(|x| x.capture_at.date()).expect("cluster item");
    let end_date = cluster.last().map(|x| x.capture_at.date()).expect("cluster item");
    let day_count = (end_date - start_date).num_days() + 1;
    let location_hint = find_location_hint(cluster, http).await?;
    let request = EventNamingRequest {
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        day_count,
        total_count: cluster.len(),
        has_location_data: location_hint.is_some(),
        location_hint,
        sample_image_paths: sampled.into_iter().map(|x| x.current_path).collect(),
    };
    let mut suggestion = ai.suggest_event_name_for_cluster(&request).await?;
    if suggestion.folder_name.trim().is_empty() {
        suggestion.folder_name = format!("{year} - Misc");
    }
    Ok(suggestion)
}

fn apply_low_confidence_fallback_if_needed(
    conn: &Connection,
    year: i32,
    start_date: NaiveDate,
    naming: &EventNameSuggestion,
) -> Result<String> {
    if !naming.confidence.eq_ignore_ascii_case("low") {
        return Ok(format!("{year} - {}", naming.folder_name.trim()));
    }
    let fallback = format!("{year} - {} Memories", start_date.format("%B"));
    conn.execute(
        "INSERT INTO audit_log(media_item_id, action, old_value, new_value, source, details)
         VALUES(NULL, 'event_name_low_confidence', ?1, ?2, 'ai_event_naming', ?3)",
        params![naming.folder_name, fallback, naming.reasoning],
    )?;
    Ok(fallback)
}

async fn find_location_hint(cluster: &[ClusterItem], http: &Client) -> Result<Option<String>> {
    for item in cluster {
        let path = Path::new(item.current_path.as_str());
        if let Some((lat, lon)) = exiftool::read_gps_coordinates(path).await? {
            if let Some((city, country)) = reverse_geocode_open_meteo(http, lat, lon).await? {
                return Ok(Some(format!(
                    "GPS data suggests these photos were taken in: {city}, {country}"
                )));
            }
        }
    }
    Ok(None)
}

async fn reverse_geocode_open_meteo(
    http: &Client,
    latitude: f64,
    longitude: f64,
) -> Result<Option<(String, String)>> {
    let value = http
        .get("https://geocoding-api.open-meteo.com/v1/reverse")
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("count", "1".to_string()),
            ("language", "en".to_string()),
            ("format", "json".to_string()),
        ])
        .send()
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
            folder_name: "Unclear".to_string(),
            confidence: "low".to_string(),
            reasoning: "Ambiguous".to_string(),
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
        let open_meteo = serde_json::json!({
            "results": [{"name":"Portland", "country":"United States"}]
        });
        assert_eq!(
            extract_city_country(&open_meteo),
            Some(("Portland".to_string(), "United States".to_string()))
        );

        let mocked_nominatim = serde_json::json!({
            "address": {"city":"Portland","country":"United States"}
        });
        assert_eq!(
            extract_city_country(&mocked_nominatim),
            Some(("Portland".to_string(), "United States".to_string()))
        );

        let none = serde_json::json!({});
        assert_eq!(extract_city_country(&none), None);
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

use anyhow::Result;
use chrono::NaiveDateTime;
use rand::Rng;
use rayon::prelude::*;
use rusqlite::params;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use crate::db;
use crate::services::{ai_client::AiClient, exiftool, image_analysis, runtime_log};

const IMAGE_PHASE_STATE_KEY: &str = "image_review_phase_state";

// Default thresholds (all overridable via DB settings)
const DEFAULT_BLUR_THRESHOLD: f64 = 50.0;
const DEFAULT_BLUR_BORDERLINE_PCT: f64 = 0.2;
const DEFAULT_EXPOSURE_DARK_PCT: f64 = 0.6;
const DEFAULT_EXPOSURE_BRIGHT_PCT: f64 = 0.6;
const DEFAULT_BURST_TIME_WINDOW_SECS: i64 = 3;
const DEFAULT_BURST_HASH_DISTANCE: u32 = 10;
const DEFAULT_DUPLICATE_HASH_DISTANCE: u32 = 5;
const DEFAULT_SMALL_FILE_LIMIT_BYTES: i64 = 500 * 1024;
const DEFAULT_SCREENSHOT_HEURISTIC_THRESHOLD: f64 = 0.6;

#[derive(Debug, Clone)]
pub struct ReviewSettings {
    pub blur_threshold: f64,
    pub blur_borderline_pct: f64,
    pub exposure_dark_pct: f64,
    pub exposure_bright_pct: f64,
    pub burst_time_window_secs: i64,
    pub burst_hash_distance: u32,
    pub duplicate_hash_distance: u32,
    pub small_file_limit_bytes: i64,
    pub screenshot_heuristic_threshold: f64,
}

impl ReviewSettings {
    pub fn from_db(conn: &rusqlite::Connection) -> Self {
        Self {
            blur_threshold: read_f64(conn, "image_blur_threshold", DEFAULT_BLUR_THRESHOLD),
            blur_borderline_pct: read_f64(conn, "image_blur_borderline_pct", DEFAULT_BLUR_BORDERLINE_PCT),
            exposure_dark_pct: read_f64(conn, "image_exposure_dark_pct", DEFAULT_EXPOSURE_DARK_PCT),
            exposure_bright_pct: read_f64(conn, "image_exposure_bright_pct", DEFAULT_EXPOSURE_BRIGHT_PCT),
            burst_time_window_secs: read_i64(conn, "burst_time_window_secs", DEFAULT_BURST_TIME_WINDOW_SECS),
            burst_hash_distance: read_i64(conn, "burst_hash_distance", DEFAULT_BURST_HASH_DISTANCE as i64) as u32,
            duplicate_hash_distance: read_i64(conn, "duplicate_hash_distance", DEFAULT_DUPLICATE_HASH_DISTANCE as i64) as u32,
            small_file_limit_bytes: read_i64(conn, "small_file_min_bytes", DEFAULT_SMALL_FILE_LIMIT_BYTES),
            screenshot_heuristic_threshold: read_f64(conn, "screenshot_heuristic_threshold", DEFAULT_SCREENSHOT_HEURISTIC_THRESHOLD),
        }
    }

    pub fn defaults() -> Self {
        Self {
            blur_threshold: DEFAULT_BLUR_THRESHOLD,
            blur_borderline_pct: DEFAULT_BLUR_BORDERLINE_PCT,
            exposure_dark_pct: DEFAULT_EXPOSURE_DARK_PCT,
            exposure_bright_pct: DEFAULT_EXPOSURE_BRIGHT_PCT,
            burst_time_window_secs: DEFAULT_BURST_TIME_WINDOW_SECS,
            burst_hash_distance: DEFAULT_BURST_HASH_DISTANCE,
            duplicate_hash_distance: DEFAULT_DUPLICATE_HASH_DISTANCE,
            small_file_limit_bytes: DEFAULT_SMALL_FILE_LIMIT_BYTES,
            screenshot_heuristic_threshold: DEFAULT_SCREENSHOT_HEURISTIC_THRESHOLD,
        }
    }
}

#[derive(Debug, Clone)]
struct ImageCandidate {
    id: i64,
    file_size: i64,
    date_taken: Option<NaiveDateTime>,
    current_path: String,
}

#[derive(Debug, Clone)]
struct AnalysisResult {
    id: i64,
    blur_score: f64,
    phash: u64,
    exposure: image_analysis::ExposureStats,
    screenshot: image_analysis::ScreenshotSignals,
}

#[derive(Debug, Clone)]
struct AnalyzedImage {
    id: i64,
    file_size: i64,
    date_taken: Option<NaiveDateTime>,
    blur_score: f64,
    phash: u64,
    exposure: image_analysis::ExposureStats,
    screenshot: image_analysis::ScreenshotSignals,
}

pub async fn run_image_review_scan(
    conn: &rusqlite::Connection,
    app_handle: Option<&tauri::AppHandle>,
    ai_client: Option<&AiClient>,
) -> Result<()> {
    let settings = ReviewSettings::from_db(conn);

    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(file_size, 0), date_taken, COALESCE(current_path, '')
         FROM media_items
         WHERE mime_type LIKE 'image/%' AND status='indexed' AND status != 'excluded'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ImageCandidate {
            id: r.get(0)?,
            file_size: r.get(1)?,
            date_taken: r.get::<_, Option<String>>(2)?
                .as_deref()
                .and_then(parse_capture_datetime),
            current_path: r.get(3)?,
        })
    })?;

    let candidates: Vec<ImageCandidate> = rows.filter_map(|r| r.ok()).collect();
    let total = candidates.len();

    if total == 0 {
        db::set_setting(conn, IMAGE_PHASE_STATE_KEY, "complete")?;
        return Ok(());
    }

    // Phase 1: Parallel local analysis via rayon
    runtime_log::emit_pipeline_progress(app_handle, "image_review", "Starting image analysis...", 0, total);
    let progress_counter = AtomicUsize::new(0);
    let app_handle_clone = app_handle.cloned();

    let analysis_results: Vec<AnalysisResult> = candidates
        .par_iter()
        .map(|c| {
            let blur_score = image_analysis::compute_blur_score(std::path::Path::new(&c.current_path))
                .unwrap_or(0.0);
            let phash = image_analysis::compute_perceptual_hash(std::path::Path::new(&c.current_path))
                .unwrap_or(0);
            let exposure = image_analysis::compute_exposure_stats(std::path::Path::new(&c.current_path))
                .unwrap_or_default();
            let camera_meta = exiftool::read_camera_metadata_sync(std::path::Path::new(&c.current_path));
            let screenshot = image_analysis::compute_screenshot_heuristic(
                std::path::Path::new(&c.current_path),
                camera_meta.as_ref(),
            );

            let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if done % 50 == 0 || done == total {
                runtime_log::emit_pipeline_progress(
                    app_handle_clone.as_ref(),
                    "image_review",
                    &format!("Analyzing image {done}/{total}"),
                    done,
                    total,
                );
            }

            AnalysisResult {
                id: c.id,
                blur_score,
                phash,
                exposure,
                screenshot,
            }
        })
        .collect();

    // Merge candidates with analysis results
    let analysis_map: HashMap<i64, AnalysisResult> = analysis_results
        .into_iter()
        .map(|a| (a.id, a))
        .collect();

    let analyzed: Vec<AnalyzedImage> = candidates
        .iter()
        .filter_map(|c| {
            analysis_map.get(&c.id).map(|a| AnalyzedImage {
                id: c.id,
                file_size: c.file_size,
                date_taken: c.date_taken,
                blur_score: a.blur_score,
                phash: a.phash,
                exposure: a.exposure.clone(),
                screenshot: a.screenshot.clone(),
            })
        })
        .collect();

    // Phase 2: Deterministic grouping
    runtime_log::emit_pipeline_progress(app_handle, "image_review", "Grouping bursts and duplicates...", 0, 0);

    let mut burst_map = detect_burst_groups(&analyzed, &settings);
    let duplicate_map = detect_duplicate_groups(&analyzed, &burst_map, &settings);

    // Phase 2.5: AI fallback (optional, only when AI client is available)
    let mut ai_blur_overrides: HashMap<i64, bool> = HashMap::new();
    let mut ai_screenshot_flags: HashMap<i64, bool> = HashMap::new();
    let mut ai_quality_scores: HashMap<i64, (f64, String)> = HashMap::new();

    if let Some(ai) = ai_client {
        // AI borderline blur assessment
        let borderline_low = settings.blur_threshold * (1.0 - settings.blur_borderline_pct);
        let borderline_high = settings.blur_threshold * (1.0 + settings.blur_borderline_pct);
        let borderline_items: Vec<(i64, String)> = analyzed
            .iter()
            .filter(|img| img.blur_score >= borderline_low && img.blur_score <= borderline_high)
            .filter_map(|img| {
                candidates.iter().find(|c| c.id == img.id)
                    .map(|c| (img.id, c.current_path.clone()))
            })
            .collect();

        if !borderline_items.is_empty() {
            let bl_total = borderline_items.len();
            runtime_log::emit_pipeline_progress(app_handle, "image_review", "AI quality assessment...", 0, bl_total);
            for (i, (id, path)) in borderline_items.iter().enumerate() {
                if let Ok(assessment) = ai.assess_image_quality(path).await {
                    ai_blur_overrides.insert(*id, assessment.is_blurry);
                    ai_quality_scores.insert(*id, (assessment.quality_score, assessment.reasoning));
                }
                runtime_log::emit_pipeline_progress(app_handle, "image_review", &format!("AI quality check {}/{bl_total}", i + 1), i + 1, bl_total);
            }
        }

        // AI screenshot/meme classification for high-heuristic candidates
        let screenshot_candidates: Vec<(i64, String)> = analyzed
            .iter()
            .filter(|img| img.screenshot.confidence >= settings.screenshot_heuristic_threshold)
            .map(|img| {
                let path = candidates.iter().find(|c| c.id == img.id)
                    .map(|c| c.current_path.clone())
                    .unwrap_or_default();
                (img.id, path)
            })
            .collect();

        if !screenshot_candidates.is_empty() {
            let paths: Vec<String> = screenshot_candidates.iter().map(|(_, p)| p.clone()).collect();
            if let Ok(classifications) = ai.classify_image_content(&paths).await {
                for cls in classifications {
                    if cls.image_index < screenshot_candidates.len() {
                        let id = screenshot_candidates[cls.image_index].0;
                        let is_non_photo = matches!(
                            cls.classification.as_str(),
                            "screenshot" | "meme" | "graphic" | "document"
                        ) && matches!(cls.confidence.as_str(), "high" | "medium");
                        ai_screenshot_flags.insert(id, is_non_photo);
                    }
                }
            }
        }

        // AI best-shot selection for burst groups
        let mut burst_group_members: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for (id, info) in &burst_map {
            let path = candidates.iter().find(|c| c.id == *id)
                .map(|c| c.current_path.clone())
                .unwrap_or_default();
            burst_group_members.entry(info.group_id.clone()).or_default().push((*id, path));
        }
        for (_group_id, members) in &burst_group_members {
            if members.len() < 2 {
                continue;
            }
            let paths: Vec<String> = members.iter().map(|(_, p)| p.clone()).collect();
            if let Ok(result) = ai.select_burst_best_shot(&paths).await {
                if result.best_index < members.len() {
                    let best_id = members[result.best_index].0;
                    for (id, _) in members {
                        if let Some(info) = burst_map.get_mut(id) {
                            info.primary_id = best_id;
                        }
                    }
                }
            }
        }
    }

    // Audit log AI decisions
    for (id, (score, reasoning)) in &ai_quality_scores {
        let _ = conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, details)
             VALUES(?1, 'ai_image_quality_assessment', 'image_review', ?2)",
            params![
                id,
                serde_json::json!({
                    "quality_score": score,
                    "reasoning": reasoning,
                })
                .to_string()
            ],
        );
    }
    for (id, is_non_photo) in &ai_screenshot_flags {
        let _ = conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, details)
             VALUES(?1, 'ai_content_classification', 'image_review', ?2)",
            params![
                id,
                serde_json::json!({ "is_non_photo": is_non_photo }).to_string()
            ],
        );
    }

    // Phase 3: Flag assignment and DB update
    for img in &analyzed {
        let mut flags: Vec<&str> = Vec::new();

        if img.file_size < settings.small_file_limit_bytes {
            flags.push("small_file");
        }
        // Blur: use AI override if available, otherwise local score
        if let Some(&ai_is_blurry) = ai_blur_overrides.get(&img.id) {
            if ai_is_blurry {
                flags.push("blurry");
            }
        } else if img.blur_score < settings.blur_threshold {
            flags.push("blurry");
        }

        if img.exposure.dark_pixel_pct > settings.exposure_dark_pct {
            flags.push("poor_exposure");
        } else if img.exposure.bright_pixel_pct > settings.exposure_bright_pct {
            flags.push("poor_exposure");
        }

        // Screenshot: use AI classification if available, otherwise local heuristic with high threshold
        if let Some(&is_non_photo) = ai_screenshot_flags.get(&img.id) {
            if is_non_photo {
                flags.push("screenshot_or_meme");
            }
        } else if img.screenshot.confidence >= 0.8 {
            // Offline fallback: only trust local heuristic at high confidence
            flags.push("screenshot_or_meme");
        }

        let mut burst_group_id: Option<String> = None;
        let mut is_burst_primary = false;
        if let Some(info) = burst_map.get(&img.id) {
            burst_group_id = Some(info.group_id.clone());
            is_burst_primary = info.primary_id == img.id;
            if !is_burst_primary {
                flags.push("burst_shot");
            }
        }

        let mut dup_group_id: Option<String> = None;
        if let Some(dgid) = duplicate_map.get(&img.id) {
            dup_group_id = Some(dgid.clone());
            if !flags.contains(&"duplicate") {
                flags.push("duplicate");
            }
        }

        let flags_json = serde_json::to_string(&flags)?;
        let next_status = if flags.is_empty() { "image_reviewed" } else { "indexed" };
        let phash_str = format!("{:016x}", img.phash);

        let (ai_q_score, ai_q_reasoning): (Option<f64>, Option<String>) =
            ai_quality_scores.get(&img.id).map(|(s, r)| (Some(*s), Some(r.clone()))).unwrap_or((None, None));
        let ai_content_cls: Option<String> = ai_screenshot_flags.get(&img.id).and_then(|&is_non_photo| {
            if is_non_photo { Some("screenshot_or_meme".to_string()) } else { Some("photo".to_string()) }
        });

        conn.execute(
            "UPDATE media_items
             SET sharpness_score=?1, blur_score=?2, perceptual_hash=?3,
                 burst_group_id=?4, is_burst_primary=?5, duplicate_group_id=?6,
                 exposure_mean=?7, exposure_std=?8, screenshot_heuristic=?9,
                 ai_quality_score=?10, ai_quality_reasoning=?11, ai_content_class=?12,
                 image_flags=?13, status=?14, updated_at=CURRENT_TIMESTAMP
             WHERE id=?15",
            params![
                img.blur_score,
                img.blur_score,
                phash_str,
                burst_group_id,
                if is_burst_primary { 1 } else { 0 },
                dup_group_id,
                img.exposure.mean_brightness,
                img.exposure.std_deviation,
                img.screenshot.confidence,
                ai_q_score,
                ai_q_reasoning,
                ai_content_cls,
                flags_json,
                next_status,
                img.id
            ],
        )?;
    }

    runtime_log::emit_pipeline_progress(app_handle, "image_review", "Image review complete", total, total);

    let remaining_flagged: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items
         WHERE mime_type LIKE 'image/%' AND status='indexed'
           AND COALESCE(image_flags, '') != '' AND COALESCE(image_flags, '[]') != '[]'",
        [],
        |r| r.get(0),
    )?;
    db::set_setting(
        conn,
        IMAGE_PHASE_STATE_KEY,
        if remaining_flagged > 0 { "in_progress" } else { "complete" },
    )?;
    Ok(())
}

pub fn complete_image_review(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute(
        "UPDATE media_items
         SET status='image_reviewed', updated_at=CURRENT_TIMESTAMP
         WHERE status='indexed' AND status != 'excluded'",
        [],
    )?;
    db::set_setting(conn, IMAGE_PHASE_STATE_KEY, "complete")?;
    Ok(())
}

pub fn image_phase_state(conn: &rusqlite::Connection) -> Result<String> {
    Ok(db::get_setting(conn, IMAGE_PHASE_STATE_KEY)?.unwrap_or_else(|| "pending".to_string()))
}

pub fn keep_best_only(
    conn: &mut rusqlite::Connection,
    burst_group_id: &str,
    root_output: &std::path::Path,
) -> Result<usize> {
    let ids = {
        let mut stmt = conn.prepare(
            "SELECT id FROM media_items
             WHERE burst_group_id=?1 AND COALESCE(is_burst_primary, 0)=0 AND status='indexed'",
        )?;
        let out = stmt
            .query_map([burst_group_id], |r| r.get::<_, i64>(0))?
            .filter_map(|id| id.ok())
            .collect::<Vec<_>>();
        out
    };
    crate::services::video_review::exclude_media_items(conn, root_output, &ids, &["indexed"])?;
    Ok(ids.len())
}

pub fn keep_all_burst(conn: &rusqlite::Connection, burst_group_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE media_items
         SET status='image_reviewed', image_flags='[]', updated_at=CURRENT_TIMESTAMP
         WHERE burst_group_id=?1 AND status='indexed'",
        [burst_group_id],
    )?;
    Ok(())
}

// --- Burst detection: phash-based with fixed sliding window ---

#[derive(Clone, Debug)]
struct BurstInfo {
    group_id: String,
    primary_id: i64,
}

fn detect_burst_groups(
    items: &[AnalyzedImage],
    settings: &ReviewSettings,
) -> HashMap<i64, BurstInfo> {
    let mut sorted: Vec<&AnalyzedImage> = items.iter().collect();
    sorted.sort_by_key(|i| i.date_taken);

    let mut out = HashMap::new();
    let mut idx = 0usize;

    while idx < sorted.len() {
        let Some(base_dt) = sorted[idx].date_taken else {
            idx += 1;
            continue;
        };

        let mut group = vec![sorted[idx]];
        let mut prev_dt = base_dt;
        let mut j = idx + 1;

        while j < sorted.len() {
            let Some(next_dt) = sorted[j].date_taken else {
                break;
            };
            // Compare to PREVIOUS member, not the base (fixes sliding window bug)
            let dt_diff = (next_dt - prev_dt).num_seconds().abs();
            if dt_diff > settings.burst_time_window_secs {
                break;
            }
            let hash_dist = image_analysis::hamming_distance(
                group.last().unwrap().phash,
                sorted[j].phash,
            );
            if hash_dist <= settings.burst_hash_distance {
                group.push(sorted[j]);
                prev_dt = next_dt;
            }
            j += 1;
        }

        if group.len() >= 2 {
            let mut rng = rand::thread_rng();
            let group_id = format!("burst-{:016x}", rng.gen::<u64>());
            let primary = group
                .iter()
                .max_by(|a, b| {
                    a.blur_score
                        .partial_cmp(&b.blur_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|v| v.id)
                .unwrap_or(group[0].id);

            for member in &group {
                out.insert(
                    member.id,
                    BurstInfo {
                        group_id: group_id.clone(),
                        primary_id: primary,
                    },
                );
            }
            idx = j;
            continue;
        }
        idx += 1;
    }
    out
}

// --- Duplicate detection: bucket-based using 16-bit hash prefix ---

fn detect_duplicate_groups(
    items: &[AnalyzedImage],
    burst_map: &HashMap<i64, BurstInfo>,
    settings: &ReviewSettings,
) -> HashMap<i64, String> {
    let mut buckets: HashMap<u16, Vec<(i64, u64)>> = HashMap::new();
    for img in items {
        let prefix = (img.phash >> 48) as u16;
        buckets.entry(prefix).or_default().push((img.id, img.phash));
    }

    let mut dup_groups: HashMap<i64, String> = HashMap::new();
    let mut union_find: HashMap<i64, i64> = HashMap::new();

    for bucket in buckets.values() {
        for i in 0..bucket.len() {
            for j in (i + 1)..bucket.len() {
                let (id_a, hash_a) = bucket[i];
                let (id_b, hash_b) = bucket[j];
                let dist = image_analysis::hamming_distance(hash_a, hash_b);
                if dist > settings.duplicate_hash_distance {
                    continue;
                }
                // Skip if both belong to the same burst group
                if let (Some(ba), Some(bb)) = (burst_map.get(&id_a), burst_map.get(&id_b)) {
                    if ba.group_id == bb.group_id {
                        continue;
                    }
                }
                union_ids(&mut union_find, id_a, id_b);
            }
        }
    }

    // Assign group IDs from union-find roots
    let mut root_to_group: HashMap<i64, String> = HashMap::new();
    for &id in union_find.keys() {
        let root = find_root(&union_find, id);
        let group_id = root_to_group
            .entry(root)
            .or_insert_with(|| {
                let mut rng = rand::thread_rng();
                format!("dup-{:016x}", rng.gen::<u64>())
            })
            .clone();
        dup_groups.insert(id, group_id);
    }

    dup_groups
}

fn find_root(uf: &HashMap<i64, i64>, mut id: i64) -> i64 {
    while let Some(&parent) = uf.get(&id) {
        if parent == id {
            break;
        }
        id = parent;
    }
    id
}

fn union_ids(uf: &mut HashMap<i64, i64>, a: i64, b: i64) {
    let ra = find_root(uf, a);
    let rb = find_root(uf, b);
    uf.entry(a).or_insert(a);
    uf.entry(b).or_insert(b);
    if ra != rb {
        uf.insert(rb, ra);
    }
}

// --- Progress reporting (delegates to runtime_log::emit_pipeline_progress) ---

// --- Helpers ---

fn parse_capture_datetime(value: &str) -> Option<NaiveDateTime> {
    ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"]
        .iter()
        .find_map(|fmt| NaiveDateTime::parse_from_str(value, fmt).ok())
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(12, 0, 0))
        })
}

fn read_f64(conn: &rusqlite::Connection, key: &str, default: f64) -> f64 {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

fn read_i64(conn: &rusqlite::Connection, key: &str, default: i64) -> i64 {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "memoria-image-review-test-{}.db",
            rand::random::<u64>()
        ));
        p
    }

    #[test]
    fn review_settings_loads_defaults() {
        let db = temp_db_path();
        let conn = init_db(&db).expect("db");
        let settings = ReviewSettings::from_db(&conn);
        assert!((settings.blur_threshold - 50.0).abs() < f64::EPSILON);
        assert_eq!(settings.burst_time_window_secs, 3);
        assert_eq!(settings.burst_hash_distance, 10);
        assert_eq!(settings.duplicate_hash_distance, 5);
    }

    #[test]
    fn review_settings_reads_from_db() {
        let db = temp_db_path();
        let conn = init_db(&db).expect("db");
        db::set_setting(&conn, "image_blur_threshold", "75.5").unwrap();
        db::set_setting(&conn, "burst_time_window_secs", "5").unwrap();
        let settings = ReviewSettings::from_db(&conn);
        assert!((settings.blur_threshold - 75.5).abs() < f64::EPSILON);
        assert_eq!(settings.burst_time_window_secs, 5);
    }

    #[test]
    fn burst_detection_with_matching_hashes() {
        let settings = ReviewSettings::defaults();
        let dt = NaiveDateTime::parse_from_str("2026-01-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let items = vec![
            AnalyzedImage {
                id: 1, file_size: 1_000_000, date_taken: Some(dt),
                blur_score: 100.0, phash: 0xFF00FF00FF00FF00,
                exposure: Default::default(), screenshot: Default::default(),
            },
            AnalyzedImage {
                id: 2, file_size: 1_050_000,
                date_taken: Some(dt + chrono::Duration::seconds(2)),
                blur_score: 120.0, phash: 0xFF00FF00FF00FF01, // 1-bit difference
                exposure: Default::default(), screenshot: Default::default(),
            },
        ];
        let burst = detect_burst_groups(&items, &settings);
        assert_eq!(burst.len(), 2);
        assert_eq!(burst[&1].group_id, burst[&2].group_id);
        assert_eq!(burst[&1].primary_id, 2); // higher blur_score
    }

    #[test]
    fn burst_detection_rejects_different_hashes() {
        let settings = ReviewSettings::defaults();
        let dt = NaiveDateTime::parse_from_str("2026-01-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        let items = vec![
            AnalyzedImage {
                id: 1, file_size: 1_000_000, date_taken: Some(dt),
                blur_score: 100.0, phash: 0x0000000000000000,
                exposure: Default::default(), screenshot: Default::default(),
            },
            AnalyzedImage {
                id: 2, file_size: 1_050_000,
                date_taken: Some(dt + chrono::Duration::seconds(2)),
                blur_score: 120.0, phash: 0xFFFFFFFFFFFFFFFF, // 64-bit difference
                exposure: Default::default(), screenshot: Default::default(),
            },
        ];
        let burst = detect_burst_groups(&items, &settings);
        assert!(burst.is_empty());
    }

    #[test]
    fn burst_sliding_window_chains_beyond_base() {
        let settings = ReviewSettings::defaults();
        let dt = NaiveDateTime::parse_from_str("2026-01-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        // 5 images, each 2 seconds apart (total span 8 seconds)
        // With the fixed sliding window (comparing to previous), all should chain
        let items: Vec<AnalyzedImage> = (0..5)
            .map(|i| AnalyzedImage {
                id: i + 1,
                file_size: 1_000_000,
                date_taken: Some(dt + chrono::Duration::seconds(i * 2)),
                blur_score: 100.0 + i as f64,
                phash: 0xFF00FF00FF00FF00 + i as u64, // small differences
                exposure: Default::default(),
                screenshot: Default::default(),
            })
            .collect();
        let burst = detect_burst_groups(&items, &settings);
        assert_eq!(burst.len(), 5, "all 5 should be in one burst group");
    }

    #[test]
    fn duplicate_detection_groups_identical_hashes() {
        let settings = ReviewSettings::defaults();
        let items = vec![
            AnalyzedImage {
                id: 1, file_size: 1_000_000,
                date_taken: Some(NaiveDateTime::parse_from_str("2026-01-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap()),
                blur_score: 100.0, phash: 0xAABBCCDDEEFF0011,
                exposure: Default::default(), screenshot: Default::default(),
            },
            AnalyzedImage {
                id: 2, file_size: 1_000_000,
                date_taken: Some(NaiveDateTime::parse_from_str("2026-06-15 14:30:00", "%Y-%m-%d %H:%M:%S").unwrap()),
                blur_score: 95.0, phash: 0xAABBCCDDEEFF0011, // identical hash
                exposure: Default::default(), screenshot: Default::default(),
            },
        ];
        let burst_map = HashMap::new();
        let dups = detect_duplicate_groups(&items, &burst_map, &settings);
        assert_eq!(dups.len(), 2);
        assert_eq!(dups[&1], dups[&2]);
    }

    #[test]
    fn duplicate_detection_skips_same_burst_group() {
        let settings = ReviewSettings::defaults();
        let items = vec![
            AnalyzedImage {
                id: 1, file_size: 1_000_000,
                date_taken: Some(NaiveDateTime::parse_from_str("2026-01-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap()),
                blur_score: 100.0, phash: 0xAABBCCDDEEFF0011,
                exposure: Default::default(), screenshot: Default::default(),
            },
            AnalyzedImage {
                id: 2, file_size: 1_000_000,
                date_taken: Some(NaiveDateTime::parse_from_str("2026-01-01 10:00:01", "%Y-%m-%d %H:%M:%S").unwrap()),
                blur_score: 95.0, phash: 0xAABBCCDDEEFF0011,
                exposure: Default::default(), screenshot: Default::default(),
            },
        ];
        let mut burst_map = HashMap::new();
        let gid = "burst-test".to_string();
        burst_map.insert(1, BurstInfo { group_id: gid.clone(), primary_id: 1 });
        burst_map.insert(2, BurstInfo { group_id: gid, primary_id: 1 });
        let dups = detect_duplicate_groups(&items, &burst_map, &settings);
        assert!(dups.is_empty());
    }
}

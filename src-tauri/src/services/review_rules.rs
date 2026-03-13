use anyhow::Result;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use image::imageops::FilterType;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::ai_client::AiClient;

#[derive(Debug, Clone)]
struct Candidate {
    id: i64,
    filename: String,
    path: String,
    mime_type: String,
    width: i64,
    height: i64,
    file_size: i64,
    content_identifier: Option<String>,
    date_taken: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct ImageFingerprint {
    hash: u64,
    aspect_ratio: f64,
}

pub async fn apply(conn: &Connection, ai: &AiClient) -> Result<()> {
    mark_live_photo_videos(conn)?;
    mark_duplicate_non_winners(conn, ai).await?;
    Ok(())
}

fn mark_live_photo_videos(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), COALESCE(mime_type, ''), COALESCE(content_identifier, ''), duration_secs
         FROM media_items WHERE classification != 'deleted' OR classification IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<f64>>(5)?,
        ))
    })?;

    let mut image_by_stem: HashMap<String, i64> = HashMap::new();
    let mut images_by_content_id: HashMap<String, i64> = HashMap::new();
    let mut videos: Vec<(i64, String, String, String, Option<f64>)> = vec![];
    for row in rows {
        let (id, filename, current_path, mime_type, content_id, duration_secs) = row?;
        let ext = extension(&filename);
        let stem = normalized_stem(&filename);
        let lower_mime = mime_type.to_ascii_lowercase();
        let is_video = lower_mime.starts_with("video/") || matches!(ext.as_str(), "mov" | "mp4" | "m4v");
        if is_video {
            videos.push((id, filename, current_path, content_id, duration_secs));
            continue;
        }
        if is_image_ext(ext.as_str()) {
            image_by_stem.entry(stem).or_insert(id);
            if !content_id.trim().is_empty() {
                images_by_content_id.entry(content_id).or_insert(id);
            }
        }
    }

    for (id, filename, current_path, content_id, duration_secs) in videos {
        let stem = normalized_stem(&filename);
        let has_pair_by_stem = image_by_stem.contains_key(&stem);
        let has_pair_by_id = !content_id.trim().is_empty() && images_by_content_id.contains_key(&content_id);
        let short_clip = duration_secs.unwrap_or(99.0) <= 4.0;
        if has_pair_by_id || (has_pair_by_stem && short_clip) {
            let details = serde_json::json!({
                "reason": "live_photo_video",
                "filename": filename,
                "currentPath": current_path,
                "matchedBy": if has_pair_by_id { "content_identifier" } else { "stem_and_duration" },
                "contentIdentifier": if content_id.trim().is_empty() { serde_json::Value::Null } else { serde_json::Value::String(content_id.clone()) },
                "durationSecs": duration_secs
            })
            .to_string();
            conn.execute(
                "UPDATE media_items
                 SET classification='review', classification_source='rule', review_reason='live_photo_video',
                     review_reason_details=?1, is_live_photo_video=1, live_photo_pair_key=?2, status='classified',
                     updated_at=CURRENT_TIMESTAMP
                 WHERE id=?3",
                params![details, stem, id],
            )?;
        }
    }
    Ok(())
}

async fn mark_duplicate_non_winners(conn: &Connection, ai: &AiClient) -> Result<()> {
    conn.execute(
        "UPDATE media_items
         SET duplicate_cluster_id=NULL, duplicate_rank=NULL, duplicate_score=NULL
         WHERE review_reason IN ('duplicate_keep_suggestion', 'duplicate_non_best')",
        [],
    )?;

    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), COALESCE(mime_type, ''), COALESCE(width, 0), COALESCE(height, 0),
                COALESCE(file_size, 0), COALESCE(content_identifier, ''), date_taken
         FROM media_items
         WHERE (classification='legitimate' OR classification='review' OR classification IS NULL)
           AND (review_reason IS NULL OR review_reason != 'live_photo_video')",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Candidate {
            id: row.get(0)?,
            filename: row.get(1)?,
            path: row.get(2)?,
            mime_type: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
            file_size: row.get(6)?,
            content_identifier: row
                .get::<_, String>(7)?
                .trim()
                .to_string()
                .into(),
            date_taken: row.get(8)?,
        })
    })?;

    let mut all_candidates: Vec<Candidate> = Vec::new();
    for row in rows {
        let c = row?;
        if !c.mime_type.to_ascii_lowercase().starts_with("image/") || !is_image_ext(extension(&c.filename).as_str()) {
            continue;
        }
        all_candidates.push(c);
    }

    if all_candidates.len() < 2 {
        return Ok(());
    }

    let mut clusters: Vec<Vec<Candidate>> = Vec::new();
    let mut assigned_ids: HashSet<i64> = HashSet::new();

    // Strong match source first: content identifier.
    let mut by_content_id: HashMap<String, Vec<Candidate>> = HashMap::new();
    for c in &all_candidates {
        if let Some(cid) = c.content_identifier.as_ref().filter(|v| !v.is_empty()) {
            by_content_id.entry(cid.clone()).or_default().push(c.clone());
        }
    }
    for (_, mut cluster) in by_content_id {
        if cluster.len() < 2 {
            continue;
        }
        cluster.sort_by_key(|c| c.id);
        for c in &cluster {
            assigned_ids.insert(c.id);
        }
        clusters.push(cluster);
    }

    // For remaining candidates, require visual similarity gate.
    let remaining: Vec<Candidate> = all_candidates
        .into_iter()
        .filter(|c| !assigned_ids.contains(&c.id))
        .collect();
    if remaining.len() >= 2 {
        let mut fingerprints: HashMap<i64, Option<ImageFingerprint>> = HashMap::new();
        for c in &remaining {
            fingerprints.insert(c.id, load_fingerprint(&c.path));
        }

        let mut dsu = DisjointSet::new(remaining.len());
        for i in 0..remaining.len() {
            for j in (i + 1)..remaining.len() {
                let a = &remaining[i];
                let b = &remaining[j];
                if likely_duplicate(a, b, fingerprints.get(&a.id).and_then(|x| *x), fingerprints.get(&b.id).and_then(|x| *x)) {
                    dsu.union(i, j);
                }
            }
        }

        let mut components: HashMap<usize, Vec<Candidate>> = HashMap::new();
        for (idx, item) in remaining.iter().enumerate() {
            let root = dsu.find(idx);
            components.entry(root).or_default().push(item.clone());
        }
        for (_, mut cluster) in components {
            if cluster.len() < 2 {
                continue;
            }
            cluster.sort_by_key(|c| c.id);
            clusters.push(cluster);
        }
    }

    for mut cluster in clusters {
        annotate_cluster(conn, ai, &mut cluster).await?;
    }

    Ok(())
}

async fn annotate_cluster(conn: &Connection, ai: &AiClient, cluster: &mut [Candidate]) -> Result<()> {
    if cluster.len() < 2 {
        return Ok(());
    }
    cluster.sort_by_key(|c| c.id);

    let scores: Vec<(usize, f64)> = cluster
        .iter()
        .enumerate()
        .map(|(idx, c)| (idx, heuristic_score(c)))
        .collect();
    let fallback_idx = scores
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(idx, _)| *idx)
        .unwrap_or(0);
    let paths: Vec<String> = cluster.iter().map(|c| c.path.clone()).collect();
    let winner_idx = ai
        .rank_duplicate_candidates(&paths)
        .await
        .ok()
        .filter(|idx| *idx < cluster.len())
        .unwrap_or(fallback_idx);
    let winner = cluster[winner_idx].clone();

    let mut by_quality: Vec<(usize, f64)> = scores.clone();
    by_quality.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut rank_map: HashMap<i64, i64> = HashMap::new();
    rank_map.insert(winner.id, 1);
    let mut next_rank = 2_i64;
    for (idx, _) in by_quality {
        let id = cluster[idx].id;
        if id == winner.id {
            continue;
        }
        rank_map.insert(id, next_rank);
        next_rank += 1;
    }

    let cluster_key = format!("dup-{}", cluster.iter().map(|c| c.id).min().unwrap_or(winner.id));
    for item in cluster.iter() {
        let score = heuristic_score(item);
        let rank = *rank_map.get(&item.id).unwrap_or(&999);
        if item.id == winner.id {
            conn.execute(
                "UPDATE media_items
                 SET classification='review', classification_source='rule', review_reason='duplicate_keep_suggestion',
                     review_reason_details=?1, duplicate_cluster_id=?2, duplicate_rank=?3, duplicate_score=?4,
                     status='classified', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?5",
                params![
                    serde_json::json!({
                        "reason": "duplicate_keep_suggestion",
                        "clusterId": cluster_key,
                        "suggestedKeep": true,
                        "rank": rank,
                        "score": score
                    })
                    .to_string(),
                    cluster_key,
                    rank,
                    score,
                    item.id
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE media_items
                 SET classification='review', classification_source='rule', review_reason='duplicate_non_best',
                     review_reason_details=?1, duplicate_cluster_id=?2, duplicate_rank=?3, duplicate_score=?4,
                     status='classified', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?5",
                params![
                    serde_json::json!({
                        "reason": "duplicate_non_best",
                        "clusterId": cluster_key,
                        "winnerId": winner.id,
                        "winnerFilename": winner.filename,
                        "rank": rank,
                        "score": score
                    })
                    .to_string(),
                    cluster_key,
                    rank,
                    score,
                    item.id
                ],
            )?;
        }
    }
    Ok(())
}

fn heuristic_score(c: &Candidate) -> f64 {
    let pixels = (c.width.max(1) * c.height.max(1)) as f64;
    let density = c.file_size.max(1) as f64 / pixels;
    pixels.ln() + density * 2.0
}

fn extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp" | "bmp" | "tif" | "tiff")
}

fn normalized_stem(filename: &str) -> String {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    stem.trim_end_matches(|c: char| c.is_ascii_digit() || c == ')' || c == '(' || c == '_' || c == '-' || c == ' ')
        .to_string()
}

fn likely_duplicate(
    a: &Candidate,
    b: &Candidate,
    a_fp: Option<ImageFingerprint>,
    b_fp: Option<ImageFingerprint>,
) -> bool {
    if let (Some(a_cid), Some(b_cid)) = (
        a.content_identifier.as_ref().filter(|v| !v.is_empty()),
        b.content_identifier.as_ref().filter(|v| !v.is_empty()),
    ) {
        if a_cid == b_cid {
            return true;
        }
    }

    if !dimensions_compatible(a, b) {
        return false;
    }
    let time_close = taken_within_seconds(a.date_taken.as_deref(), b.date_taken.as_deref(), 120);

    match (a_fp, b_fp) {
        (Some(af), Some(bf)) => {
            let hash_distance = (af.hash ^ bf.hash).count_ones() as i32;
            let ar_diff = (af.aspect_ratio - bf.aspect_ratio).abs();
            if ar_diff > 0.02 {
                return false;
            }
            let numeric_close = sequential_capture_hint(&a.filename, &b.filename);
            if time_close {
                hash_distance <= 14
            } else if numeric_close {
                hash_distance <= 18
            } else {
                hash_distance <= 8
            }
        }
        _ => {
            // Fallback only when we cannot decode images for hashing.
            let stems_match = normalized_stem(&a.filename) == normalized_stem(&b.filename);
            stems_match && dimensions_compatible(a, b) && size_ratio_compatible(a, b)
        }
    }
}

fn sequential_capture_hint(a_name: &str, b_name: &str) -> bool {
    let Some(a_num) = trailing_number(a_name) else {
        return false;
    };
    let Some(b_num) = trailing_number(b_name) else {
        return false;
    };
    (a_num - b_num).abs() <= 2
}

fn trailing_number(filename: &str) -> Option<i64> {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let digits_rev: String = stem.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if digits_rev.is_empty() {
        return None;
    }
    let digits: String = digits_rev.chars().rev().collect();
    digits.parse::<i64>().ok()
}

fn dimensions_compatible(a: &Candidate, b: &Candidate) -> bool {
    let aw = a.width.max(1) as f64;
    let ah = a.height.max(1) as f64;
    let bw = b.width.max(1) as f64;
    let bh = b.height.max(1) as f64;
    let ar_a = aw / ah;
    let ar_b = bw / bh;
    let ar_diff = (ar_a - ar_b).abs();
    let w_delta = ((aw - bw).abs()) / aw.max(bw);
    let h_delta = ((ah - bh).abs()) / ah.max(bh);
    ar_diff <= 0.02 && w_delta <= 0.06 && h_delta <= 0.06
}

fn size_ratio_compatible(a: &Candidate, b: &Candidate) -> bool {
    let fa = a.file_size.max(1) as f64;
    let fb = b.file_size.max(1) as f64;
    let ratio = fa.max(fb) / fa.min(fb);
    ratio <= 1.35
}

fn taken_within_seconds(a: Option<&str>, b: Option<&str>, max_secs: i64) -> bool {
    let Some(ta) = parse_taken_time(a) else {
        return false;
    };
    let Some(tb) = parse_taken_time(b) else {
        return false;
    };
    (ta - tb).abs() <= max_secs
}

fn parse_taken_time(value: Option<&str>) -> Option<i64> {
    let s = value?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).timestamp());
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let dt = d.and_hms_opt(0, 0, 0)?;
        return Some(DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).timestamp());
    }
    None
}

fn load_fingerprint(path: &str) -> Option<ImageFingerprint> {
    let reader = image::ImageReader::open(path).ok()?;
    let decoded = reader.decode().ok()?;
    let gray = decoded.to_luma8();
    let resized = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);
    let mut hash: u64 = 0;
    let mut bit = 0_u32;
    for y in 0..8 {
        for x in 0..8 {
            let left = resized.get_pixel(x, y)[0];
            let right = resized.get_pixel(x + 1, y)[0];
            if left > right {
                hash |= 1_u64 << bit;
            }
            bit += 1;
        }
    }
    let width = decoded.width().max(1) as f64;
    let height = decoded.height().max(1) as f64;
    Some(ImageFingerprint {
        hash,
        aspect_ratio: width / height,
    })
}

struct DisjointSet {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
            rank: vec![0; size],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            let p = self.find(self.parent[x]);
            self.parent[x] = p;
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb {
            return;
        }
        if self.rank[ra] < self.rank[rb] {
            self.parent[ra] = rb;
        } else if self.rank[ra] > self.rank[rb] {
            self.parent[rb] = ra;
        } else {
            self.parent[rb] = ra;
            self.rank[ra] += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::apply;
    use crate::db::init_db;
    use crate::services::ai_client::{AiClient, AiRoutingConfig};
    use rusqlite::params;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-review-rules-test-{}.db", rand::random::<u64>()));
        p
    }

    #[tokio::test]
    async fn apply_marks_live_photo_videos_and_duplicate_candidates() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, width, height, file_size, content_identifier, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'classified')",
            params!["img-live", "IMG_1000.HEIC", "C:\\tmp\\IMG_1000.HEIC", "image/heic", 4032_i64, 3024_i64, 2_200_000_i64, "CID-LIVE-1"],
        )
        .expect("insert live photo image");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, duration_secs, file_size, content_identifier, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'classified')",
            params!["vid-live", "IMG_1000.MOV", "C:\\tmp\\IMG_1000.MOV", "video/quicktime", 2.7_f64, 1_100_000_i64, "CID-LIVE-1"],
        )
        .expect("insert live photo video");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, width, height, file_size, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'classified')",
            params!["dup-1", "IMG_DUP_01.JPG", "C:\\tmp\\IMG_DUP_01.JPG", "image/jpeg", 2048_i64, 1536_i64, 1_000_000_i64],
        )
        .expect("insert dup 1");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, width, height, file_size, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'classified')",
            params!["dup-2", "IMG_DUP_02.JPG", "C:\\tmp\\IMG_DUP_02.JPG", "image/jpeg", 2048_i64, 1536_i64, 1_040_000_i64],
        )
        .expect("insert dup 2");

        let ai = AiClient::new(None, None, AiRoutingConfig::default());
        apply(&conn, &ai).await.expect("apply review rules");

        let (reason, live_flag): (Option<String>, i64) = conn
            .query_row(
                "SELECT review_reason, is_live_photo_video FROM media_items WHERE icloud_id='vid-live'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("live photo row");
        assert_eq!(reason.as_deref(), Some("live_photo_video"));
        assert_eq!(live_flag, 1);

        let dup_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE duplicate_cluster_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .expect("duplicate cluster count");
        assert_eq!(dup_count, 2);

        let suggested_keep_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE review_reason='duplicate_keep_suggestion'",
                [],
                |r| r.get(0),
            )
            .expect("keep suggestion count");
        assert_eq!(suggested_keep_count, 1);
        let winner_rank: i64 = conn
            .query_row(
                "SELECT duplicate_rank FROM media_items WHERE review_reason='duplicate_keep_suggestion' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("winner rank");
        assert_eq!(winner_rank, 1);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn apply_does_not_cluster_unrelated_same_dimension_images_without_similarity() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, width, height, file_size, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'classified')",
            params!["u1", "IMG_0491.JPG", "C:\\tmp\\IMG_0491.JPG", "image/jpeg", 1536_i64, 2048_i64, 990_000_i64],
        )
        .expect("insert u1");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, mime_type, width, height, file_size, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'classified')",
            params!["u2", "VACATION_1200.JPG", "C:\\tmp\\VACATION_1200.JPG", "image/jpeg", 1536_i64, 2048_i64, 1_010_000_i64],
        )
        .expect("insert u2");

        let ai = AiClient::new(None, None, AiRoutingConfig::default());
        apply(&conn, &ai).await.expect("apply review rules");

        let dup_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE duplicate_cluster_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .expect("duplicate cluster count");
        assert_eq!(dup_count, 0);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

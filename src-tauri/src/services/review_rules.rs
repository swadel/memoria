use anyhow::Result;
use rusqlite::{params, Connection};
use std::collections::HashMap;
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
    duration_secs: Option<f64>,
    content_identifier: Option<String>,
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
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), COALESCE(mime_type, ''), COALESCE(width, 0), COALESCE(height, 0),
                COALESCE(file_size, 0), duration_secs, COALESCE(content_identifier, '')
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
            duration_secs: row.get(7)?,
            content_identifier: row
                .get::<_, String>(8)?
                .trim()
                .to_string()
                .into(),
        })
    })?;

    let mut groups: HashMap<String, Vec<Candidate>> = HashMap::new();
    for row in rows {
        let c = row?;
        if !c.mime_type.to_ascii_lowercase().starts_with("image/") || !is_image_ext(extension(&c.filename).as_str()) {
            continue;
        }
        let key = duplicate_key(&c);
        groups.entry(key).or_default().push(c);
    }

    for (cluster_key, mut cluster) in groups {
        if cluster.len() < 2 {
            continue;
        }
        cluster.sort_by_key(|c| c.id);
        let paths: Vec<String> = cluster.iter().map(|c| c.path.clone()).collect();
        let winner_idx = ai.rank_duplicate_candidates(&paths).await.unwrap_or(0);
        let winner = cluster.get(winner_idx).cloned().unwrap_or_else(|| cluster[0].clone());

        for (rank, item) in cluster.iter().enumerate() {
            let score = heuristic_score(item);
            if item.id == winner.id {
                conn.execute(
                    "UPDATE media_items
                     SET classification='review', classification_source='rule', review_reason='duplicate_keep_suggestion',
                         review_reason_details=?1, duplicate_cluster_id=?2, duplicate_rank=1, duplicate_score=?3,
                         status='classified', updated_at=CURRENT_TIMESTAMP
                     WHERE id=?4",
                    params![
                        serde_json::json!({
                            "reason": "duplicate_keep_suggestion",
                            "clusterId": cluster_key,
                            "suggestedKeep": true,
                            "score": score
                        })
                        .to_string(),
                        cluster_key,
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
                            "rank": rank + 1,
                            "score": score
                        })
                        .to_string(),
                        cluster_key,
                        (rank + 1) as i64,
                        score,
                        item.id
                    ],
                )?;
            }
        }
    }

    Ok(())
}

fn duplicate_key(c: &Candidate) -> String {
    let stem = normalized_stem(&c.filename);
    let dim_key = format!("{}x{}", c.width, c.height);
    let size_bucket = c.file_size / 100_000;
    let duration_bucket = c.duration_secs.map(|d| (d * 10.0).round() as i64).unwrap_or(0);
    let cid = c.content_identifier.clone().unwrap_or_default();
    format!("{stem}|{dim_key}|{size_bucket}|{duration_bucket}|{cid}")
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

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

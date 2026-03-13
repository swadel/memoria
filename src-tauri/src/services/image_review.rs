use anyhow::Result;
use chrono::NaiveDateTime;
use rand::Rng;
use rusqlite::params;
use std::collections::HashMap;

use crate::db;

const IMAGE_PHASE_STATE_KEY: &str = "image_review_phase_state";
const SMALL_FILE_LIMIT_BYTES: i64 = 500 * 1024;
const BURST_SECONDS_WINDOW: i64 = 3;
const BURST_SIZE_RATIO: f64 = 0.15;

#[derive(Debug, Clone)]
struct ImageCandidate {
    id: i64,
    file_size: i64,
    date_taken: Option<NaiveDateTime>,
    current_path: String,
    sharpness: f64,
}

pub async fn run_image_review_scan(conn: &rusqlite::Connection) -> Result<()> {
    let threshold = db::get_setting(conn, "image_blurry_threshold")?
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(100.0);
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(file_size, 0), date_taken, COALESCE(current_path, '')
         FROM media_items
         WHERE mime_type LIKE 'image/%' AND status='indexed' AND status != 'excluded'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;

    let mut candidates = Vec::new();
    for row in rows {
        let (id, file_size, date_raw, current_path) = row?;
        let sharpness = compute_sharpness_score(file_size, &current_path);
        let date_taken = date_raw.as_deref().and_then(parse_capture_datetime);
        candidates.push(ImageCandidate {
            id,
            file_size,
            date_taken,
            current_path,
            sharpness,
        });
    }

    let burst_map = detect_burst_groups(candidates.as_slice());
    for candidate in candidates {
        let mut flags: Vec<&str> = Vec::new();
        if candidate.file_size < SMALL_FILE_LIMIT_BYTES {
            flags.push("small_file");
        }
        if candidate.sharpness < threshold {
            flags.push("blurry");
        }

        let mut burst_group_id: Option<String> = None;
        let mut is_burst_primary = false;
        if let Some(group) = burst_map.get(&candidate.id) {
            burst_group_id = Some(group.group_id.clone());
            is_burst_primary = group.primary_id == candidate.id;
            if !is_burst_primary {
                flags.push("burst_shot");
            }
        }

        let flags_json = serde_json::to_string(&flags)?;
        let next_status = if flags.is_empty() { "image_reviewed" } else { "indexed" };
        conn.execute(
            "UPDATE media_items
             SET sharpness_score=?1, burst_group_id=?2, is_burst_primary=?3, image_flags=?4, status=?5, updated_at=CURRENT_TIMESTAMP
             WHERE id=?6",
            params![
                candidate.sharpness,
                burst_group_id,
                if is_burst_primary { 1 } else { 0 },
                flags_json,
                next_status,
                candidate.id
            ],
        )?;
    }

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

pub fn keep_best_only(conn: &mut rusqlite::Connection, burst_group_id: &str, root_output: &std::path::Path) -> Result<usize> {
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

fn compute_sharpness_score(file_size: i64, current_path: &str) -> f64 {
    if current_path.trim().is_empty() {
        return 0.0;
    }
    (file_size as f64) / 1024.0
}

#[derive(Clone)]
struct BurstInfo {
    group_id: String,
    primary_id: i64,
}

fn detect_burst_groups(items: &[ImageCandidate]) -> HashMap<i64, BurstInfo> {
    let mut sorted = items.to_vec();
    sorted.sort_by_key(|i| i.date_taken);
    let mut out = HashMap::new();
    let mut idx = 0usize;
    while idx < sorted.len() {
        let Some(base_dt) = sorted[idx].date_taken else {
            idx += 1;
            continue;
        };
        let mut group = vec![sorted[idx].clone()];
        let mut j = idx + 1;
        while j < sorted.len() {
            let Some(next_dt) = sorted[j].date_taken else {
                break;
            };
            let dt_diff = (next_dt - base_dt).num_seconds().abs();
            if dt_diff > BURST_SECONDS_WINDOW {
                break;
            }
            let base_size = sorted[idx].file_size.max(1) as f64;
            let size_ratio = ((sorted[j].file_size as f64 - base_size).abs()) / base_size;
            if size_ratio <= BURST_SIZE_RATIO {
                group.push(sorted[j].clone());
            }
            j += 1;
        }
        if group.len() >= 2 {
            let mut rng = rand::thread_rng();
            let group_id = format!("burst-{:016x}", rng.gen::<u64>());
            let primary = group
                .iter()
                .max_by(|a, b| a.sharpness.partial_cmp(&b.sharpness).unwrap_or(std::cmp::Ordering::Equal))
                .map(|v| v.id)
                .unwrap_or(group[0].id);
            for candidate in group {
                out.insert(
                    candidate.id,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-image-review-test-{}.db", rand::random::<u64>()));
        p
    }

    #[tokio::test]
    async fn small_file_boundary_flags_499kb_not_500kb() {
        let db = temp_db_path();
        let conn = init_db(&db).expect("db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('a', 'a.jpg', 'C:\\tmp\\a.jpg', 'indexed', 'image/jpeg', ?1, '2026-01-01 10:00:00')",
            [499_i64 * 1024],
        )
        .expect("a");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('b', 'b.jpg', 'C:\\tmp\\b.jpg', 'indexed', 'image/jpeg', ?1, '2026-01-01 10:00:10')",
            [500_i64 * 1024],
        )
        .expect("b");
        run_image_review_scan(&conn).await.expect("scan");
        let a_flags: String = conn
            .query_row("SELECT COALESCE(image_flags, '[]') FROM media_items WHERE icloud_id='a'", [], |r| r.get(0))
            .expect("a flags");
        let b_flags: String = conn
            .query_row("SELECT COALESCE(image_flags, '[]') FROM media_items WHERE icloud_id='b'", [], |r| r.get(0))
            .expect("b flags");
        assert!(a_flags.contains("small_file"));
        assert!(!b_flags.contains("small_file"));
    }

    #[tokio::test]
    async fn burst_group_and_primary_selected_by_highest_sharpness() {
        let db = temp_db_path();
        let conn = init_db(&db).expect("db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('a', 'a.jpg', 'C:\\tmp\\a.jpg', 'indexed', 'image/jpeg', 1000000, '2026-01-01 10:00:00')",
            [],
        )
        .expect("a");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('b', 'b.jpg', 'C:\\tmp\\b.jpg', 'indexed', 'image/jpeg', 1090000, '2026-01-01 10:00:02')",
            [],
        )
        .expect("b");
        run_image_review_scan(&conn).await.expect("scan");
        let group_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items WHERE burst_group_id IS NOT NULL", [], |r| r.get(0))
            .expect("group count");
        assert_eq!(group_count, 2);
        let primary_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items WHERE burst_group_id IS NOT NULL AND is_burst_primary=1", [], |r| r.get(0))
            .expect("primary count");
        assert_eq!(primary_count, 1);
    }

    #[tokio::test]
    async fn outside_burst_threshold_not_grouped() {
        let db = temp_db_path();
        let conn = init_db(&db).expect("db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('a', 'a.jpg', 'C:\\tmp\\a.jpg', 'indexed', 'image/jpeg', 1000000, '2026-01-01 10:00:00')",
            [],
        )
        .expect("a");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, file_size, date_taken) VALUES('b', 'b.jpg', 'C:\\tmp\\b.jpg', 'indexed', 'image/jpeg', 2000000, '2026-01-01 10:00:10')",
            [],
        )
        .expect("b");
        run_image_review_scan(&conn).await.expect("scan");
        let grouped: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_items WHERE burst_group_id IS NOT NULL", [], |r| r.get(0))
            .expect("grouped");
        assert_eq!(grouped, 0);
    }
}

use anyhow::Result;
use chrono::{Datelike, Utc};
use rusqlite::{params, Connection};
use std::path::PathBuf;

use super::{ai_client::AiClient, exiftool, runtime_log};

fn is_invalid_date(value: &str) -> bool {
    value.starts_with("1970:01:01") || value.starts_with("0000:00:00")
}

pub async fn evaluate(conn: &Connection, ai: &AiClient) -> Result<()> {
    runtime_log::info("date_enforcer", "Starting missing-date evaluation.");
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), date_taken
         FROM media_items
         WHERE status IN ('downloaded', 'metadata_extracted', 'date_review_pending', 'date_verified')
           AND COALESCE(current_path, '') != ''",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    let mut processed = 0_i64;
    let mut flagged_for_review = 0_i64;
    let mut verified = 0_i64;
    for row in rows {
        let (id, filename, path, db_date) = row?;
        processed += 1;
        runtime_log::info(
            "date_enforcer",
            format!("Evaluating item id={id} filename='{}' path='{}'.", filename, path),
        );
        let meta = exiftool::read_metadata(PathBuf::from(&path).as_path()).await?;
        let dt = meta.date_time_original.or(db_date);
        let bad = match dt.as_deref() {
            None => true,
            Some(d) => is_invalid_date(d),
        };
        if bad {
            let estimate = ai
                .estimate_date(&filename, Some(path.as_str()))
                .await?;
            let raw = serde_json::json!({
                "ai_date": estimate.ai_date,
                "confidence": estimate.confidence,
                "reasoning": estimate.reasoning
            })
            .to_string();
            conn.execute(
                "UPDATE media_items
                 SET date_needs_review=1, ai_date_estimate_raw=?1, status='date_review_pending', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?2",
                params![raw, id],
            )?;
            flagged_for_review += 1;
            runtime_log::info(
                "date_enforcer",
                format!(
                    "Flagged id={id} for date review. ai_date={:?} confidence={:.2}.",
                    estimate.ai_date, estimate.confidence
                ),
            );
        } else {
            let normalized = normalize_exif_date(dt.unwrap_or_default().as_str());
            conn.execute(
                "UPDATE media_items
                 SET date_taken=?1, date_taken_source='exif', date_needs_review=0, status='date_verified', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?2",
                params![normalized, id],
            )?;
            verified += 1;
            runtime_log::info(
                "date_enforcer",
                format!("Verified id={id} with normalized date '{}'.", normalized),
            );
        }
    }
    runtime_log::info(
        "date_enforcer",
        format!(
            "Finished evaluation. processed={} flagged_for_review={} verified={}.",
            processed, flagged_for_review, verified
        ),
    );
    Ok(())
}

pub async fn apply_date_approval(conn: &Connection, media_item_id: i64, date: Option<String>) -> Result<()> {
    runtime_log::info(
        "date_enforcer",
        format!(
            "Applying date approval for id={media_item_id}. mode={}.",
            if date.is_some() { "approve" } else { "skip" }
        ),
    );
    if let Some(value) = date {
        let file_path: String = conn.query_row(
            "SELECT COALESCE(current_path, '') FROM media_items WHERE id=?1",
            [media_item_id],
            |r| r.get(0),
        )?;
        let _ = exiftool::write_all_dates(PathBuf::from(&file_path).as_path(), &value).await;
        conn.execute(
            "UPDATE media_items
             SET date_taken=?1, date_taken_source='user_override', date_needs_review=0, status='date_verified', updated_at=CURRENT_TIMESTAMP
             WHERE id=?2",
            params![value, media_item_id],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value, details)
             VALUES(?1, 'date_set', 'user', ?2, ?3)",
            params![media_item_id, value, "{\"approved\":true}"],
        )?;
        runtime_log::info(
            "date_enforcer",
            format!("Approved id={media_item_id} with date '{}'.", value),
        );
    } else {
        conn.execute(
            "UPDATE media_items
             SET date_needs_review=0, status='date_verified', updated_at=CURRENT_TIMESTAMP
             WHERE id=?1",
            [media_item_id],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, details)
             VALUES(?1, 'date_skipped', 'user', ?2)",
            params![media_item_id, "{\"approved\":false}"],
        )?;
        runtime_log::info("date_enforcer", format!("Skipped date approval for id={media_item_id}."));
    }
    Ok(())
}

fn normalize_exif_date(value: &str) -> String {
    if value.len() >= 10 && value.chars().nth(4) == Some(':') {
        let date = &value[..10];
        return date.replace(':', "-");
    }
    let year = Utc::now().year();
    format!("{year}-01-01")
}

#[cfg(test)]
mod tests {
    use super::evaluate;
    use crate::db::init_db;
    use crate::services::ai_client::{AiClient, AiRoutingConfig};
    use rusqlite::params;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-date-enforcer-test-{}.db", rand::random::<u64>()));
        p
    }

    #[tokio::test]
    async fn evaluate_marks_missing_dates_for_review_and_verifies_valid_dates() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_taken)
             VALUES(?1, ?2, ?3, 'metadata_extracted', ?4)",
            params!["ok-1", "IMG_OK.JPG", "C:\\tmp\\IMG_OK.JPG", "2026-03-12"],
        )
        .expect("insert valid date item");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_taken)
             VALUES(?1, ?2, ?3, 'metadata_extracted', NULL)",
            params!["miss-1", "IMG_MISSING.JPG", "C:\\tmp\\IMG_MISSING.JPG"],
        )
        .expect("insert missing date item");

        let ai = AiClient::new(None, None, AiRoutingConfig::default());
        evaluate(&conn, &ai).await.expect("evaluate");

        let valid_status: String = conn
            .query_row("SELECT status FROM media_items WHERE icloud_id='ok-1'", [], |r| r.get(0))
            .expect("valid status");
        let missing_status: String = conn
            .query_row("SELECT status FROM media_items WHERE icloud_id='miss-1'", [], |r| r.get(0))
            .expect("missing status");
        let missing_flag: i64 = conn
            .query_row(
                "SELECT date_needs_review FROM media_items WHERE icloud_id='miss-1'",
                [],
                |r| r.get(0),
            )
            .expect("missing flag");
        assert_eq!(valid_status, "date_verified");
        assert_eq!(missing_status, "date_review_pending");
        assert_eq!(missing_flag, 1);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn skip_clears_date_review_flag_and_sets_verified_status() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_needs_review)
             VALUES(?1, ?2, ?3, 'date_review_pending', 1)",
            params!["skip-1", "IMG_SKIP.JPG", "C:\\tmp\\IMG_SKIP.JPG"],
        )
        .expect("insert skip row");
        let id = conn.last_insert_rowid();

        super::apply_date_approval(&conn, id, None)
            .await
            .expect("skip approval");

        let (flag, status): (i64, String) = conn
            .query_row(
                "SELECT date_needs_review, status FROM media_items WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row after skip");
        assert_eq!(flag, 0);
        assert_eq!(status, "date_verified");

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn approve_sets_user_override_date_and_audit_row() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_needs_review)
             VALUES(?1, ?2, ?3, 'date_review_pending', 1)",
            params!["approve-1", "IMG_APPROVE.JPG", "C:\\tmp\\IMG_APPROVE.JPG"],
        )
        .expect("insert approve row");
        let id = conn.last_insert_rowid();

        super::apply_date_approval(&conn, id, Some("2026-04-20".to_string()))
            .await
            .expect("approve date");

        let (date_taken, source, flag, status): (Option<String>, Option<String>, i64, String) = conn
            .query_row(
                "SELECT date_taken, date_taken_source, date_needs_review, status FROM media_items WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("row after approve");
        assert_eq!(date_taken.as_deref(), Some("2026-04-20"));
        assert_eq!(source.as_deref(), Some("user_override"));
        assert_eq!(flag, 0);
        assert_eq!(status, "date_verified");

        let audit_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE media_item_id=?1 AND action='date_set'",
                [id],
                |r| r.get(0),
            )
            .expect("date_set audit count");
        assert_eq!(audit_count, 1);

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

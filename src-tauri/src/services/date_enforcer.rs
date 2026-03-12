use anyhow::Result;
use chrono::{Datelike, Utc};
use rusqlite::{params, Connection};
use std::path::PathBuf;

use super::{ai_client::AiClient, exiftool};

fn is_invalid_date(value: &str) -> bool {
    value.starts_with("1970:01:01") || value.starts_with("0000:00:00")
}

pub async fn evaluate(conn: &Connection, ai: &AiClient) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), date_taken
         FROM media_items WHERE classification='legitimate'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    for row in rows {
        let (id, filename, path, db_date) = row?;
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
                 SET date_needs_review=1, ai_classification_raw=?1, status='classified', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?2",
                params![raw, id],
            )?;
        } else {
            let normalized = normalize_exif_date(dt.unwrap_or_default().as_str());
            conn.execute(
                "UPDATE media_items
                 SET date_taken=?1, date_taken_source='exif', date_needs_review=0, status='date_verified', updated_at=CURRENT_TIMESTAMP
                 WHERE id=?2",
                params![normalized, id],
            )?;
        }
    }
    Ok(())
}

pub async fn apply_date_approval(conn: &Connection, media_item_id: i64, date: Option<String>) -> Result<()> {
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
    } else {
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, details)
             VALUES(?1, 'date_skipped', 'user', ?2)",
            params![media_item_id, "{\"approved\":false}"],
        )?;
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

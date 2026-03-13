use anyhow::Result;
use rusqlite::{params, Connection};

use super::ai_client::AiClient;
use crate::db;

pub async fn run(conn: &Connection, ai: &AiClient) -> Result<()> {
    let confidence_threshold = db::get_setting(conn, "classification_confidence_threshold")?
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.90);
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(file_size, 0), COALESCE(mime_type, ''), COALESCE(current_path, '')
         FROM media_items WHERE status IN ('downloaded', 'metadata_extracted', 'classified')",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    for row in rows {
        let (id, filename, file_size, mime_type, current_path) = row?;
        let lower = filename.to_ascii_lowercase();

        let (classification, source, raw, review_reason, review_reason_details) = if lower.ends_with(".gif") {
            (
                "review".to_string(),
                "rule".to_string(),
                None,
                Some("gif".to_string()),
                Some(serde_json::json!({"reason":"gif","filename": filename}).to_string()),
            )
        } else if lower.contains("screenshot") {
            (
                "review".to_string(),
                "rule".to_string(),
                None,
                Some("screenshot".to_string()),
                Some(serde_json::json!({"reason":"screenshot","filename": filename}).to_string()),
            )
        } else if mime_type.contains("image") && file_size < 50_000 {
            (
                "review".to_string(),
                "rule".to_string(),
                None,
                Some("low_confidence".to_string()),
                Some(serde_json::json!({"reason":"tiny_image","fileSize": file_size}).to_string()),
            )
        } else {
            let res = ai
                .classify_image(&filename, file_size, Some(current_path.as_str()))
                .await?;
            let source = "ai".to_string();
            let raw = Some(serde_json::json!({
                "category": res.category,
                "confidence": res.confidence
            })
            .to_string());
            let class = if res.confidence >= confidence_threshold {
                res.category.clone()
            } else {
                "review".to_string()
            };
            let reason = if class == "review" {
                if res.confidence < confidence_threshold {
                    Some("low_confidence".to_string())
                } else {
                    Some("meme_or_non_legitimate".to_string())
                }
            } else {
                None
            };
            let details = reason.as_ref().map(|r| {
                serde_json::json!({
                    "reason": r,
                    "aiCategory": res.category,
                    "confidence": res.confidence,
                    "threshold": confidence_threshold
                })
                .to_string()
            });
            (class, source, raw, reason, details)
        };

        conn.execute(
            "UPDATE media_items
             SET classification=?1, classification_source=?2, ai_classification_raw=?3, review_reason=?4, review_reason_details=?5, status='classified', updated_at=CURRENT_TIMESTAMP
             WHERE id=?6",
            params![classification, source, raw, review_reason, review_reason_details, id],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::db::init_db;
    use crate::services::{ai_client::AiClient, date_enforcer, event_grouper, file_organizer};
    use rusqlite::params;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-pipeline-{}", rand::random::<u64>()));
        p
    }

    #[tokio::test]
    async fn pipeline_smoke_test_from_classification_to_filing() {
        let root = temp_root();
        fs::create_dir_all(root.join("staging")).expect("create staging");
        let db_path = root.join("memoria.db");
        let conn = init_db(&db_path).expect("init db");

        let file1 = root.join("staging").join("IMG_0001.jpg");
        let file2 = root.join("staging").join("screenshot_0002.png");
        fs::write(&file1, b"img").expect("write file1");
        fs::write(&file2, b"img").expect("write file2");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, original_path, file_size, mime_type, status)
             VALUES(?1, ?2, ?3, ?3, ?4, ?5, 'downloaded')",
            params!["a1", "IMG_0001.jpg", file1.to_string_lossy().to_string(), 500_000_i64, "image/jpeg"],
        )
        .expect("insert media1");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, original_path, file_size, mime_type, status)
             VALUES(?1, ?2, ?3, ?3, ?4, ?5, 'downloaded')",
            params!["a2", "screenshot_0002.png", file2.to_string_lossy().to_string(), 20_000_i64, "image/png"],
        )
        .expect("insert media2");

        let ai = AiClient::new(None, None, crate::services::ai_client::AiRoutingConfig::default());
        run(&conn, &ai).await.expect("classification run");

        let classified_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE status='classified'",
                [],
                |r| r.get(0),
            )
            .expect("count classified");
        assert_eq!(classified_count, 2);

        // Move one asset through the rest of the pipeline as legitimate media.
        conn.execute(
            "UPDATE media_items SET classification='legitimate', classification_source='user' WHERE icloud_id='a1'",
            [],
        )
        .expect("promote legitimate");

        date_enforcer::evaluate(&conn, &ai).await.expect("date evaluate");
        let media_id: i64 = conn
            .query_row("SELECT id FROM media_items WHERE icloud_id='a1'", [], |r| r.get(0))
            .expect("id");
        date_enforcer::apply_date_approval(&conn, media_id, Some("2026-01-05".to_string()))
            .await
            .expect("date approval");

        event_grouper::run(&conn, &ai).await.expect("grouping");
        let grouped: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE status='grouped' AND id=?1",
                [media_id],
                |r| r.get(0),
            )
            .expect("grouped count");
        assert_eq!(grouped, 1);

        file_organizer::finalize(&conn, root.to_string_lossy().as_ref())
            .await
            .expect("finalize");
        let final_path: String = conn
            .query_row("SELECT COALESCE(final_path, '') FROM media_items WHERE id=?1", [media_id], |r| {
                r.get(0)
            })
            .expect("final path");
        assert!(!final_path.is_empty());
        assert!(PathBuf::from(final_path).exists());

        drop(conn);
        let _ = fs::remove_dir_all(root);
    }
}

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

use crate::models::{DashboardStats, DateEstimateDto, EventGroupDto, MediaItemDto};

pub fn init_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    icloud_id           TEXT UNIQUE,
    filename            TEXT NOT NULL,
    original_path       TEXT,
    current_path        TEXT,
    final_path          TEXT,
    file_size           INTEGER,
    mime_type           TEXT,
    width               INTEGER,
    height              INTEGER,
    duration_secs       REAL,
    date_taken          TEXT,
    date_taken_source   TEXT,
    date_taken_confidence REAL,
    date_needs_review   INTEGER DEFAULT 0,
    classification      TEXT,
    classification_source TEXT,
    ai_classification_raw TEXT,
    review_reason       TEXT,
    review_reason_details TEXT,
    duplicate_cluster_id TEXT,
    duplicate_rank      INTEGER,
    duplicate_score     REAL,
    is_live_photo_video INTEGER DEFAULT 0,
    live_photo_pair_key TEXT,
    content_identifier  TEXT,
    status              TEXT DEFAULT 'queued',
    error_message       TEXT,
    event_group_id      INTEGER REFERENCES event_groups(id),
    created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_groups (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    year                INTEGER NOT NULL,
    name                TEXT NOT NULL,
    folder_name         TEXT NOT NULL,
    start_date          TEXT,
    end_date            TEXT,
    ai_suggested_name   TEXT,
    is_misc             INTEGER DEFAULT 0,
    user_approved       INTEGER DEFAULT 0,
    item_count          INTEGER DEFAULT 0,
    created_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    media_item_id       INTEGER REFERENCES media_items(id),
    action              TEXT NOT NULL,
    old_value           TEXT,
    new_value           TEXT,
    source              TEXT,
    details             TEXT,
    timestamp           TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS download_sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    date_range_start    TEXT NOT NULL,
    date_range_end      TEXT NOT NULL,
    status              TEXT NOT NULL,
    total_items         INTEGER DEFAULT 0,
    downloaded_count    INTEGER DEFAULT 0,
    output_directory    TEXT NOT NULL,
    started_at          TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at        TEXT
);

CREATE TABLE IF NOT EXISTS classification_rules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    rule_type           TEXT NOT NULL,
    operator            TEXT NOT NULL,
    value               TEXT NOT NULL,
    target_class        TEXT NOT NULL,
    priority            INTEGER DEFAULT 0,
    enabled             INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
    key                 TEXT PRIMARY KEY,
    value               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_status ON media_items(status);
CREATE INDEX IF NOT EXISTS idx_media_classification ON media_items(classification);
CREATE INDEX IF NOT EXISTS idx_media_date_review ON media_items(date_needs_review);
CREATE INDEX IF NOT EXISTS idx_media_event_group ON media_items(event_group_id);
f        "#,
    )?;
    ensure_column(&conn, "media_items", "review_reason", "TEXT")?;
    ensure_column(&conn, "media_items", "review_reason_details", "TEXT")?;
    ensure_column(&conn, "media_items", "duplicate_cluster_id", "TEXT")?;
    ensure_column(&conn, "media_items", "duplicate_rank", "INTEGER")?;
    ensure_column(&conn, "media_items", "duplicate_score", "REAL")?;
    ensure_column(&conn, "media_items", "is_live_photo_video", "INTEGER DEFAULT 0")?;
    ensure_column(&conn, "media_items", "live_photo_pair_key", "TEXT")?;
    ensure_column(&conn, "media_items", "content_identifier", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_review_reason ON media_items(review_reason)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_duplicate_cluster ON media_items(duplicate_cluster_id)",
        [],
    )?;
    Ok(conn)
}

pub fn dashboard_stats(conn: &Connection) -> Result<DashboardStats> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM media_items", [], |r| r.get(0))?;
    let downloading: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='downloading'",
        [],
        |r| r.get(0),
    )?;
    let review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE classification='review'",
        [],
        |r| r.get(0),
    )?;
    let legitimate: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE classification='legitimate'",
        [],
        |r| r.get(0),
    )?;
    let date_needs_review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE date_needs_review=1",
        [],
        |r| r.get(0),
    )?;
    let grouped: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='grouped'",
        [],
        |r| r.get(0),
    )?;
    let filed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='filed'",
        [],
        |r| r.get(0),
    )?;
    let errors: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='error'",
        [],
        |r| r.get(0),
    )?;

    Ok(DashboardStats {
        total,
        downloading,
        review,
        legitimate,
        date_needs_review,
        grouped,
        filed,
        errors,
    })
}

pub fn get_review_queue(conn: &Connection) -> Result<Vec<MediaItemDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), classification, review_reason, review_reason_details, duplicate_cluster_id, status, date_taken,
         date_needs_review, date_taken_confidence, event_group_id
         FROM media_items WHERE classification='review' ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(MediaItemDto {
            id: row.get(0)?,
            filename: row.get(1)?,
            current_path: row.get(2)?,
            classification: row.get(3)?,
            review_reason: row.get(4)?,
            review_reason_details: row.get(5)?,
            duplicate_cluster_id: row.get(6)?,
            status: row.get(7)?,
            date_taken: row.get(8)?,
            date_needs_review: row.get::<_, i64>(9)? == 1,
            ai_confidence: row.get(10)?,
            event_group_id: row.get(11)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_date_review_queue(conn: &Connection) -> Result<Vec<DateEstimateDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, date_taken, ai_classification_raw
         FROM media_items WHERE date_needs_review=1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let raw: Option<String> = row.get(3)?;
        let (ai_date, confidence, reasoning) = if let Some(raw) = raw {
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
            (
                v.get("ai_date").and_then(|x| x.as_str()).map(ToString::to_string),
                v.get("confidence").and_then(|x| x.as_f64()).unwrap_or(0.0),
                v.get("reasoning")
                    .and_then(|x| x.as_str())
                    .unwrap_or("Awaiting AI estimation")
                    .to_string(),
            )
        } else {
            (None, 0.0, "Awaiting AI estimation".to_string())
        };
        Ok(DateEstimateDto {
            media_item_id: row.get(0)?,
            filename: row.get(1)?,
            current_date: row.get(2)?,
            ai_date,
            confidence,
            reasoning,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_event_groups(conn: &Connection) -> Result<Vec<EventGroupDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, year, name, folder_name, item_count, user_approved
         FROM event_groups ORDER BY year DESC, name ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(EventGroupDto {
            id: row.get(0)?,
            year: row.get(1)?,
            name: row.get(2)?,
            folder_name: row.get(3)?,
            item_count: row.get(4)?,
            user_approved: row.get::<_, i64>(5)? == 1,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, sql_type: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {sql_type}"),
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-test-{}.db", rand::random::<u64>()));
        p
    }

    #[test]
    fn init_db_creates_required_tables_and_settings_roundtrip() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('media_items','event_groups','audit_log','download_sessions','classification_rules','settings')",
                [],
                |r| r.get(0),
            )
            .expect("table count query");
        assert_eq!(table_count, 6);

        set_setting(&conn, "k", "v").expect("set setting");
        let v = get_setting(&conn, "k").expect("get setting");
        assert_eq!(v.as_deref(), Some("v"));

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn review_queue_returns_reason_and_duplicate_cluster_fields() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, classification, review_reason, review_reason_details, duplicate_cluster_id, status, date_needs_review)
             VALUES(?1, ?2, ?3, 'review', ?4, ?5, ?6, 'classified', 0)",
            [
                "r1",
                "IMG_DUP.JPG",
                r"C:\tmp\IMG_DUP.JPG",
                "duplicate_non_best",
                r#"{"reason":"duplicate_non_best","rank":2}"#,
                "cluster-abc",
            ],
        )
        .expect("insert review row");

        let queue = get_review_queue(&conn).expect("review queue");
        assert_eq!(queue.len(), 1);
        let item = &queue[0];
        assert_eq!(item.review_reason.as_deref(), Some("duplicate_non_best"));
        assert_eq!(item.duplicate_cluster_id.as_deref(), Some("cluster-abc"));
        assert!(item.review_reason_details.as_deref().unwrap_or("").contains("\"rank\":2"));

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

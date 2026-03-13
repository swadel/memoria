use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

use crate::models::{
    DashboardStats, DateEstimateDto, EventGroupDto, EventGroupItemDto, ImageReviewItemDto, VideoReviewItemDto,
};

const DEFAULT_VIDEO_FLAG_SIZE_BYTES: i64 = 5 * 1024 * 1024;
const DEFAULT_VIDEO_FLAG_DURATION_SECS: f64 = 10.0;
const IMAGE_PHASE_STATE_KEY: &str = "image_review_phase_state";
const VIDEO_PHASE_STATE_KEY: &str = "video_review_phase_state";

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
    ai_date_estimate_raw TEXT,
    content_identifier  TEXT,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','indexed','image_reviewed','video_reviewed','date_verified','grouped','filed','excluded')),
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

CREATE TABLE IF NOT EXISTS settings (
    key                 TEXT PRIMARY KEY,
    value               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_status ON media_items(status);
CREATE INDEX IF NOT EXISTS idx_media_date_review ON media_items(date_needs_review);
CREATE INDEX IF NOT EXISTS idx_media_event_group ON media_items(event_group_id);
        "#,
    )?;
    ensure_column(&conn, "media_items", "content_identifier", "TEXT")?;
    ensure_column(&conn, "media_items", "ai_date_estimate_raw", "TEXT")?;
    ensure_column(&conn, "media_items", "video_width", "INTEGER")?;
    ensure_column(&conn, "media_items", "video_height", "INTEGER")?;
    ensure_column(&conn, "media_items", "video_codec", "TEXT")?;
    ensure_column(&conn, "media_items", "burst_group_id", "TEXT")?;
    ensure_column(&conn, "media_items", "is_burst_primary", "INTEGER DEFAULT 0")?;
    ensure_column(&conn, "media_items", "image_flags", "TEXT")?;
    ensure_column(&conn, "media_items", "sharpness_score", "REAL")?;
    ensure_media_items_status_migration(&conn)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_burst_group_id ON media_items(burst_group_id)",
        [],
    )?;
    conn.execute(
        "UPDATE media_items
         SET status='image_reviewed'
         WHERE status='indexed'
           AND (image_flags IS NULL OR image_flags='' OR image_flags='[]')",
        [],
    )?;
    if column_exists(&conn, "media_items", "ai_classification_raw")? {
        conn.execute(
            "UPDATE media_items
             SET ai_date_estimate_raw=ai_classification_raw
             WHERE ai_date_estimate_raw IS NULL
               AND ai_classification_raw IS NOT NULL",
            [],
        )?;
    }
    Ok(conn)
}

pub fn dashboard_stats(conn: &Connection) -> Result<DashboardStats> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM media_items", [], |r| r.get(0))?;
    let indexed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='indexed'",
        [],
        |r| r.get(0),
    )?;
    let image_review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='indexed' AND COALESCE(image_flags, '') != '' AND COALESCE(image_flags, '[]') != '[]'",
        [],
        |r| r.get(0),
    )?;
    let image_verified: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='image_reviewed'",
        [],
        |r| r.get(0),
    )?;
    let date_review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='image_reviewed' AND date_needs_review=1",
        [],
        |r| r.get(0),
    )?;
    let date_verified: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE status='date_verified'",
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
    let image_flagged_pending: i64 = image_review;
    let image_phase_state = get_setting(conn, IMAGE_PHASE_STATE_KEY)?
        .unwrap_or_else(|| "pending".to_string());
    let video_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items
         WHERE mime_type LIKE 'video/%' AND status IN ('image_reviewed', 'video_reviewed', 'date_verified', 'excluded', 'grouped', 'filed')",
        [],
        |r| r.get(0),
    )?;
    let video_flagged: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items
         WHERE mime_type LIKE 'video/%'
           AND status='image_reviewed'
           AND (COALESCE(file_size, 0) <= ?1 OR COALESCE(duration_secs, 0.0) <= ?2)",
        rusqlite::params![DEFAULT_VIDEO_FLAG_SIZE_BYTES, DEFAULT_VIDEO_FLAG_DURATION_SECS],
        |r| r.get(0),
    )?;
    let video_unreviewed_flagged = video_flagged;
    let video_excluded: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_items WHERE mime_type LIKE 'video/%' AND status='excluded'",
        [],
        |r| r.get(0),
    )?;
    let video_phase_state = get_setting(conn, VIDEO_PHASE_STATE_KEY)?
        .unwrap_or_else(|| "pending".to_string());

    Ok(DashboardStats {
        total,
        indexed,
        image_review,
        image_verified,
        date_review,
        date_needs_review,
        date_verified,
        grouped,
        filed,
        image_flagged_pending,
        image_phase_state,
        video_total,
        video_flagged,
        video_excluded,
        video_unreviewed_flagged,
        video_phase_state,
    })
}

pub fn get_date_review_queue(conn: &Connection) -> Result<Vec<DateEstimateDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, date_taken, ai_date_estimate_raw
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

pub fn get_event_group_items(conn: &Connection, group_id: i64, show_excluded: bool) -> Result<Vec<EventGroupItemDto>> {
    let sql = if show_excluded {
        "SELECT id, filename, current_path, date_taken, COALESCE(mime_type, '')
         FROM media_items
         WHERE event_group_id=?1 AND status='excluded'
         ORDER BY date_taken ASC, id ASC"
    } else {
        "SELECT id, filename, current_path, date_taken, COALESCE(mime_type, '')
         FROM media_items
         WHERE event_group_id=?1 AND status != 'excluded'
         ORDER BY date_taken ASC, id ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([group_id], |row| {
        Ok(EventGroupItemDto {
            id: row.get(0)?,
            filename: row.get(1)?,
            current_path: row.get(2)?,
            date_taken: row.get(3)?,
            mime_type: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_video_review_items(conn: &Connection, include_excluded: bool) -> Result<Vec<VideoReviewItemDto>> {
    let status_clause = if include_excluded {
        "status IN ('image_reviewed', 'excluded')"
    } else {
        "status='image_reviewed'"
    };
    let sql = format!(
        "SELECT id, filename, COALESCE(current_path, ''), date_taken, COALESCE(mime_type, ''), COALESCE(file_size, 0), COALESCE(duration_secs, 0.0), video_width, video_height, video_codec, status
         FROM media_items
         WHERE mime_type LIKE 'video/%' AND {status_clause}
         ORDER BY date_taken ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(VideoReviewItemDto {
            id: row.get(0)?,
            filename: row.get(1)?,
            current_path: row.get(2)?,
            date_taken: row.get(3)?,
            mime_type: row.get(4)?,
            file_size_bytes: row.get(5)?,
            duration_secs: row.get(6)?,
            video_width: row.get(7)?,
            video_height: row.get(8)?,
            video_codec: row.get(9)?,
            status: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_image_review_items(conn: &Connection, include_excluded: bool) -> Result<Vec<ImageReviewItemDto>> {
    let status_clause = if include_excluded {
        "status IN ('indexed', 'image_reviewed', 'excluded')"
    } else {
        "status IN ('indexed', 'image_reviewed')"
    };
    let sql = format!(
        "SELECT id, filename, COALESCE(current_path, ''), date_taken, COALESCE(mime_type, ''), COALESCE(file_size, 0), sharpness_score, burst_group_id, COALESCE(is_burst_primary, 0), image_flags, status
         FROM media_items
         WHERE mime_type LIKE 'image/%' AND {status_clause}
         ORDER BY date_taken ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        let flags_raw: Option<String> = row.get(9)?;
        let flags: Vec<String> = flags_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default();
        Ok(ImageReviewItemDto {
            id: row.get(0)?,
            filename: row.get(1)?,
            current_path: row.get(2)?,
            date_taken: row.get(3)?,
            mime_type: row.get(4)?,
            file_size_bytes: row.get(5)?,
            sharpness_score: row.get(6)?,
            burst_group_id: row.get(7)?,
            is_burst_primary: row.get::<_, i64>(8)? == 1,
            image_flags: flags,
            status: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn event_group_name_exists(conn: &Connection, name: &str, exclude_id: Option<i64>) -> Result<bool> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let exists = if let Some(id) = exclude_id {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM event_groups
                WHERE lower(trim(name))=lower(trim(?1))
                  AND id <> ?2
            )",
            rusqlite::params![trimmed, id],
            |r| r.get::<_, i64>(0),
        )?
    } else {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM event_groups
                WHERE lower(trim(name))=lower(trim(?1))
            )",
            [trimmed],
            |r| r.get::<_, i64>(0),
        )?
    };
    Ok(exists == 1)
}

pub fn refresh_event_group_item_counts(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut update_stmt = conn.prepare(
        "UPDATE event_groups
         SET item_count=(
            SELECT COUNT(*) FROM media_items WHERE event_group_id=event_groups.id AND status != 'excluded'
         )
         WHERE id=?1",
    )?;
    for id in ids {
        update_stmt.execute([id])?;
    }
    Ok(())
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
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {sql_type}"),
        [],
    )?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_media_items_status_migration(conn: &Connection) -> Result<()> {
    let schema: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='media_items'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(schema) = schema else {
        return Ok(());
    };
    if schema.contains("image_reviewed") && schema.contains("video_reviewed") {
        return Ok(());
    }

    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
ALTER TABLE media_items RENAME TO media_items_old;
CREATE TABLE media_items (
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
    ai_date_estimate_raw TEXT,
    content_identifier  TEXT,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','indexed','image_reviewed','video_reviewed','date_verified','grouped','filed','excluded')),
    error_message       TEXT,
    event_group_id      INTEGER REFERENCES event_groups(id),
    burst_group_id      TEXT,
    is_burst_primary    INTEGER DEFAULT 0,
    image_flags         TEXT,
    sharpness_score     REAL,
    video_width         INTEGER,
    video_height        INTEGER,
    video_codec         TEXT,
    created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO media_items(
    id, icloud_id, filename, original_path, current_path, final_path, file_size, mime_type, width, height,
    duration_secs, date_taken, date_taken_source, date_taken_confidence, date_needs_review, ai_date_estimate_raw,
    content_identifier, status, error_message, event_group_id, burst_group_id, is_burst_primary, image_flags, sharpness_score,
    video_width, video_height, video_codec, created_at, updated_at
)
SELECT
    id, icloud_id, filename, original_path, current_path, final_path, file_size, mime_type, width, height,
    duration_secs, date_taken, date_taken_source, date_taken_confidence, date_needs_review, ai_date_estimate_raw,
    content_identifier,
    CASE
      WHEN status IN ('queued','indexed','image_reviewed','video_reviewed','date_verified','grouped','filed','excluded') THEN status
      WHEN status IN ('downloading','downloaded','metadata_extracted','date_review_pending','error') THEN 'indexed'
      ELSE 'queued'
    END,
    error_message, event_group_id,
    COALESCE(burst_group_id, NULL), COALESCE(is_burst_primary, 0), COALESCE(image_flags, NULL), COALESCE(sharpness_score, NULL),
    COALESCE(video_width, NULL), COALESCE(video_height, NULL), COALESCE(video_codec, NULL), created_at, updated_at
FROM media_items_old;
DROP TABLE media_items_old;
CREATE INDEX IF NOT EXISTS idx_media_status ON media_items(status);
CREATE INDEX IF NOT EXISTS idx_media_date_review ON media_items(date_needs_review);
CREATE INDEX IF NOT EXISTS idx_media_event_group ON media_items(event_group_id);
CREATE INDEX IF NOT EXISTS idx_media_burst_group_id ON media_items(burst_group_id);
COMMIT;
        "#,
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
                 ('media_items','event_groups','audit_log','download_sessions','settings')",
                [],
                |r| r.get(0),
            )
            .expect("table count query");
        assert_eq!(table_count, 5);

        set_setting(&conn, "k", "v").expect("set setting");
        let v = get_setting(&conn, "k").expect("get setting");
        assert_eq!(v.as_deref(), Some("v"));

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn date_review_queue_reads_ai_date_payload() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");

        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, date_needs_review, ai_date_estimate_raw)
             VALUES(?1, ?2, ?3, 'image_reviewed', 1, ?4)",
            [
                "d1",
                "IMG_DATE.JPG",
                r"C:\tmp\IMG_DATE.JPG",
                r#"{"ai_date":"2026-03-10","confidence":0.88,"reasoning":"Fixture"}"#,
            ],
        )
        .expect("insert date review row");

        let queue = get_date_review_queue(&conn).expect("date review queue");
        assert_eq!(queue.len(), 1);
        let item = &queue[0];
        assert_eq!(item.ai_date.as_deref(), Some("2026-03-10"));
        assert!((item.confidence - 0.88).abs() < f64::EPSILON);
        assert_eq!(item.reasoning, "Fixture");

        drop(conn);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn refresh_event_group_item_counts_only_counts_non_excluded_items() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db init");
        conn.execute(
            "INSERT INTO event_groups(id, year, name, folder_name, item_count, user_approved) VALUES(1, 2026, 'Trip', '2026 - Trip', 0, 1)",
            [],
        )
        .expect("group");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, event_group_id, mime_type) VALUES('a', 'a.jpg', 'C:\\tmp\\a.jpg', 'grouped', 1, 'image/jpeg')",
            [],
        )
        .expect("active");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, event_group_id, mime_type) VALUES('b', 'b.jpg', 'C:\\tmp\\b.jpg', 'excluded', 1, 'image/jpeg')",
            [],
        )
        .expect("excluded");
        refresh_event_group_item_counts(&conn, &[1]).expect("refresh");
        let count: i64 = conn
            .query_row("SELECT item_count FROM event_groups WHERE id=1", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }
}

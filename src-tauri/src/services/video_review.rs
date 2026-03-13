use anyhow::{anyhow, Result};
use rusqlite::params;
use std::path::{Path, PathBuf};

use crate::{db, services::exiftool};

const VIDEO_PHASE_STATE_KEY: &str = "video_review_phase_state";

pub async fn prepare_video_review(conn: &rusqlite::Connection, root_output: &Path) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, COALESCE(current_path, ''), COALESCE(file_size, 0), duration_secs, video_width, video_height, video_codec
         FROM media_items
         WHERE mime_type LIKE 'video/%' AND status='date_verified'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<f64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;

    let mut video_count = 0_i64;
    for row in rows {
        let (id, _filename, current_path, file_size, duration, width, height, codec) = row?;
        if current_path.trim().is_empty() {
            continue;
        }
        let media_path = PathBuf::from(&current_path);
        if !media_path.exists() {
            continue;
        }
        video_count += 1;
        let meta = exiftool::read_metadata(&media_path).await?;
        let resolved_size = if file_size > 0 {
            file_size
        } else {
            std::fs::metadata(&media_path).map(|m| m.len() as i64).unwrap_or(0)
        };
        let resolved_duration = duration.or(meta.duration_secs).unwrap_or(0.0);
        let resolved_width = width.or(meta.width);
        let resolved_height = height.or(meta.height);
        let resolved_codec = codec.or(meta.video_codec);
        conn.execute(
            "UPDATE media_items
             SET file_size=?1, duration_secs=?2, video_width=?3, video_height=?4, video_codec=?5, updated_at=CURRENT_TIMESTAMP
             WHERE id=?6",
            params![resolved_size, resolved_duration, resolved_width, resolved_height, resolved_codec, id],
        )?;
        let poster_path = poster_target_path(root_output, &media_path, id);
        if !poster_path.exists() {
            if let Some(parent) = poster_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = exiftool::create_video_poster_ffmpeg(&media_path, &poster_path).await;
        }
    }

    let next_state = if video_count > 0 { "in_progress" } else { "complete" };
    db::set_setting(conn, VIDEO_PHASE_STATE_KEY, next_state)?;
    Ok(())
}

pub fn video_phase_state(conn: &rusqlite::Connection) -> Result<String> {
    Ok(db::get_setting(conn, VIDEO_PHASE_STATE_KEY)?.unwrap_or_else(|| "pending".to_string()))
}

pub fn complete_video_review(conn: &rusqlite::Connection) -> Result<()> {
    db::set_setting(conn, VIDEO_PHASE_STATE_KEY, "complete")?;
    Ok(())
}

pub fn exclude_media_items(
    conn: &mut rusqlite::Connection,
    root_output: &Path,
    media_item_ids: &[i64],
    allowed_from_statuses: &[&str],
) -> Result<usize> {
    move_media_between_statuses(
        conn,
        root_output,
        media_item_ids,
        allowed_from_statuses,
        "excluded",
        "recycle",
        "excluded",
    )
}

pub fn restore_media_items(
    conn: &mut rusqlite::Connection,
    root_output: &Path,
    media_item_ids: &[i64],
    restore_status: &str,
) -> Result<usize> {
    move_media_between_statuses(
        conn,
        root_output,
        media_item_ids,
        &["excluded"],
        restore_status,
        "staging",
        "restored",
    )
}

pub fn exclude_videos(conn: &mut rusqlite::Connection, root_output: &Path, media_item_ids: &[i64]) -> Result<usize> {
    exclude_media_items(conn, root_output, media_item_ids, &["date_verified"])
}

pub fn restore_videos(conn: &mut rusqlite::Connection, root_output: &Path, media_item_ids: &[i64]) -> Result<usize> {
    restore_media_items(conn, root_output, media_item_ids, "date_verified")
}

fn move_media_between_statuses(
    conn: &mut rusqlite::Connection,
    root_output: &Path,
    media_item_ids: &[i64],
    from_statuses: &[&str],
    to_status: &str,
    target_dir_name: &str,
    audit_action: &str,
) -> Result<usize> {
    if media_item_ids.is_empty() {
        return Ok(0);
    }
    let target_dir = root_output.join(target_dir_name);
    let _ = std::fs::create_dir_all(&target_dir);

    let mut operations: Vec<(i64, String, PathBuf, PathBuf)> = Vec::new();
    for id in media_item_ids {
        let (filename, current_path, status) = conn.query_row(
            "SELECT filename, COALESCE(current_path, ''), status
             FROM media_items WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        if !from_statuses.iter().any(|allowed| status == *allowed) {
            return Err(anyhow!("Item {id} is not in an excludable/restorable state."));
        }
        if current_path.trim().is_empty() {
            return Err(anyhow!("Item {id} has no current path."));
        }
        let source = PathBuf::from(&current_path);
        if !source.exists() {
            return Err(anyhow!("Item {id} file does not exist."));
        }
        let target = unique_target_path(&target_dir, &filename);
        operations.push((*id, status, source, target));
    }

    let mut moved_pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (_id, _status, source, target) in &operations {
        if let Err(err) = move_file(source, target) {
            for (from, to) in moved_pairs.into_iter().rev() {
                let _ = move_file(&to, &from);
            }
            return Err(err);
        }
        moved_pairs.push((source.clone(), target.clone()));
    }

    let mut touched_group_ids: Vec<i64> = Vec::new();
    for (id, _, _, _) in &operations {
        let group_id = conn
            .query_row(
                "SELECT event_group_id FROM media_items WHERE id=?1",
                [id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten();
        if let Some(group_id) = group_id {
            touched_group_ids.push(group_id);
        }
    }
    touched_group_ids.sort_unstable();
    touched_group_ids.dedup();

    let tx = conn.transaction()?;
    for (id, _status, source, target) in &operations {
        tx.execute(
            "UPDATE media_items SET current_path=?1, status=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3",
            params![target.to_string_lossy().to_string(), to_status, id],
        )?;
        tx.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value, details)
             VALUES(?1, ?2, 'user', ?3, ?4)",
            params![
                id,
                audit_action,
                target.to_string_lossy().to_string(),
                format!("{{\"from\":\"{}\",\"to\":\"{}\"}}", source.to_string_lossy(), target.to_string_lossy())
            ],
        )?;
    }

    db::refresh_event_group_item_counts(&tx, touched_group_ids.as_slice())?;
    tx.commit()?;
    Ok(operations.len())
}

fn move_file(source: &Path, target: &Path) -> Result<()> {
    if std::fs::rename(source, target).is_err() {
        std::fs::copy(source, target)?;
        std::fs::remove_file(source)?;
    }
    Ok(())
}

fn unique_target_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = Path::new(filename).extension().and_then(|s| s.to_str()).unwrap_or("");
    for n in 1..10_000 {
        let next = if ext.is_empty() {
            dir.join(format!("{stem}_{n}"))
        } else {
            dir.join(format!("{stem}_{n}.{ext}"))
        };
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}_overflow"))
}

fn poster_target_path(root_output: &Path, media_path: &Path, media_item_id: i64) -> PathBuf {
    if let Some(parent) = media_path.parent() {
        return parent.join(".thumbnails").join(format!("{media_item_id}.jpg"));
    }
    root_output
        .join("staging")
        .join(".thumbnails")
        .join(format!("{media_item_id}.jpg"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::params;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-video-review-test-{}.db", rand::random::<u64>()));
        p
    }

    #[test]
    fn exclude_and_restore_moves_files_and_writes_audit_rows() {
        let db_path = temp_db_path();
        let mut conn = init_db(&db_path).expect("db");
        let root = std::env::temp_dir().join(format!("memoria-video-root-{}", rand::random::<u64>()));
        let staging = root.join("staging");
        let recycle = root.join("recycle");
        std::fs::create_dir_all(&staging).expect("staging");
        std::fs::create_dir_all(&recycle).expect("recycle");
        let src = staging.join("sample.mov");
        std::fs::write(&src, b"video").expect("video");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, date_taken)
             VALUES(?1, ?2, ?3, 'date_verified', 'video/quicktime', '2026-03-11')",
            params!["v1", "sample.mov", src.to_string_lossy().to_string()],
        )
        .expect("insert");
        let id = conn.last_insert_rowid();

        let excluded = exclude_videos(&mut conn, &root, &[id]).expect("exclude");
        assert_eq!(excluded, 1);
        let (status, path): (String, String) = conn
            .query_row("SELECT status, current_path FROM media_items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("excluded row");
        assert_eq!(status, "excluded");
        assert!(path.contains("recycle"));

        let restored = restore_videos(&mut conn, &root, &[id]).expect("restore");
        assert_eq!(restored, 1);
        let (status2, path2): (String, String) = conn
            .query_row("SELECT status, current_path FROM media_items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("restored row");
        assert_eq!(status2, "date_verified");
        assert!(path2.contains("staging"));

        let excluded_audit_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE media_item_id=?1 AND action='excluded'",
                [id],
                |r| r.get(0),
            )
            .expect("excluded audit count");
        let restored_audit_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE media_item_id=?1 AND action='restored'",
                [id],
                |r| r.get(0),
            )
            .expect("restored audit count");
        assert_eq!(excluded_audit_count, 1);
        assert_eq!(restored_audit_count, 1);
    }

    #[test]
    fn complete_video_review_sets_phase_state() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("db");
        complete_video_review(&conn).expect("complete");
        let state = video_phase_state(&conn).expect("state");
        assert_eq!(state, "complete");
    }

    #[test]
    fn bulk_exclude_rollback_keeps_db_unchanged_on_partial_failure() {
        let db_path = temp_db_path();
        let mut conn = init_db(&db_path).expect("db");
        let root = std::env::temp_dir().join(format!("memoria-video-rollback-{}", rand::random::<u64>()));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("staging");
        let source_ok = staging.join("ok.jpg");
        std::fs::write(&source_ok, b"ok").expect("ok file");
        conn.execute(
            "INSERT INTO event_groups(id, year, name, folder_name, item_count, user_approved) VALUES(1, 2026, 'Group', '2026 - Group', 0, 1)",
            [],
        )
        .expect("group");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, event_group_id)
             VALUES(?1, ?2, ?3, 'grouped', 'image/jpeg', 1)",
            params!["ok", "ok.jpg", source_ok.to_string_lossy().to_string()],
        )
        .expect("ok insert");
        let ok_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, event_group_id)
             VALUES(?1, ?2, ?3, 'grouped', 'image/jpeg', 1)",
            params!["missing", "missing.jpg", "C:\\missing\\missing.jpg"],
        )
        .expect("missing insert");
        let missing_id = conn.last_insert_rowid();

        let result = exclude_media_items(&mut conn, &root, &[ok_id, missing_id], &["grouped"]);
        assert!(result.is_err());
        let ok_status: String = conn
            .query_row("SELECT status FROM media_items WHERE id=?1", [ok_id], |r| r.get(0))
            .expect("ok status");
        assert_eq!(ok_status, "grouped");
        assert!(source_ok.exists());
    }
}

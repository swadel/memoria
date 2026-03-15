use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use tokio::fs;

use super::runtime_log;

pub async fn finalize(conn: &Connection, base_output_dir: &str, app_handle: Option<&tauri::AppHandle>) -> Result<()> {
    runtime_log::info(
        "file_organizer",
        format!("Starting finalize to output root '{}'.", base_output_dir),
    );
    let mut stmt = conn.prepare(
        "SELECT m.id, m.filename, m.current_path, e.year, e.folder_name
         FROM media_items m
         JOIN event_groups e ON m.event_group_id = e.id
         WHERE m.status='grouped'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let all_rows: Vec<_> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let total = all_rows.len();
    runtime_log::emit_pipeline_progress(app_handle, "finalize", "Starting finalization...", 0, total);

    let mut filed_count = 0_i64;
    for (idx, row) in all_rows.into_iter().enumerate() {
        let (id, filename, current_path, year, folder_name) = row;
        let target_dir = PathBuf::from(base_output_dir)
            .join("organized")
            .join(year.to_string())
            .join(folder_name);
        fs::create_dir_all(&target_dir).await?;
        let mut final_path = target_dir.join(&filename);
        if final_path.exists() {
            final_path = target_dir.join(format!("{}_{}", id, filename));
        }
        fs::copy(windows_long_path(&current_path), windows_long_path(final_path.as_path())).await?;
        conn.execute(
            "UPDATE media_items SET final_path=?1, current_path=?2, status='filed', updated_at=CURRENT_TIMESTAMP WHERE id=?3",
            params![final_path.to_string_lossy().to_string(), final_path.to_string_lossy().to_string(), id],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value) VALUES(?1, 'filed', 'system', ?2)",
            params![id, final_path.to_string_lossy().to_string()],
        )?;
        filed_count += 1;
        runtime_log::emit_pipeline_progress(
            app_handle,
            "finalize",
            &format!("Filed: {filename}"),
            idx + 1,
            total,
        );
        runtime_log::info(
            "file_organizer",
            format!(
                "Filed media id={id} filename='{}' to '{}'.",
                filename,
                final_path.to_string_lossy()
            ),
        );
    }
    runtime_log::info("file_organizer", format!("Finalize complete. filed_count={filed_count}."));
    Ok(())
}

fn windows_long_path<P: AsRef<Path>>(path: P) -> PathBuf {
    let p = path.as_ref();
    let s = p.to_string_lossy();
    if cfg!(target_os = "windows") && s.len() > 240 && !s.starts_with(r"\\?\") {
        return PathBuf::from(format!(r"\\?\{s}"));
    }
    p.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::windows_long_path;
    use crate::db::init_db;
    use rusqlite::params;
    use std::path::PathBuf;

    #[test]
    fn windows_long_path_preserves_normal_path() {
        let input = PathBuf::from(r"C:\Memoria\organized\2026");
        let out = windows_long_path(&input);
        if cfg!(target_os = "windows") {
            assert!(out.to_string_lossy().contains(r"C:\Memoria\organized\2026"));
        } else {
            assert_eq!(out, input);
        }
    }

    #[tokio::test]
    async fn finalize_with_none_handle_emits_no_progress_and_succeeds_on_empty_db() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-finalize-empty-{}.db", rand::random::<u64>()));
        let conn = init_db(&db_path).expect("db");
        let output_root = std::env::temp_dir()
            .join(format!("memoria-finalize-root-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&output_root).expect("root");

        super::finalize(&conn, output_root.to_str().unwrap_or(""), None)
            .await
            .expect("finalize succeeds on empty DB");

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_dir_all(&output_root);
    }

    #[tokio::test]
    async fn finalize_copies_grouped_items_to_organized_folder() {
        let mut db_path = std::env::temp_dir();
        db_path.push(format!("memoria-finalize-test-{}.db", rand::random::<u64>()));
        let conn = init_db(&db_path).expect("db");
        let root = std::env::temp_dir()
            .join(format!("memoria-finalize-assets-{}", rand::random::<u64>()));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("staging");

        let src = staging.join("photo.jpg");
        std::fs::write(&src, b"fake-jpeg").expect("write");

        conn.execute(
            "INSERT INTO event_groups(id, year, name, folder_name, item_count, user_approved)
             VALUES(1, 2026, 'Beach Trip', '2026 - Beach Trip', 1, 1)",
            [],
        ).expect("group");
        conn.execute(
            "INSERT INTO media_items(icloud_id, filename, current_path, status, mime_type, event_group_id)
             VALUES(?1, ?2, ?3, 'grouped', 'image/jpeg', 1)",
            params!["f1", "photo.jpg", src.to_string_lossy().to_string()],
        ).expect("media");

        super::finalize(&conn, root.to_str().unwrap_or(""), None)
            .await
            .expect("finalize succeeds");

        let organized = root.join("organized").join("2026").join("2026 - Beach Trip").join("photo.jpg");
        assert!(organized.exists(), "photo should be in organized folder");

        let status: String = conn
            .query_row("SELECT status FROM media_items WHERE icloud_id='f1'", [], |r| r.get(0))
            .expect("status");
        assert_eq!(status, "filed");

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_dir_all(&root);
    }
}

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::runtime_log;

/// Maximum number of concurrent file copy operations.
const COPY_CONCURRENCY: usize = 8;

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

    if total == 0 {
        runtime_log::info("file_organizer", "Finalize complete. filed_count=0.".to_string());
        return Ok(());
    }

    // Phase 1: Compute target paths and create directories (sequential, fast)
    let mut copy_tasks: Vec<(i64, String, PathBuf, PathBuf)> = Vec::with_capacity(total);
    for (id, filename, current_path, year, folder_name) in &all_rows {
        let target_dir = PathBuf::from(base_output_dir)
            .join("organized")
            .join(year.to_string())
            .join(folder_name);
        fs::create_dir_all(&target_dir).await?;
        let mut final_path = target_dir.join(filename);
        if final_path.exists() {
            final_path = target_dir.join(format!("{}_{}", id, filename));
        }
        copy_tasks.push((*id, filename.clone(), PathBuf::from(current_path), final_path));
    }

    // Phase 2: Parallel file copies with bounded concurrency
    let semaphore = Arc::new(Semaphore::new(COPY_CONCURRENCY));
    let mut join_set = JoinSet::new();
    let progress_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app_handle_clone = app_handle.cloned();
    let total_for_progress = total;

    for (id, filename, source, target) in copy_tasks {
        let sem = semaphore.clone();
        let progress = progress_counter.clone();
        let ah = app_handle_clone.clone();

        join_set.spawn(async move {
            let _permit = sem.acquire().await.map_err(|e| anyhow::anyhow!("{}", e))?;
            fs::copy(windows_long_path(&source), windows_long_path(&target)).await?;
            let done = progress.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            runtime_log::emit_pipeline_progress(
                ah.as_ref(),
                "finalize",
                &format!("Filed: {filename}"),
                done,
                total_for_progress,
            );
            runtime_log::info(
                "file_organizer",
                format!(
                    "Filed media id={id} filename='{}' to '{}'.",
                    filename,
                    target.to_string_lossy()
                ),
            );
            Ok::<(i64, PathBuf), anyhow::Error>((id, target))
        });
    }

    // Collect results from parallel copies
    let mut filed_results: Vec<(i64, PathBuf)> = Vec::with_capacity(total);
    while let Some(result) = join_set.join_next().await {
        filed_results.push(result??);
    }

    // Phase 3: Batch DB updates (sequential, must be on same thread as conn)
    for (id, final_path) in &filed_results {
        let path_str = final_path.to_string_lossy().to_string();
        conn.execute(
            "UPDATE media_items SET final_path=?1, current_path=?2, status='filed', updated_at=CURRENT_TIMESTAMP WHERE id=?3",
            params![path_str, path_str, id],
        )?;
        conn.execute(
            "INSERT INTO audit_log(media_item_id, action, source, new_value) VALUES(?1, 'filed', 'system', ?2)",
            params![id, path_str],
        )?;
    }

    let filed_count = filed_results.len();
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

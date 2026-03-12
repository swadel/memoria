use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use tokio::fs;

pub async fn finalize(conn: &Connection, base_output_dir: &str) -> Result<()> {
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

    for row in rows {
        let (id, filename, current_path, year, folder_name) = row?;
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
    }
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
}

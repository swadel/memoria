use anyhow::Result;
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

use super::ai_client::AiClient;

pub async fn run(conn: &Connection, ai: &AiClient) -> Result<()> {
    conn.execute("DELETE FROM event_groups", [])?;
    conn.execute("UPDATE media_items SET event_group_id=NULL WHERE status='date_verified'", [])?;

    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(date_taken, ''), filename, COALESCE(current_path, '')
         FROM media_items
         WHERE status='date_verified' AND (date_needs_review=0 OR date_needs_review IS NULL)",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut by_year: BTreeMap<i32, Vec<(i64, NaiveDate, String, String)>> = BTreeMap::new();
    for row in rows {
        let (id, date_raw, filename, current_path) = row?;
        if let Ok(d) = NaiveDate::parse_from_str(&date_raw, "%Y-%m-%d") {
            by_year
                .entry(d.year())
                .or_default()
                .push((id, d, filename, current_path));
        }
    }

    for (year, mut items) in by_year {
        items.sort_by_key(|(_, d, _, _)| *d);
        let clusters = cluster_by_days(items, 3);
        for cluster in clusters {
            let is_misc = cluster.len() < 3;
            let proposed_name = if is_misc {
                format!("{year} - Misc")
            } else if is_holiday_cluster(&cluster) {
                format!("{year} - Family Christmas")
            } else {
                ai.suggest_event_name(year, cluster.len()).await?.name
            };
            let simple_name = proposed_name
                .strip_prefix(&format!("{year} - "))
                .unwrap_or(&proposed_name)
                .to_string();
            conn.execute(
                "INSERT INTO event_groups(year, name, folder_name, ai_suggested_name, is_misc, user_approved, item_count, start_date, end_date)
                 VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)",
                params![
                    year,
                    simple_name,
                    proposed_name,
                    proposed_name,
                    if is_misc { 1 } else { 0 },
                    cluster.len() as i64,
                    cluster.first().map(|x| x.1.to_string()),
                    cluster.last().map(|x| x.1.to_string())
                ],
            )?;
            let group_id = conn.last_insert_rowid();
            for (id, _, _, _) in cluster {
                conn.execute(
                    "UPDATE media_items SET event_group_id=?1, status='grouped', updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![group_id, id],
                )?;
            }
        }
    }
    Ok(())
}

fn is_holiday_cluster(items: &[(i64, NaiveDate, String, String)]) -> bool {
    items
        .iter()
        .any(|(_, d, _, _)| d.month() == 12 && d.day() >= 20 && d.day() <= 31)
}

fn cluster_by_days(
    sorted_items: Vec<(i64, NaiveDate, String, String)>,
    max_gap_days: i64,
) -> Vec<Vec<(i64, NaiveDate, String, String)>> {
    if sorted_items.is_empty() {
        return vec![];
    }
    let mut clusters: Vec<Vec<(i64, NaiveDate, String, String)>> = vec![];
    let mut current: Vec<(i64, NaiveDate, String, String)> = vec![sorted_items[0].clone()];

    for item in sorted_items.iter().skip(1) {
        let prev = current.last().expect("cluster not empty");
        let gap = (item.1 - prev.1).num_days();
        if gap <= max_gap_days {
            current.push(item.clone());
        } else {
            clusters.push(current);
            current = vec![item.clone()];
        }
    }
    clusters.push(current);
    clusters
}

#[cfg(test)]
mod tests {
    use super::{cluster_by_days, is_holiday_cluster};
    use chrono::NaiveDate;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("valid date")
    }

    #[test]
    fn clusters_split_when_gap_exceeds_threshold() {
        let items = vec![
            (1, d("2025-07-01"), "a.jpg".to_string(), "a".to_string()),
            (2, d("2025-07-02"), "b.jpg".to_string(), "b".to_string()),
            (3, d("2025-07-10"), "c.jpg".to_string(), "c".to_string()),
        ];
        let clusters = cluster_by_days(items, 3);
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0].len(), 2);
        assert_eq!(clusters[1].len(), 1);
    }

    #[test]
    fn holiday_cluster_detects_christmas_window() {
        let cluster = vec![
            (1, d("2025-12-24"), "x.jpg".to_string(), "x".to_string()),
            (2, d("2025-12-26"), "y.jpg".to_string(), "y".to_string()),
        ];
        assert!(is_holiday_cluster(&cluster));
    }
}

use anyhow::Result;
use keyring::Entry;
use rusqlite::Connection;

use crate::db;

fn db_secret_key(key: &str) -> String {
    format!("secret_{key}")
}

pub fn set_secret(key: &str, value: &str) -> Result<()> {
    let entry = Entry::new("memoria", key)?;
    entry.set_password(value)?;
    Ok(())
}

pub fn get_secret(key: &str) -> Result<Option<String>> {
    let entry = Entry::new("memoria", key)?;
    let value = entry.get_password();
    match value {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_secret_with_fallback(conn: &Connection, key: &str, value: &str) -> Result<()> {
    // Best effort keychain write; do not fail if platform keychain access fails.
    let _ = set_secret(key, value);
    db::set_setting(conn, db_secret_key(key).as_str(), value)?;
    Ok(())
}

pub fn get_secret_with_fallback(conn: &Connection, key: &str) -> Result<Option<String>> {
    // Prefer keychain, but if keychain is inaccessible, use DB fallback.
    match get_secret(key) {
        Ok(Some(v)) if !v.trim().is_empty() => Ok(Some(v)),
        Ok(_) => db::get_setting(conn, db_secret_key(key).as_str()),
        Err(_) => db::get_setting(conn, db_secret_key(key).as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::{get_secret_with_fallback, set_secret_with_fallback};
    use crate::db::init_db;
    use std::fs;

    fn temp_db_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memoria-settings-test-{}.db", rand::random::<u64>()));
        p
    }

    #[test]
    fn fallback_roundtrip_for_all_secret_settings() {
        let db_path = temp_db_path();
        let conn = init_db(&db_path).expect("init db");

        let pairs = [
            ("icloud_username", "user@example.com"),
            ("icloud_password", "secret-pass"),
            ("openai_api_key", "sk-test"),
            ("icloud_2fa_code", "123456"),
        ];

        for (k, v) in pairs {
            set_secret_with_fallback(&conn, k, v).expect("set fallback secret");
            let out = get_secret_with_fallback(&conn, k).expect("get fallback secret");
            assert_eq!(out.as_deref(), Some(v));
        }

        drop(conn);
        let _ = fs::remove_file(db_path);
    }
}

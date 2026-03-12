use anyhow::Result;
use keyring::Entry;

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

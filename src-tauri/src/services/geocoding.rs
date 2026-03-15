use anyhow::Result;
use reqwest::Client;
use rusqlite::Connection;
use std::collections::HashMap;
use tokio::time::{Duration, Instant};

use super::runtime_log;

pub const NOMINATIM_REVERSE_URL: &str = "https://nominatim.openstreetmap.org/reverse";
pub const NOMINATIM_SEARCH_URL: &str = "https://nominatim.openstreetmap.org/search";
pub const NOMINATIM_USER_AGENT: &str = "Memoria/1.0 (photo organizer app)";
pub const NOMINATIM_MIN_REQUEST_INTERVAL_MS: u64 = 1100;

pub struct ReverseGeocoder {
    cache: HashMap<String, Option<(String, String)>>,
    last_request_at: Option<Instant>,
    min_interval: Duration,
}

impl ReverseGeocoder {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
            last_request_at: None,
            min_interval: Duration::from_millis(NOMINATIM_MIN_REQUEST_INTERVAL_MS),
        }
    }

    #[cfg(test)]
    pub fn with_min_interval(min_interval: Duration) -> Self {
        Self {
            cache: HashMap::new(),
            last_request_at: None,
            min_interval,
        }
    }

    /// Load persistent cache entries from the `geocode_cache` DB table into memory.
    pub fn load_persistent_cache(&mut self, conn: &Connection) {
        let mut stmt = match conn.prepare("SELECT coord_key, city, country FROM geocode_cache") {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }) {
            Ok(r) => r,
            Err(_) => return,
        };
        for row in rows.flatten() {
            let (key, city, country) = row;
            let value = match (city, country) {
                (Some(c), Some(co)) if !c.is_empty() && !co.is_empty() => Some((c, co)),
                _ => None,
            };
            self.cache.insert(key, value);
        }
    }

    pub async fn reverse_geocode(
        &mut self,
        http: &Client,
        conn: Option<&Connection>,
        latitude: f64,
        longitude: f64,
    ) -> Result<Option<(String, String)>> {
        self.reverse_geocode_with_transport(conn, latitude, longitude, |lat, lon| async move {
            reverse_geocode_nominatim(http, lat, lon).await
        })
        .await
    }

    pub async fn reverse_geocode_with_transport<F, Fut>(
        &mut self,
        conn: Option<&Connection>,
        latitude: f64,
        longitude: f64,
        transport: F,
    ) -> Result<Option<(String, String)>>
    where
        F: FnOnce(f64, f64) -> Fut,
        Fut: std::future::Future<Output = Result<Option<(String, String)>>>,
    {
        let key = geocode_cache_key(latitude, longitude);
        if let Some(cached) = self.cache.get(&key) {
            return Ok(cached.clone());
        }
        self.enforce_rate_limit().await;
        let value = transport(latitude, longitude).await?;
        self.cache.insert(key.clone(), value.clone());
        if let Some(db) = conn {
            persist_geocode_cache_entry(db, &key, &value);
        }
        Ok(value)
    }

    async fn enforce_rate_limit(&mut self) {
        if let Some(last_request_at) = self.last_request_at {
            let elapsed = last_request_at.elapsed();
            if elapsed < self.min_interval {
                tokio::time::sleep(self.min_interval - elapsed).await;
            }
        }
        self.last_request_at = Some(Instant::now());
    }
}

pub fn geocode_cache_key(latitude: f64, longitude: f64) -> String {
    format!("{latitude:.2}:{longitude:.2}")
}

fn persist_geocode_cache_entry(conn: &Connection, key: &str, value: &Option<(String, String)>) {
    let (city, country) = match value {
        Some((c, co)) => (Some(c.as_str()), Some(co.as_str())),
        None => (None::<&str>, None::<&str>),
    };
    let _ = conn.execute(
        "INSERT OR IGNORE INTO geocode_cache(coord_key, city, country) VALUES(?1, ?2, ?3)",
        rusqlite::params![key, city, country],
    );
}

pub fn build_nominatim_reverse_request(
    http: &Client,
    latitude: f64,
    longitude: f64,
) -> Result<reqwest::Request> {
    Ok(http
        .get(NOMINATIM_REVERSE_URL)
        .query(&[
            ("lat", latitude.to_string()),
            ("lon", longitude.to_string()),
            ("format", "json".to_string()),
        ])
        .header("User-Agent", NOMINATIM_USER_AGENT)
        .build()?)
}

pub async fn reverse_geocode_nominatim(
    http: &Client,
    latitude: f64,
    longitude: f64,
) -> Result<Option<(String, String)>> {
    let request = build_nominatim_reverse_request(http, latitude, longitude)?;
    let value = http
        .execute(request)
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    Ok(extract_city_country(&value))
}

pub fn extract_city_country(value: &serde_json::Value) -> Option<(String, String)> {
    if let Some(result) = value
        .get("results")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
    {
        let city = result
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let country = result
            .get("country")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !city.is_empty() && !country.is_empty() {
            return Some((city, country));
        }
    }

    let city = value
        .get("address")
        .and_then(|x| {
            x.get("city")
                .or_else(|| x.get("town"))
                .or_else(|| x.get("village"))
        })
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let country = value
        .get("address")
        .and_then(|x| x.get("country"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !city.is_empty() && !country.is_empty() {
        return Some((city, country));
    }
    None
}

pub fn location_hint_from_geocode_result(
    lat: f64,
    lon: f64,
    result: Result<Option<(String, String)>>,
) -> Option<String> {
    match result {
        Ok(Some((city, country))) => Some(format!(
            "GPS data suggests these photos were taken in: {city}, {country}"
        )),
        Ok(None) => None,
        Err(err) => {
            runtime_log::warn(
                "geocoding",
                format!("Reverse geocoding failed for ({lat}, {lon}): {err}"),
            );
            None
        }
    }
}

pub async fn forward_geocode_nominatim(
    http: &Client,
    query: &str,
) -> Result<Option<(f64, f64, String)>> {
    let request = http
        .get(NOMINATIM_SEARCH_URL)
        .query(&[
            ("q", query.to_string()),
            ("format", "json".to_string()),
            ("limit", "1".to_string()),
        ])
        .header("User-Agent", NOMINATIM_USER_AGENT)
        .build()?;
    let results = http
        .execute(request)
        .await?
        .error_for_status()?
        .json::<Vec<serde_json::Value>>()
        .await?;
    let first = match results.first() {
        Some(v) => v,
        None => return Ok(None),
    };
    let lat = first
        .get("lat")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok());
    let lon = first
        .get("lon")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok());
    let display_name = first
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match (lat, lon) {
        (Some(lat), Some(lon)) => Ok(Some((lat, lon, display_name))),
        _ => Ok(None),
    }
}

/// Haversine formula: distance in miles between two (lat, lon) points.
pub fn haversine_distance_miles(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_MILES: f64 = 3958.8;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let lat1_r = lat1.to_radians();
    let lat2_r = lat2.to_radians();
    let a = (d_lat / 2.0).sin().powi(2) + lat1_r.cos() * lat2_r.cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    EARTH_RADIUS_MILES * c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haversine_known_distance() {
        let nyc = (40.7128, -74.0060);
        let la = (34.0522, -118.2437);
        let dist = haversine_distance_miles(nyc.0, nyc.1, la.0, la.1);
        assert!((dist - 2451.0).abs() < 10.0, "NYC to LA should be ~2451 mi, got {dist}");
    }

    #[test]
    fn haversine_same_point_is_zero() {
        let dist = haversine_distance_miles(36.1627, -86.7816, 36.1627, -86.7816);
        assert!(dist.abs() < 0.001);
    }

    #[test]
    fn haversine_short_distance() {
        let nashville = (36.1627, -86.7816);
        let murfreesboro = (35.8456, -86.3903);
        let dist = haversine_distance_miles(nashville.0, nashville.1, murfreesboro.0, murfreesboro.1);
        assert!((dist - 30.0).abs() < 5.0, "Nashville to Murfreesboro should be ~30 mi, got {dist}");
    }

    #[test]
    fn geocode_cache_key_rounds_to_two_decimals() {
        assert_eq!(geocode_cache_key(36.1627, -86.7816), "36.16:-86.78");
        assert_eq!(geocode_cache_key(36.169, -86.785), "36.17:-86.78");
    }

    #[test]
    fn extract_city_country_from_address_block() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"address":{"city":"Nashville","country":"United States"}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_city_country(&json),
            Some(("Nashville".to_string(), "United States".to_string()))
        );
    }

    #[test]
    fn extract_city_country_from_town() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"address":{"town":"Franklin","country":"United States"}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_city_country(&json),
            Some(("Franklin".to_string(), "United States".to_string()))
        );
    }

    #[test]
    fn extract_city_country_returns_none_if_missing() {
        let json: serde_json::Value = serde_json::from_str(r#"{"address":{}}"#).unwrap();
        assert_eq!(extract_city_country(&json), None);
    }

    #[test]
    fn forward_geocode_result_parsing() {
        // Verifies the shape we expect from Nominatim search API
        let results: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"lat":"36.1627","lon":"-86.7816","display_name":"Nashville, TN, USA"}]"#,
        )
        .unwrap();
        let first = results.first().unwrap();
        let lat = first.get("lat").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
        let lon = first.get("lon").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
        assert!((lat.unwrap() - 36.1627).abs() < 0.001);
        assert!((lon.unwrap() - (-86.7816)).abs() < 0.001);
    }

    #[test]
    fn persistent_cache_roundtrip() {
        let db_path = {
            let mut p = std::env::temp_dir();
            p.push(format!("memoria-geocode-cache-test-{}.db", rand::random::<u64>()));
            p
        };
        let conn = crate::db::init_db(&db_path).expect("init db");
        let key = "36.16:-86.78";
        let value = Some(("Nashville".to_string(), "United States".to_string()));
        persist_geocode_cache_entry(&conn, key, &value);

        let mut geocoder = ReverseGeocoder::new();
        geocoder.load_persistent_cache(&conn);
        assert_eq!(
            geocoder.cache.get(key).cloned().flatten(),
            Some(("Nashville".to_string(), "United States".to_string()))
        );
        drop(conn);
        let _ = std::fs::remove_file(db_path);
    }
}

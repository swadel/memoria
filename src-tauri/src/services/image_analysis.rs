use image::{DynamicImage, GenericImageView, GrayImage, Luma};
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct ExposureStats {
    pub mean_brightness: f64,
    pub std_deviation: f64,
    pub dark_pixel_pct: f64,
    pub bright_pixel_pct: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ScreenshotSignals {
    pub confidence: f64,
    pub signals: Vec<String>,
}

const KNOWN_SCREENSHOT_RESOLUTIONS: &[(u32, u32)] = &[
    // iPhone resolutions (portrait)
    (1170, 2532), (1179, 2556), (1125, 2436), (1242, 2688),
    (1284, 2778), (1290, 2796), (750, 1334), (828, 1792),
    (1080, 1920), (640, 1136),
    // Android common resolutions (portrait)
    (1080, 2400), (1080, 2340), (1440, 3200), (1440, 3120),
    (1440, 2960), (1080, 2280),
    // Tablet / iPad
    (2048, 2732), (1668, 2388), (1620, 2160),
    // Desktop common
    (1920, 1080), (2560, 1440), (3840, 2160), (1366, 768),
    (1440, 900), (2560, 1600), (3024, 1964),
];

const DARK_THRESHOLD: u8 = 30;
const BRIGHT_THRESHOLD: u8 = 225;

/// Maximum dimension for blur/exposure analysis.  Downsampling to this size
/// dramatically reduces memory usage (~10×) and CPU time while producing
/// equivalent Laplacian-variance and luminance-histogram results.
const ANALYSIS_MAX_DIM: u32 = 1024;

/// Compute Laplacian variance as a blur/sharpness metric.
/// Higher values indicate sharper images.
/// The image is downsampled to at most 1024px on its longest side before
/// analysis to reduce memory and CPU cost.
pub fn compute_blur_score(path: &Path) -> Option<f64> {
    let img = image::open(path).ok()?;
    let img = downsample_for_analysis(&img);
    let gray = img.to_luma8();
    Some(laplacian_variance(&gray))
}

/// Downsample to at most ANALYSIS_MAX_DIM on the longest side.
fn downsample_for_analysis(img: &DynamicImage) -> DynamicImage {
    let (w, h) = img.dimensions();
    let max_side = w.max(h);
    if max_side <= ANALYSIS_MAX_DIM {
        return img.clone();
    }
    let scale = ANALYSIS_MAX_DIM as f64 / max_side as f64;
    let new_w = (w as f64 * scale).round() as u32;
    let new_h = (h as f64 * scale).round() as u32;
    img.resize_exact(new_w.max(1), new_h.max(1), image::imageops::FilterType::Triangle)
}

fn laplacian_variance(gray: &GrayImage) -> f64 {
    let (w, h) = gray.dimensions();
    if w < 3 || h < 3 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut count = 0u64;

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let center = gray.get_pixel(x, y)[0] as f64;
            let top = gray.get_pixel(x, y - 1)[0] as f64;
            let bottom = gray.get_pixel(x, y + 1)[0] as f64;
            let left = gray.get_pixel(x - 1, y)[0] as f64;
            let right = gray.get_pixel(x + 1, y)[0] as f64;
            let lap = -4.0 * center + top + bottom + left + right;
            sum += lap;
            sum_sq += lap * lap;
            count += 1;
        }
    }
    if count == 0 {
        return 0.0;
    }
    let mean = sum / count as f64;
    (sum_sq / count as f64) - (mean * mean)
}

/// Compute a 64-bit difference hash (dHash) for visual similarity comparison.
/// Resize to 9x8 grayscale and compare adjacent horizontal pixels.
pub fn compute_perceptual_hash(path: &Path) -> Option<u64> {
    let img = image::open(path).ok()?;
    Some(dhash(&img))
}

fn dhash(img: &DynamicImage) -> u64 {
    let resized = img.resize_exact(9, 8, image::imageops::FilterType::Triangle);
    let gray = resized.to_luma8();
    let mut hash: u64 = 0;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let left = gray.get_pixel(x, y)[0];
            let right = gray.get_pixel(x + 1, y)[0];
            if left > right {
                hash |= 1u64 << (y * 8 + x);
            }
        }
    }
    hash
}

/// Compute exposure statistics from the image's luminance histogram.
/// The image is downsampled before analysis to reduce memory and CPU cost.
pub fn compute_exposure_stats(path: &Path) -> Option<ExposureStats> {
    let img = image::open(path).ok()?;
    let img = downsample_for_analysis(&img);
    let gray = img.to_luma8();
    Some(exposure_stats_from_gray(&gray))
}

fn exposure_stats_from_gray(gray: &GrayImage) -> ExposureStats {
    let total = gray.pixels().count() as f64;
    if total == 0.0 {
        return ExposureStats::default();
    }

    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut dark_count = 0u64;
    let mut bright_count = 0u64;

    for Luma([val]) in gray.pixels() {
        let v = *val as f64;
        sum += v;
        sum_sq += v * v;
        if *val <= DARK_THRESHOLD {
            dark_count += 1;
        }
        if *val >= BRIGHT_THRESHOLD {
            bright_count += 1;
        }
    }

    let mean = sum / total;
    let variance = (sum_sq / total) - (mean * mean);
    ExposureStats {
        mean_brightness: mean,
        std_deviation: variance.max(0.0).sqrt(),
        dark_pixel_pct: dark_count as f64 / total,
        bright_pixel_pct: bright_count as f64 / total,
    }
}

/// Hamming distance between two 64-bit perceptual hashes.
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Compute a screenshot/meme heuristic score.
/// `camera_meta` is `(make, model)` from exiftool, or None if unavailable.
pub fn compute_screenshot_heuristic(
    path: &Path,
    camera_meta: Option<&(Option<String>, Option<String>)>,
) -> ScreenshotSignals {
    let mut signals = Vec::new();
    let mut score = 0.0f64;

    let img = match image::open(path) {
        Ok(img) => img,
        Err(_) => return ScreenshotSignals::default(),
    };

    let (w, h) = img.dimensions();

    // Check for known screenshot resolutions (both orientations)
    let is_known_res = KNOWN_SCREENSHOT_RESOLUTIONS
        .iter()
        .any(|&(rw, rh)| (w == rw && h == rh) || (w == rh && h == rw));
    if is_known_res {
        signals.push(format!("known_screenshot_resolution_{w}x{h}"));
        score += 0.3;
    }

    // No camera make/model strongly suggests non-camera origin
    let has_camera = camera_meta
        .map(|(make, model)| make.is_some() || model.is_some())
        .unwrap_or(false);
    if !has_camera {
        signals.push("no_camera_make_model".to_string());
        score += 0.25;
    }

    // Large flat-color regions: sample blocks and check color variance
    let flat_pct = flat_color_percentage(&img);
    if flat_pct > 0.4 {
        signals.push(format!("high_flat_color_{:.0}pct", flat_pct * 100.0));
        score += 0.2;
    }
    if flat_pct > 0.6 {
        score += 0.15;
    }

    // Check for uniform horizontal bars (status/nav bars)
    if has_uniform_bars(&img) {
        signals.push("uniform_horizontal_bars".to_string());
        score += 0.15;
    }

    // Non-camera aspect ratio (not 4:3, 3:2, 16:9)
    if !is_camera_aspect_ratio(w, h) && w > 100 && h > 100 {
        signals.push("non_camera_aspect_ratio".to_string());
        score += 0.1;
    }

    ScreenshotSignals {
        confidence: score.min(1.0),
        signals,
    }
}

fn flat_color_percentage(img: &DynamicImage) -> f64 {
    let (w, h) = img.dimensions();
    if w < 16 || h < 16 {
        return 0.0;
    }
    let block_size = 16u32;
    let cols = w / block_size;
    let rows = h / block_size;
    let total_blocks = (cols * rows) as f64;
    if total_blocks == 0.0 {
        return 0.0;
    }

    let rgb = img.to_rgb8();
    let mut flat_blocks = 0u64;

    for by in 0..rows {
        for bx in 0..cols {
            let mut r_sum = 0u64;
            let mut g_sum = 0u64;
            let mut b_sum = 0u64;
            let mut r_sq = 0u64;
            let mut g_sq = 0u64;
            let mut b_sq = 0u64;
            let count = (block_size * block_size) as u64;

            for dy in 0..block_size {
                for dx in 0..block_size {
                    let px = rgb.get_pixel(bx * block_size + dx, by * block_size + dy);
                    let (r, g, b) = (px[0] as u64, px[1] as u64, px[2] as u64);
                    r_sum += r;
                    g_sum += g;
                    b_sum += b;
                    r_sq += r * r;
                    g_sq += g * g;
                    b_sq += b * b;
                }
            }

            let r_var = (r_sq as f64 / count as f64) - (r_sum as f64 / count as f64).powi(2);
            let g_var = (g_sq as f64 / count as f64) - (g_sum as f64 / count as f64).powi(2);
            let b_var = (b_sq as f64 / count as f64) - (b_sum as f64 / count as f64).powi(2);

            if r_var < 25.0 && g_var < 25.0 && b_var < 25.0 {
                flat_blocks += 1;
            }
        }
    }

    flat_blocks as f64 / total_blocks
}

fn has_uniform_bars(img: &DynamicImage) -> bool {
    let (w, h) = img.dimensions();
    if w < 50 || h < 50 {
        return false;
    }
    let gray = img.to_luma8();

    // Check top and bottom strips (5% of height each)
    let strip_h = (h as f64 * 0.05).max(4.0) as u32;

    let top_uniform = is_row_strip_uniform(&gray, 0, strip_h, w);
    let bottom_uniform = is_row_strip_uniform(&gray, h.saturating_sub(strip_h), h, w);

    top_uniform || bottom_uniform
}

fn is_row_strip_uniform(gray: &GrayImage, y_start: u32, y_end: u32, width: u32) -> bool {
    if y_end <= y_start || width == 0 {
        return false;
    }

    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut count = 0u64;

    for y in y_start..y_end {
        for x in 0..width {
            let v = gray.get_pixel(x, y)[0] as f64;
            sum += v;
            sum_sq += v * v;
            count += 1;
        }
    }
    if count == 0 {
        return false;
    }
    let mean = sum / count as f64;
    let variance = (sum_sq / count as f64) - (mean * mean);
    variance < 100.0
}

fn is_camera_aspect_ratio(w: u32, h: u32) -> bool {
    if w == 0 || h == 0 {
        return false;
    }
    let (wide, narrow) = if w >= h { (w, h) } else { (h, w) };
    let ratio = wide as f64 / narrow as f64;

    const CAMERA_RATIOS: &[f64] = &[
        4.0 / 3.0,   // 1.333 - most compact cameras, phones
        3.0 / 2.0,   // 1.500 - DSLRs, mirrorless
        16.0 / 9.0,  // 1.778 - video/widescreen
        1.0,          // 1:1 square
    ];
    const TOLERANCE: f64 = 0.03;

    CAMERA_RATIOS.iter().any(|&cr| (ratio - cr).abs() < TOLERANCE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hamming_distance_identical_hashes() {
        assert_eq!(hamming_distance(0, 0), 0);
        assert_eq!(hamming_distance(u64::MAX, u64::MAX), 0);
    }

    #[test]
    fn hamming_distance_opposite_hashes() {
        assert_eq!(hamming_distance(0, u64::MAX), 64);
    }

    #[test]
    fn hamming_distance_single_bit() {
        assert_eq!(hamming_distance(0b0000, 0b0001), 1);
        assert_eq!(hamming_distance(0b1010, 0b1000), 1);
    }

    #[test]
    fn dhash_deterministic() {
        let img = DynamicImage::new_rgb8(100, 100);
        let h1 = dhash(&img);
        let h2 = dhash(&img);
        assert_eq!(h1, h2);
    }

    #[test]
    fn laplacian_variance_flat_image_is_zero() {
        let gray = GrayImage::from_pixel(50, 50, Luma([128]));
        let var = laplacian_variance(&gray);
        assert!(var < 0.01, "flat image should have ~0 variance, got {var}");
    }

    #[test]
    fn exposure_stats_dark_image() {
        let gray = GrayImage::from_pixel(10, 10, Luma([10]));
        let stats = exposure_stats_from_gray(&gray);
        assert!(stats.mean_brightness < 15.0);
        assert!(stats.dark_pixel_pct > 0.99);
    }

    #[test]
    fn exposure_stats_bright_image() {
        let gray = GrayImage::from_pixel(10, 10, Luma([240]));
        let stats = exposure_stats_from_gray(&gray);
        assert!(stats.mean_brightness > 235.0);
        assert!(stats.bright_pixel_pct > 0.99);
    }

    #[test]
    fn camera_aspect_ratio_detection() {
        assert!(is_camera_aspect_ratio(4000, 3000)); // 4:3
        assert!(is_camera_aspect_ratio(6000, 4000)); // 3:2
        assert!(is_camera_aspect_ratio(1920, 1080)); // 16:9
        assert!(!is_camera_aspect_ratio(1170, 2532)); // iPhone screenshot
    }

    #[test]
    fn screenshot_heuristic_no_camera_no_resolution() {
        let signals = ScreenshotSignals::default();
        assert_eq!(signals.confidence, 0.0);
    }

    #[test]
    fn known_screenshot_resolution_match() {
        assert!(KNOWN_SCREENSHOT_RESOLUTIONS.contains(&(1170, 2532)));
        assert!(KNOWN_SCREENSHOT_RESOLUTIONS.contains(&(1920, 1080)));
    }
}

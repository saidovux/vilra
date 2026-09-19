use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use image::{DynamicImage, ImageFormat, ImageReader};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportedImageFormat {
    Jpeg,
    Png,
    WebP,
}

impl SupportedImageFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::WebP => "webp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "webp" => Some(Self::WebP),
            _ => None,
        }
    }

    fn from_image_format(format: ImageFormat) -> Option<Self> {
        match format {
            ImageFormat::Jpeg => Some(Self::Jpeg),
            ImageFormat::Png => Some(Self::Png),
            ImageFormat::WebP => Some(Self::WebP),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileIssueSeverity {
    Error,
    Warning,
}

impl FileIssueSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "error" => Some(Self::Error),
            "warning" => Some(Self::Warning),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileIssueKind {
    DecodeError,
    FormatMismatch,
    UnsupportedContent,
    Unreadable,
}

impl FileIssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DecodeError => "decode_error",
            Self::FormatMismatch => "format_mismatch",
            Self::UnsupportedContent => "unsupported_content",
            Self::Unreadable => "unreadable",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "decode_error" => Some(Self::DecodeError),
            "format_mismatch" => Some(Self::FormatMismatch),
            "unsupported_content" => Some(Self::UnsupportedContent),
            "unreadable" => Some(Self::Unreadable),
            _ => None,
        }
    }

    pub fn is_fingerprint_cacheable(self) -> bool {
        matches!(
            self,
            Self::DecodeError | Self::FormatMismatch | Self::UnsupportedContent
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFingerprint {
    pub size: i64,
    pub mtime: i64,
    pub mtime_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInspection {
    pub expected_format: SupportedImageFormat,
    pub detected_format: SupportedImageFormat,
    pub fingerprint: FileFingerprint,
    pub width: u32,
    pub height: u32,
}

impl ImageInspection {
    pub fn is_format_mismatch(&self) -> bool {
        self.expected_format != self.detected_format
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageInspectionErrorKind {
    UnsupportedPath,
    DecodeError,
    UnsupportedContent,
    Unreadable,
    ChangedDuringInspection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInspectionError {
    pub kind: ImageInspectionErrorKind,
    pub expected_format: Option<SupportedImageFormat>,
    pub detected_format: Option<String>,
    pub fingerprint: Option<FileFingerprint>,
    pub detail: String,
}

impl ImageInspectionError {
    pub fn file_issue_kind(&self) -> Option<FileIssueKind> {
        match self.kind {
            ImageInspectionErrorKind::DecodeError => Some(FileIssueKind::DecodeError),
            ImageInspectionErrorKind::UnsupportedContent => Some(FileIssueKind::UnsupportedContent),
            ImageInspectionErrorKind::Unreadable => Some(FileIssueKind::Unreadable),
            ImageInspectionErrorKind::UnsupportedPath
            | ImageInspectionErrorKind::ChangedDuringInspection => None,
        }
    }
}

pub fn expected_format_for_path(path: &Path) -> Option<SupportedImageFormat> {
    match path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some(SupportedImageFormat::Jpeg),
        "png" => Some(SupportedImageFormat::Png),
        "webp" => Some(SupportedImageFormat::WebP),
        _ => None,
    }
}

pub fn is_supported_image_path(path: &Path) -> bool {
    expected_format_for_path(path).is_some()
}

pub fn file_fingerprint(path: &Path) -> Result<FileFingerprint, ImageInspectionError> {
    let metadata = fs::metadata(path).map_err(|error| ImageInspectionError {
        kind: ImageInspectionErrorKind::Unreadable,
        expected_format: expected_format_for_path(path),
        detected_format: None,
        fingerprint: None,
        detail: format!("read metadata {}: {error}", path.display()),
    })?;
    if !metadata.is_file() {
        return Err(ImageInspectionError {
            kind: ImageInspectionErrorKind::Unreadable,
            expected_format: expected_format_for_path(path),
            detected_format: None,
            fingerprint: None,
            detail: format!("not a file: {}", path.display()),
        });
    }
    let modified = metadata.modified().map_err(|error| ImageInspectionError {
        kind: ImageInspectionErrorKind::Unreadable,
        expected_format: expected_format_for_path(path),
        detected_format: None,
        fingerprint: None,
        detail: format!("read mtime {}: {error}", path.display()),
    })?;
    Ok(FileFingerprint {
        size: metadata.len().min(i64::MAX as u64) as i64,
        mtime: system_time_seconds(modified),
        mtime_ns: system_time_nanos(modified),
    })
}

pub fn inspect_supported_image(path: &Path) -> Result<ImageInspection, ImageInspectionError> {
    let Some(expected_format) = expected_format_for_path(path) else {
        return Err(ImageInspectionError {
            kind: ImageInspectionErrorKind::UnsupportedPath,
            expected_format: None,
            detected_format: None,
            fingerprint: None,
            detail: format!("unsupported image path: {}", path.display()),
        });
    };
    let before = file_fingerprint(path)?;
    let file = File::open(path).map_err(|error| {
        stable_inspection_error(
            path,
            before,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::Unreadable,
                expected_format: Some(expected_format),
                detected_format: None,
                fingerprint: Some(before),
                detail: format!("open image {}: {error}", path.display()),
            },
        )
    })?;
    let reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|error| {
            stable_inspection_error(
                path,
                before,
                ImageInspectionError {
                    kind: ImageInspectionErrorKind::Unreadable,
                    expected_format: Some(expected_format),
                    detected_format: None,
                    fingerprint: Some(before),
                    detail: format!("read image header {}: {error}", path.display()),
                },
            )
        })?;
    let Some(raw_format) = reader.format() else {
        return Err(stable_inspection_error(
            path,
            before,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::DecodeError,
                expected_format: Some(expected_format),
                detected_format: None,
                fingerprint: Some(before),
                detail: format!("unrecognized image content: {}", path.display()),
            },
        ));
    };
    let Some(detected_format) = SupportedImageFormat::from_image_format(raw_format) else {
        return Err(stable_inspection_error(
            path,
            before,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::UnsupportedContent,
                expected_format: Some(expected_format),
                detected_format: Some(image_format_name(raw_format)),
                fingerprint: Some(before),
                detail: format!(
                    "unsupported image content {}: {}",
                    image_format_name(raw_format),
                    path.display()
                ),
            },
        ));
    };
    let (width, height) = reader.into_dimensions().map_err(|error| {
        stable_inspection_error(
            path,
            before,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::DecodeError,
                expected_format: Some(expected_format),
                detected_format: Some(detected_format.as_str().to_string()),
                fingerprint: Some(before),
                detail: format!("read image dimensions {}: {error}", path.display()),
            },
        )
    })?;
    let after = verify_unchanged(
        path,
        before,
        Some(expected_format),
        Some(detected_format.as_str().to_string()),
    )?;
    Ok(ImageInspection {
        expected_format,
        detected_format,
        fingerprint: after,
        width,
        height,
    })
}

fn stable_inspection_error(
    path: &Path,
    initial: FileFingerprint,
    error: ImageInspectionError,
) -> ImageInspectionError {
    classify_inspection_error_stability(initial, file_fingerprint(path), error)
}

fn verify_unchanged(
    path: &Path,
    initial: FileFingerprint,
    expected_format: Option<SupportedImageFormat>,
    detected_format: Option<String>,
) -> Result<FileFingerprint, ImageInspectionError> {
    let current = file_fingerprint(path);
    match current {
        Ok(current) if current == initial => Ok(current),
        current => Err(classify_inspection_error_stability(
            initial,
            current,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::Unreadable,
                expected_format,
                detected_format,
                fingerprint: Some(initial),
                detail: format!("verify image stability: {}", path.display()),
            },
        )),
    }
}

fn classify_inspection_error_stability(
    initial: FileFingerprint,
    current: Result<FileFingerprint, ImageInspectionError>,
    error: ImageInspectionError,
) -> ImageInspectionError {
    match current {
        Ok(current) if current == initial => error,
        Ok(current) => ImageInspectionError {
            kind: ImageInspectionErrorKind::ChangedDuringInspection,
            expected_format: error.expected_format,
            detected_format: error.detected_format,
            fingerprint: Some(current),
            detail: format!("image changed during inspection: {}", error.detail),
        },
        Err(current_error) => ImageInspectionError {
            kind: ImageInspectionErrorKind::ChangedDuringInspection,
            expected_format: error.expected_format,
            detected_format: error.detected_format,
            fingerprint: current_error.fingerprint.or(Some(initial)),
            detail: format!(
                "image changed or became unavailable during inspection: {}; fingerprint recheck failed: {}",
                error.detail, current_error.detail
            ),
        },
    }
}

pub fn decode_supported_image(path: &Path) -> Result<DynamicImage, ImageInspectionError> {
    let Some(expected_format) = expected_format_for_path(path) else {
        return Err(ImageInspectionError {
            kind: ImageInspectionErrorKind::UnsupportedPath,
            expected_format: None,
            detected_format: None,
            fingerprint: None,
            detail: format!("unsupported image path: {}", path.display()),
        });
    };
    let fingerprint = file_fingerprint(path)?;
    let file = File::open(path).map_err(|error| {
        stable_inspection_error(
            path,
            fingerprint,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::Unreadable,
                expected_format: Some(expected_format),
                detected_format: None,
                fingerprint: Some(fingerprint),
                detail: format!("open image {}: {error}", path.display()),
            },
        )
    })?;
    let reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|error| {
            stable_inspection_error(
                path,
                fingerprint,
                ImageInspectionError {
                    kind: ImageInspectionErrorKind::Unreadable,
                    expected_format: Some(expected_format),
                    detected_format: None,
                    fingerprint: Some(fingerprint),
                    detail: format!("read image header {}: {error}", path.display()),
                },
            )
        })?;
    let Some(raw_format) = reader.format() else {
        return Err(stable_inspection_error(
            path,
            fingerprint,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::DecodeError,
                expected_format: Some(expected_format),
                detected_format: None,
                fingerprint: Some(fingerprint),
                detail: format!("unrecognized image content: {}", path.display()),
            },
        ));
    };
    let Some(detected_format) = SupportedImageFormat::from_image_format(raw_format) else {
        return Err(stable_inspection_error(
            path,
            fingerprint,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::UnsupportedContent,
                expected_format: Some(expected_format),
                detected_format: Some(image_format_name(raw_format)),
                fingerprint: Some(fingerprint),
                detail: format!(
                    "unsupported image content {}: {}",
                    image_format_name(raw_format),
                    path.display()
                ),
            },
        ));
    };
    let decoded = reader.decode().map_err(|error| {
        stable_inspection_error(
            path,
            fingerprint,
            ImageInspectionError {
                kind: ImageInspectionErrorKind::DecodeError,
                expected_format: Some(expected_format),
                detected_format: Some(detected_format.as_str().to_string()),
                fingerprint: Some(fingerprint),
                detail: format!("decode image {}: {error}", path.display()),
            },
        )
    })?;
    verify_unchanged(
        path,
        fingerprint,
        Some(expected_format),
        Some(detected_format.as_str().to_string()),
    )?;
    Ok(decoded)
}

fn system_time_seconds(value: SystemTime) -> i64 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().min(i64::MAX as u64) as i64,
        Err(error) => -(error.duration().as_secs().min(i64::MAX as u64) as i64),
    }
}

fn system_time_nanos(value: SystemTime) -> i64 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_nanos().min(i64::MAX as u128) as i64),
    }
}

fn image_format_name(format: ImageFormat) -> String {
    format
        .extensions_str()
        .first()
        .copied()
        .unwrap_or("unknown")
        .to_string()
}

/// Python-created thumb jobs should contain all fields.
/// Some fields remain `Option` only for legacy/runtime compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThumbJobPayload {
    pub image_id: Option<String>,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub mtime: Option<i64>,
    pub max_size: Option<Vec<u32>>,
}

/// Future contract for metadata jobs. Currently unused by workers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataJobPayload {
    pub image_id: String,
    pub root_path: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobType {
    Thumb,
    Metadata,
    Hash,
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

pub fn parse_u64_env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

/// Invalid or zero values fall back to `default`.
pub fn parse_usize_env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};
    use std::io::Cursor;
    use tempfile::tempdir;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(3, 2, Rgb([12, 34, 56])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn valid_supported_formats_are_header_inspected() {
        let dir = tempdir().unwrap();
        for (name, format, expected) in [
            ("valid.jpg", ImageFormat::Jpeg, SupportedImageFormat::Jpeg),
            ("valid.png", ImageFormat::Png, SupportedImageFormat::Png),
            ("valid.webp", ImageFormat::WebP, SupportedImageFormat::WebP),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, encoded(format)).unwrap();
            let inspection = inspect_supported_image(&path).unwrap();
            assert_eq!(inspection.expected_format, expected);
            assert_eq!(inspection.detected_format, expected);
            assert_eq!((inspection.width, inspection.height), (3, 2));
            assert!(!inspection.is_format_mismatch());
        }
    }

    #[test]
    fn supported_content_is_detected_independently_from_extension() {
        let dir = tempdir().unwrap();
        for (name, format, detected) in [
            (
                "png-as-jpeg.jpg",
                ImageFormat::Png,
                SupportedImageFormat::Png,
            ),
            (
                "webp-as-jpeg.jpg",
                ImageFormat::WebP,
                SupportedImageFormat::WebP,
            ),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, encoded(format)).unwrap();
            let inspection = inspect_supported_image(&path).unwrap();
            assert_eq!(inspection.expected_format, SupportedImageFormat::Jpeg);
            assert_eq!(inspection.detected_format, detected);
            assert!(inspection.is_format_mismatch());
            assert_eq!(decode_supported_image(&path).unwrap().width(), 3);
        }
    }

    #[test]
    fn unsupported_and_corrupt_content_are_classified() {
        let dir = tempdir().unwrap();
        let gif = dir.path().join("gif-content.jpg");
        fs::write(&gif, b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff").unwrap();
        let error = inspect_supported_image(&gif).unwrap_err();
        assert_eq!(error.kind, ImageInspectionErrorKind::UnsupportedContent);
        assert_eq!(error.detected_format.as_deref(), Some("gif"));

        let jpeg = dir.path().join("truncated.jpg");
        fs::write(&jpeg, [0xff, 0xd8, 0xff, 0xe0, 0x00]).unwrap();
        assert_eq!(
            inspect_supported_image(&jpeg).unwrap_err().kind,
            ImageInspectionErrorKind::DecodeError
        );

        let png = dir.path().join("invalid.png");
        fs::write(&png, b"\x89PNG\r\n\x1a\ninvalid").unwrap();
        assert_eq!(
            inspect_supported_image(&png).unwrap_err().kind,
            ImageInspectionErrorKind::DecodeError
        );
    }

    #[test]
    fn stable_full_decode_failures_are_permanent() {
        let dir = tempdir().unwrap();
        let corrupt = dir.path().join("corrupt.png");
        fs::write(&corrupt, b"\x89PNG\r\n\x1a\ninvalid").unwrap();
        assert_eq!(
            decode_supported_image(&corrupt).unwrap_err().kind,
            ImageInspectionErrorKind::DecodeError
        );

        let unsupported = dir.path().join("unsupported.jpg");
        fs::write(
            &unsupported,
            b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff",
        )
        .unwrap();
        assert_eq!(
            decode_supported_image(&unsupported).unwrap_err().kind,
            ImageInspectionErrorKind::UnsupportedContent
        );
    }

    #[test]
    fn failed_full_decode_classification_is_deterministic_for_change_and_disappearance() {
        let initial = FileFingerprint {
            size: 100,
            mtime: 10,
            mtime_ns: 10_000,
        };
        let changed = FileFingerprint {
            size: 101,
            mtime: 10,
            mtime_ns: 10_001,
        };
        let decode_error = || ImageInspectionError {
            kind: ImageInspectionErrorKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Png),
            detected_format: Some("png".to_string()),
            fingerprint: Some(initial),
            detail: "full pixel decode failed".to_string(),
        };

        assert_eq!(
            classify_inspection_error_stability(initial, Ok(changed), decode_error()).kind,
            ImageInspectionErrorKind::ChangedDuringInspection
        );
        assert_eq!(
            classify_inspection_error_stability(
                initial,
                Err(ImageInspectionError {
                    kind: ImageInspectionErrorKind::Unreadable,
                    expected_format: Some(SupportedImageFormat::Png),
                    detected_format: None,
                    fingerprint: None,
                    detail: "file disappeared".to_string(),
                }),
                decode_error(),
            )
            .kind,
            ImageInspectionErrorKind::ChangedDuringInspection
        );
    }

    #[test]
    fn post_error_stability_check_rejects_changed_or_missing_files() {
        let initial = FileFingerprint {
            size: 10,
            mtime: 1,
            mtime_ns: 100,
        };
        let changed = FileFingerprint {
            size: 11,
            mtime: 1,
            mtime_ns: 101,
        };
        let permanent = || ImageInspectionError {
            kind: ImageInspectionErrorKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: None,
            fingerprint: Some(initial),
            detail: "invalid header".to_string(),
        };

        assert_eq!(
            classify_inspection_error_stability(initial, Ok(initial), permanent()).kind,
            ImageInspectionErrorKind::DecodeError
        );
        let changed_error = classify_inspection_error_stability(initial, Ok(changed), permanent());
        assert_eq!(
            changed_error.kind,
            ImageInspectionErrorKind::ChangedDuringInspection
        );
        assert_eq!(changed_error.fingerprint, Some(changed));

        let disappeared = ImageInspectionError {
            kind: ImageInspectionErrorKind::Unreadable,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: None,
            fingerprint: None,
            detail: "file disappeared".to_string(),
        };
        assert_eq!(
            classify_inspection_error_stability(initial, Err(disappeared), permanent()).kind,
            ImageInspectionErrorKind::ChangedDuringInspection
        );

        let unsupported = ImageInspectionError {
            kind: ImageInspectionErrorKind::UnsupportedContent,
            detected_format: Some("gif".to_string()),
            ..permanent()
        };
        assert_eq!(
            classify_inspection_error_stability(initial, Ok(changed), unsupported).kind,
            ImageInspectionErrorKind::ChangedDuringInspection
        );
    }

    #[test]
    fn extensionless_and_unsupported_paths_are_ignored_before_sniffing() {
        let dir = tempdir().unwrap();
        let jpeg = encoded(ImageFormat::Jpeg);
        let extensionless = dir.path().join("extensionless");
        let text = dir.path().join("image.txt");
        fs::write(&extensionless, &jpeg).unwrap();
        fs::write(&text, &jpeg).unwrap();

        for path in [&extensionless, &text] {
            assert!(!is_supported_image_path(path));
            let error = inspect_supported_image(path).unwrap_err();
            assert_eq!(error.kind, ImageInspectionErrorKind::UnsupportedPath);
            assert!(error.fingerprint.is_none());
            assert!(error.detected_format.is_none());
        }

        let missing = dir.path().join("missing-without-extension");
        assert_eq!(
            inspect_supported_image(&missing).unwrap_err().kind,
            ImageInspectionErrorKind::UnsupportedPath
        );
    }
}

# Memoria

[![CI](https://github.com/swadel/memoria/actions/workflows/ci.yml/badge.svg)](https://github.com/swadel/memoria/actions/workflows/ci.yml)

> Intelligently organize local photos and videos into a structured, event-based archive.

Memoria is a Windows-first desktop application with a guided, phase-by-phase workflow. It indexes local photos and videos, runs image-quality and burst review, lets you review and exclude short or unwanted videos, enforces date metadata, groups media into location-aware event folders using a two-pass AI pipeline, and organizes everything into a clean archive — all with you in control of every decision.

---

## Why Memoria

Large media libraries often have inconsistent dates and no useful folder structure. Memoria gives you a deterministic, auditable pipeline for indexing, image review, video review, date review, grouping, and final filing.

The folder structure Memoria produces looks like this:

```
/organized/
  2025/
    2025 - Destin Family Vacation/
    2025 - Home Christmas Morning/
    2025 - Chicago Weekend Trip/
    2025 - Soccer Tournament/
    2025 - Birthday Party/
    2025 - Misc/
  2026/
    2026 - Yellowstone Wildlife Trip/
    2026 - March Activities/
    2026 - Misc/
/recycle/       ← items you've marked for deletion (soft delete, never permanent)
```

---

## Features

### Local Media Indexing
- Indexes media recursively from your configured Working Directory
- Copies files into `/staging/` and extracts metadata (dimensions, mime, EXIF date, duration)
- Tracks item-level status in SQLite so every stage remains auditable
- Supports `jpeg`, `png`, `heic`, `tif`, `mp4`, and `mov` (plus common related extensions)

### Image Review (Pre-Video)
- Dedicated Image Review phase immediately after indexing
- Auto-flags low-quality/candidate images (`small_file`, `blurry`, `burst_shot`)
- Detects burst groups and auto-selects a best frame (`is_burst_primary`)
- Supports filtered review, bulk/individual exclude, restore, and burst actions (`Keep Best Only`, `Keep All`)
- Video files in the review set display a play glyph overlay; clicking opens a video player in the preview modal
- Collapsible **"How does this work?"** guide explains every filter (Active, Excluded, All Images, Flagged Only, Burst Groups, Duplicates, Screenshots) and the sort dropdown
- Tile info overlay (filename, size, date, badges) is always visible at the bottom of each card for readability
- Image Review completion advances remaining active items to `image_reviewed`
- Completion shows a busy overlay and transitions directly into Video Review

### Video Review (Pre-Date-Enforcement)
- Dedicated Video Review phase between Image Review and Date Enforcement
- Reviews all `video/*` items in `image_reviewed` state with file size and duration metadata
- Mutually exclusive filters (`Filter by Size` or `Filter by Duration`); defaults to **Filter by Duration**
- Videos are sorted ascending by the active filter criterion (shortest-first for duration, smallest-first for size)
- Slider controls are width-constrained for a cleaner layout
- Inline preview behavior:
  - short clips can play inline
  - longer clips open a modal/lightbox with full controls
- Exclude actions move files to `/recycle/` with `status='excluded'` and audit log entries
- **Excluded tab** properly displays excluded videos and allows restoring them back to active review
- Completing Video Review advances remaining active items to `video_reviewed`
- Proceeding from Video Review immediately runs Date Enforcement (with loading UI) and lands on Date Approval
- Excluded videos are not included in downstream phases until restored

### Date Metadata Enforcement
Amazon Photos, Google Photos, and most photo management tools order images by the `DateTimeOriginal` EXIF field. If that field is missing, your photos end up out of order or dumped into an "unknown date" bucket.

Memoria checks every `video_reviewed` item. If `DateTimeOriginal` is missing or invalid (for example `1970:01:01`), it:
1. Flags the item with `date_needs_review=1`
2. Uses AI to estimate a likely date with confidence and reasoning
3. Displays the item in Date Approval with a clickable thumbnail that opens a full-size preview (images) or video player (videos)
4. Writes approved dates back to metadata only after user action

When AI estimation fails (no API key, service unavailable, or unreadable image), Memoria returns `ai_date: null` with a clear "AI could not determine date" message — the user can enter a date manually via the date input. Previous versions incorrectly returned a hardcoded fallback date.

All metadata changes are logged to a full audit trail.

### Location-Aware Event Grouping
Memoria clusters your photos into events using a two-pass AI pipeline with rich location analysis:

- Groups `date_verified` items into time-based clusters using a configurable threshold (default: 2 days)
- Computes cluster-level location facts by aggregating GPS coordinates across all items:
  - **GPS coverage** — what percentage of items have coordinates
  - **Dominant location** — the most common city/region with confidence scoring
  - **Location consistency** — whether all geocoded items share the same location (`consistent`, `mixed`, or `none`)
  - **Home distance** — median distance from the user's configured home location
  - **Away-from-home detection** — composite heuristic using median distance, percentage of items outside home radius, and dominant location confidence
  - **Travel cluster signal** — identifies multi-day away-from-home clusters as likely vacations or trips
- **Pass 1** (cluster metadata analysis) derives structured event clues including travel indicators and destination candidates
- **Pass 2** (event naming) produces the final folder name using anti-generic naming rules and destination awareness
- Applies a banned-name list to prevent vague outputs like "Family Gathering" or "Weekend Moments"
- Destination-aware naming prefers specific place names when the cluster is away from home (e.g., "2025 - Destin Family Vacation")
- Improved collision handling tries semantic differentiators (date ranges, locations) before numeric suffixes
- Large generic clusters (20+ items) are automatically re-split for better granularity
- Reverse geocoding results are cached persistently in SQLite to minimize external API calls across runs
- All cluster location facts are persisted for debugging and audit traceability
- Lets you review and rename event groups before finalize

Photos not associated with any event go into a `[YEAR] - Misc` folder.

### AI Pipeline
Memoria uses a configurable multi-model AI pipeline with five independently configurable task slots:

| Slot | Purpose | Required? |
|---|---|---|
| Date Estimation — Primary | Estimates dates for items with missing EXIF metadata | Yes |
| Date Estimation — Fallback | Backup model for date estimation if the primary fails | No |
| Grouping Pass 1 — Cluster Analysis | Derives structured event clues and travel indicators | No (falls back to event naming model) |
| Grouping Pass 2 — Event Naming | Produces the final event/folder name | Yes |
| Event Naming — Fallback | Backup model for event naming if the primary fails | No |

Supported providers: **OpenAI** and **Anthropic**. Each slot can be configured with any provider/model combination.

When AI is unavailable, all flows have offline fallbacks:
- Date estimation returns a clear "could not determine date" message with zero confidence, allowing the user to enter a date manually
- Event naming falls back to location-aware or date-based names (e.g., "Nashville Trip" or "March Activities") instead of generic labels

### Home Location
An optional Home Location setting enables home-vs-away detection for smarter event naming:

- Enter a home address or area (e.g., "Nashville, TN") and it is geocoded server-side via Nominatim
- Configure an optional label and radius (default: 25 miles)
- The raw street address is never sent to any AI model — only derived facts like `away_from_home` and `median_distance_from_home_miles`
- When configured, clusters away from home with a known destination get names like "2025 - Destin Family Vacation" instead of "Family Gathering"
- Fully optional: existing users without a home location configured see no behavioral change

### Dashboard and Session UX
- Dashboard uses a `ProgressHero` card as the primary status and action surface
- Hero memory stack previews are image-only (video items are excluded from those preview cards)
- Primary CTA behavior:
  - `Start Organizing` before the first indexing run
  - `Resume Organizing` while a session is in progress
  - `Start New Session` after finalization is complete
- `Start New Session` opens the same reset modal as `Reset Session` (`Reset and Delete Files` vs `Reset App State Only`)

### Busy-State Feedback
- Global loading overlays appear during major phase work:
  - Indexing
  - Image Review scan (analysis + grouping)
  - Image Review completion handoff
  - Video include/exclude updates
  - Date Enforcement
  - Event Group generation
  - Finalize
- Loading copy is phase-specific so users always see what operation is running
- Every loading screen displays a **progress bar** with current/total counts and a description of the item being processed (e.g., "Analyzing image 50/139", "Preparing video 3/15")
- Progress is driven by real-time `pipeline-progress` events emitted from the Rust backend

### Event Group Review and Reassignment
- Event Group cards are clickable and open a dedicated detail view for that group
- Group detail uses a virtualized thumbnail grid (via `@tanstack/virtual`) to stay responsive with large groups
- Each item shows a thumbnail, filename, and date taken; clicking the thumbnail opens a full-size image/video preview
- Multi-select supports click, shift+click range selection, **Select All**, and **Deselect All**
- Selected items can be moved to another existing group or to a newly created group in one action
- Individual cards support soft delete with inline confirmation (**Exclude** -> recycle)
- Multiselect toolbar supports bulk soft delete with inline banner confirmation (**Exclude Selected**)
- Group detail supports **Show active | Show excluded** with per-item restore in excluded mode
- Group names are enforced as case-insensitive unique values (for rename and create), with inline validation errors
- Empty groups are intentionally preserved after moves/excludes and can then be deleted explicitly from Event Group Review
- New empty groups can be added manually with **Add Group** and are shown immediately with `0 items`

### Non-Destructive by Design
Memoria never hard-deletes media in the normal pipeline:
- Indexing writes staged copies under `/staging/`
- Finalization writes organized copies under `/organized/`
- Exclude actions move files to `/recycle/` (soft delete), with restore support back to `/staging/`
- Reset Session can clear app state with or without deleting generated folders
- Reset + delete mode recreates empty `/staging`, `/organized`, and `/recycle` directories after cleanup
- Audit log rows capture date approvals/skips, exclude/restore actions, and file finalization events

---

## Stack

| Component | Technology |
|---|---|
| Desktop framework | Tauri 2.0 (Rust + WebView2) |
| Frontend | React 18 + TypeScript + Tailwind CSS |
| AI providers | OpenAI and Anthropic with per-task model routing |
| Geocoding | Nominatim (OpenStreetMap) with persistent local cache |
| Metadata | exiftool (bundled binary) |
| Thumbnail generation | ffmpeg (bundled binary) |
| Database | SQLite via rusqlite (WAL mode) |
| Credential storage | keyring crate → Windows Credential Manager |
| iCloud bridge | Python sidecar via pyicloud (optional) |

---

## Requirements

- **OS**: Windows 11 (macOS support is a planned future milestone)
- **Media source**: Local media files in the configured Working Directory
- **API keys**: OpenAI and/or Anthropic key for AI date estimation and event naming (optional — offline fallbacks work without keys)
- **Storage**: Enough local disk space for your media originals plus organized copies during processing
- **Tools**: Node.js 20+, Rust stable, and [Tauri prerequisites](https://tauri.app/v2/guides/getting-started/prerequisites/). Python 3.11+ is needed only if using the optional iCloud download bridge.

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/swadel/memoria.git
cd memoria

# 2. Install frontend dependencies
npm install

# 3. Place exiftool.exe and ffmpeg.exe in vendor/
#    See vendor/README.md for download links

# 4. Run in development mode
npm run tauri dev
```

---

## Pipeline Phases

1. **Index Media**
   - Recursively scans Working Directory for supported files
   - Copies files to `/staging/`
   - Extracts metadata and sets indexed state for downstream review
   - Marks items as `indexed`

2. **Image Review**
   - Reviews `image/*` items in `indexed` state
   - Applies auto-flagging and burst grouping metadata
   - Supports exclude/restore and burst-specific actions
   - Completion advances active items to `image_reviewed`

3. **Video Review**
   - Reviews `video/*` items in `image_reviewed` state
   - Supports exclusive size/duration filtering and preview playback
   - Exclude/restore moves files between `/staging/` and `/recycle/`
   - Completion advances active items to `video_reviewed`

4. **Date Enforcement**
   - Date Approval page lists items where `date_needs_review=1`
   - Each card loads a thumbnail (existing `.thumbnails`, generated ffmpeg thumbnail, or image fallback)
   - `Approve/Edit` writes the selected date and sets `date_taken_source='user_override'`
   - `Skip` clears review-required state and marks item `date_verified`

5. **Group**
   - Groups `date_verified` items into time-based clusters
   - Runs two-pass AI analysis: cluster metadata (Pass 1) then event naming (Pass 2)
   - Computes cluster location facts and home-distance signals
   - Creates event groups with location-aware, destination-specific names
   - Supports click-through detail review, multiselect item moves, soft delete/restore, manual group creation, and delete of empty groups only

6. **Finalize**
   - Copies grouped items into `/organized/<year>/<year - event>/`
   - Updates each item to `status='filed'` and records audit events
   - After completion, Event Groups CTA switches to `Back to Dashboard`
   - Dashboard primary CTA becomes `Start New Session` and opens the reset prompt

7. **Reset Session**
   - Clears pipeline DB state using a single transaction
   - Optionally deletes generated folders: `/staging`, `/organized`, `/recycle`
   - Delete-files mode recreates those folders as empty directories
   - Reset dialog surfaces inline errors and only closes on success
   - This same dialog is available from the dashboard `Start New Session` action post-finalize

---

## Dev & Test Commands

```bash
npm run lint             # TypeScript type checks
npm run build            # Frontend build (tsc + vite)
npm run check:rust       # Rust compile check
npm run test:rust        # Rust unit tests (99 tests)
npm run test:ui:browser  # Browser E2E suite (Playwright, Chromium, 47 tests)
npm run test:ui:desktop  # Desktop E2E suite (Playwright, real Tauri app)
npm run test:ui          # All Playwright projects
npm run test:ui:headed   # Playwright in headed mode (debugging)
npm run test:unit:ui     # Vitest unit tests
npm test                 # Full local test pass (lint + Rust tests)
```

---

## Configuration

All settings are managed through the in-app Settings panel. Nothing requires manual config file editing.

### General Settings

| Setting | Default | Description |
|---|---|---|
| Output directory | `~/Pictures/Memoria` | Where organized folders are created |
| Download concurrency | 3 | Parallel iCloud downloads |
| AI cost cap | $20.00 | Processing pauses if this amount is reached |
| Grouping time window | 2 days | Max gap between photos in the same event cluster |
| HEIC handling | Keep originals | Whether to convert HEIC to JPEG on download |

### AI Model Configuration

Five independently configurable model slots in Settings:

| Slot | Default | Notes |
|---|---|---|
| Date Estimation — Primary Model | Anthropic claude-sonnet-4-6 | Required |
| Date Estimation — Fallback Model | Not configured | Optional, activates if primary fails |
| Grouping Pass 1 — Cluster Analysis Model | Not configured | Optional, falls back to event naming model |
| Grouping Pass 2 — Event Naming Model | Anthropic claude-sonnet-4-6 | Required |
| Event Naming — Fallback Model | Not configured | Optional, activates if primary fails |

Optional slots show a **Configure** button when unconfigured and a **Clear** button when set. Required slots cannot be cleared.

### Home Location

| Setting | Default | Description |
|---|---|---|
| Home Address / Area | Not configured | City, zip, or address — geocoded on save via Nominatim |
| Home Label | (empty) | Optional friendly name (e.g., "Home", "Nashville") |
| Home Radius | 25 miles | Distance threshold for home-vs-away classification |

When configured, the grouping pipeline uses home location to detect travel clusters and produce destination-aware event names.

### Runtime Logging

Memoria writes timestamped backend logs to the terminal during long-running operations (indexing, date evaluation, grouping, finalize, thumbnail resolution).

```powershell
$env:MEMORIA_LOG_LEVEL='info'   # off | warn | info | debug
npm run tauri dev
```

To dump full expanded AI prompts during grouping (useful for debugging naming quality):

```powershell
$env:MEMORIA_LOG_PROMPTS='1'
npm run tauri dev
```

---

## Important Limitations

**AI costs**: AI analysis is not free. Memoria shows a cost estimate before starting any AI-powered processing step and will pause if you set a cost cap. You are billed directly by OpenAI or Anthropic through your own API key.

**Windows long paths**: Windows has a default 260-character path limit. It is recommended to enable long path support:

```
HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1
```

Memoria uses the `\\?\` extended-length path prefix internally, but enabling this setting provides an additional safety net.

---

## Project Structure

```
memoria/
  src-tauri/              # Rust backend
    src/
      commands/           # Tauri IPC command handlers
        settings.rs       #   App config, AI models, home location, reset
        download.rs       #   Media download/indexing
        organize.rs       #   File organization and finalization
        metadata.rs       #   EXIF metadata operations
        image_review.rs   #   Image review commands
        video_review.rs   #   Video review commands
      services/           # Business logic
        ai_client.rs      #   Two-pass AI pipeline, prompt builders, validation
        event_grouper.rs  #   Cluster generation, location analysis, naming
        geocoding.rs      #   Forward/reverse geocoding, haversine, persistent cache
        date_enforcer.rs  #   Date metadata enforcement
        file_organizer.rs #   File copy/move operations
        exiftool.rs       #   Exiftool/ffmpeg integration
        image_analysis.rs #   Blur scoring, perceptual hashing, exposure/screenshot detection
        image_review.rs   #   Image flagging, burst detection
        video_review.rs   #   Video review logic
        settings.rs       #   Secret/credential storage
        runtime_log.rs    #   Runtime logging, pipeline progress event emission
      db/                 # SQLite schema, migrations, queries
  src/                    # React frontend
    App.tsx               # Main UI (Dashboard, Reviews, Date Approval, Events, Settings)
    components/UI/        # Reusable UI components (LoadingState with progress bar)
    lib/api.ts            # Tauri invoke wrappers and type contracts
    types.ts              # Shared TypeScript interfaces
    styles.css            # Application styles
  sidecar/                # Optional Python iCloud bridge
  tests/
    ui/
      browser/            # Playwright browser E2E tests
      desktop/            # Playwright desktop E2E tests (real Tauri app)
      helpers/            # Shared test utilities and browser mocks
  vendor/                 # Bundled third-party binaries (exiftool, ffmpeg)
```

## Acknowledgments

- [exiftool](https://exiftool.org/) by Phil Harvey — the gold standard for photo metadata
- [Tauri](https://tauri.app/) — lightweight, performant desktop framework
- [OpenStreetMap / Nominatim](https://nominatim.openstreetmap.org/) — geocoding for location-aware grouping
- [pyicloud](https://github.com/picklepete/pyicloud) — iCloud web API access
- [icloudpd](https://github.com/icloud-photos-downloader/icloud_photos_downloader) — community that maintains pyicloud compatibility

---

## License

MIT License. See [LICENSE](LICENSE) for details.

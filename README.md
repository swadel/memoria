# Memoria

[![CI](https://github.com/swadel/memoria/actions/workflows/ci.yml/badge.svg)](https://github.com/swadel/memoria/actions/workflows/ci.yml)

> Intelligently organize local photos and videos into a structured, event-based archive.

Memoria is a Windows-first desktop application that indexes local photos and videos, runs image-quality/burst review, lets you review/exclude short or unwanted videos, enforces date metadata, and organizes media into meaningful event folders — all with you in control of every decision.

---

## Why Memoria

Large media libraries often have inconsistent dates and no useful folder structure. Memoria gives you a deterministic, auditable pipeline for indexing, image review, video review, date review, grouping, and final filing.

The folder structure Memoria produces looks like this:

```
/organized/
  2025/
    2025 - Family Christmas/
    2025 - Thatcher Birthday/
    2025 - Fourth of July/
    2025 - Beach Vacation/
    2025 - Misc/
  2026/
    2026 - New Years/
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
- Image Review completion advances remaining active items to `image_reviewed`

### Date Metadata Enforcement
Amazon Photos, Google Photos, and most photo management tools order images by the `DateTimeOriginal` EXIF field. If that field is missing, your photos end up out of order or dumped into an "unknown date" bucket.

Memoria checks every `video_reviewed` item. If `DateTimeOriginal` is missing or invalid (for example `1970:01:01`), it:
1. Flags the item with `date_needs_review=1`
2. Uses AI to estimate a likely date with confidence/reasoning
3. Displays the item in Date Approval with a thumbnail preview
4. Writes approved dates back to metadata only after user action

All metadata changes are logged to a full audit trail.

### Intelligent Event Grouping
Memoria clusters your photos into events automatically:
- Groups `date_verified` items by time proximity
- Applies deterministic naming for misc/holiday-like groups
- Uses AI to suggest event names for larger clusters
- Lets you review and rename event groups before finalize

Photos not associated with any event go into a `[YEAR] - Misc` folder.

### Video Review (Pre-Date-Enforcement)
- Dedicated Video Review phase between Image Review and Date Enforcement
- Reviews all `video/*` items in `image_reviewed` state with file size and duration metadata
- Mutually exclusive filters (`Filter by Size` or `Filter by Duration`)
- Inline preview behavior:
  - short clips can play inline
  - longer clips open a modal/lightbox with full controls
- Exclude actions move files to `/recycle/` with `status='excluded'` and audit log entries
- Completing Video Review advances remaining active items to `video_reviewed`
- Excluded videos are not included in downstream phases until restored

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
| Frontend | React 18 + TypeScript + Tailwind CSS + shadcn/ui |
| AI tasks | OpenAI/Anthropic routing for date estimation and event naming |
| Metadata | exiftool (bundled binary) |
| Thumbnail generation | ffmpeg (bundled binary) |
| Database | SQLite via rusqlite (WAL mode) |
| Credential storage | keyring crate → Windows Credential Manager |

---

## Requirements

- **OS**: Windows 11 (macOS support is a planned future milestone)
- **Media source**: Local media files in the configured Working Directory.
- **API keys**: OpenAI and/or Anthropic key for AI date estimation/event naming (optional if running fallback-only behavior).
- **Storage**: Enough local disk space for your downloaded originals plus organized copies during processing.
- **Tools**: Node.js 20+, Rust stable, Python 3.11+, and [Tauri prerequisites](https://tauri.app/v2/guides/getting-started/prerequisites/)

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
   - Groups `date_verified` items into event clusters
   - Creates event groups and links items with `status='grouped'`
   - Supports click-through detail review, multiselect item moves, soft delete/restore, manual group creation, and delete of empty groups only

6. **Finalize**
   - Copies grouped items into `/organized/<year>/<year - event>/`
   - Updates each item to `status='filed'` and records audit events

7. **Reset Session**
   - Clears pipeline DB state using a single transaction
   - Optionally deletes generated folders: `/staging`, `/organized`, `/recycle`
   - Delete-files mode recreates those folders as empty directories
   - Reset dialog now surfaces inline errors and only closes on success

---

## Dev & Test Commands

```bash
npm run lint          # TypeScript checks
npm run build         # Frontend build
npm run check:rust    # Rust compile check
npm run test:rust     # Rust unit tests
npm test              # Full local test pass
```

---

## Configuration

All settings are managed through the in-app Settings panel. Nothing requires manual config file editing.

| Setting | Default | Description |
|---|---|---|
| Output directory | `~/Pictures/Memoria` | Where organized folders are created |
| Download concurrency | 3 | Parallel iCloud downloads |
| AI cost cap | $20.00 | Processing pauses if this amount is reached |
| Grouping time window | 2 days | Max default gap between photos in the same event cluster |
| HEIC handling | Keep originals | Whether to convert HEIC to JPEG on download |
| Runtime logging | `info` | Set `MEMORIA_LOG_LEVEL` to `off`, `warn`, `info`, or `debug` for terminal verbosity |

### Runtime Logging

Memoria writes timestamped backend logs to the terminal during long-running operations (indexing, date evaluation, grouping, finalize, thumbnail resolution).

Set log level before launch:

```powershell
$env:MEMORIA_LOG_LEVEL='info'   # off | warn | info | debug
npm run tauri dev
```

You will see per-stage and per-item progress messages such as:
- session start/completion
- `file X/Y` indexing progress
- date-review decisions (`flagged` vs `verified`)
- group creation and file finalization

---

## Important Limitations

**AI costs**: AI analysis is not free. Memoria shows a cost estimate before starting any AI-powered processing step and will pause if you set a cost cap. You are billed directly by OpenAI through your own API key.

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
      services/           # Business logic (index, date, grouping, organize)
      db/                 # SQLite schema, migrations, queries
      models/             # Shared data structures
  src/                    # React frontend
    App.tsx               # Main UI (Dashboard, Image Review, Video Review, Date Approval, Events, Settings)
    lib/api.ts            # Tauri invoke wrappers
  vendor/                 # Bundled third-party binaries
    exiftool.exe
    ffmpeg.exe
```

## Acknowledgments

- [pyicloud](https://github.com/picklepete/pyicloud) — iCloud web API access
- [icloudpd](https://github.com/icloud-photos-downloader/icloud_photos_downloader) — community that maintains pyicloud compatibility
- [exiftool](https://exiftool.org/) by Phil Harvey — the gold standard for photo metadata
- [Tauri](https://tauri.app/) — lightweight, performant desktop framework

---

## License

MIT License. See [LICENSE](LICENSE) for details.

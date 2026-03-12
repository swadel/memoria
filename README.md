# Memoria

[![CI](https://github.com/swadel/memoria/actions/workflows/ci.yml/badge.svg)](https://github.com/swadel/memoria/actions/workflows/ci.yml)

> Intelligently organize your iCloud photo library into a structured, event-based archive.

Memoria is a Windows-first desktop application that downloads photos and videos from iCloud, classifies them using AI, enforces date metadata, and organizes them into meaningful event folders — all with you in control of every decision.

---

## Why Memoria

iCloud is great at storing photos. It's not great at organizing them. If you've ever tried to import your library into Amazon Photos, Lightroom, or a NAS and found thousands of screenshots mixed in with family memories, dates missing entirely, and no logical folder structure — Memoria solves that.

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
/review/        ← screenshots, GIFs, and ambiguous items awaiting your decision
/recycle/       ← items you've marked for deletion (soft delete, never permanent)
```

---

## Features

### iCloud Integration
- Authenticate with iCloud (including MFA) directly from the app
- Specify any date range to process — month by month, year by year, or a custom window
- Downloads original full-resolution files (not compressed versions)
- Resumable downloads — if the app closes mid-batch, it picks up where it left off
- Works without iCloud for Windows installed; communicates directly with Apple's web APIs

### Smart Media Classification
Memoria separates the photos you care about from the noise:

- **Legitimate media** (family photos, travel, events, pets) flows through the main pipeline
- **Review-queue items** (screenshots, GIFs, memes, screen recordings) are staged for your review before anything happens to them

Classification uses a combination of rule-based filters (file size, dimensions, EXIF flags) and AI vision analysis via the OpenAI API. You can tune the rules and confidence thresholds in Settings.

### Review Queue
Every item flagged for review is presented in a clean interface before any action is taken. You decide:
- **Include** — treat it as a legitimate photo and route it through the main pipeline
- **Delete** — move it to the recycle folder (soft delete; nothing is permanently removed)

Keyboard shortcuts (I / D / arrow keys) make triage fast. Batch approval is supported for high-confidence AI classifications.

### Date Metadata Enforcement
Amazon Photos, Google Photos, and most photo management tools order images by the `DateTimeOriginal` EXIF field. If that field is missing, your photos end up out of order or dumped into an "unknown date" bucket.

Memoria checks every file. If a date is missing or clearly wrong (a 1970 epoch date, a future date), it:
1. Attempts to parse the date from the filename
2. Uses AI vision analysis to estimate when the photo was taken (analyzing clothing, vegetation, lighting, visible text, and seasonal context)
3. Presents the estimate to you with a confidence level and reasoning
4. Only writes the date to the file after you approve it

All metadata changes are logged to a full audit trail.

### Intelligent Event Grouping
Memoria clusters your photos into events automatically:
- Groups photos taken within a configurable time window (default: 3 days)
- Matches clusters to known holidays and calendar events (Christmas, Thanksgiving, Fourth of July, Easter, and more)
- Uses AI to suggest folder names for clusters it can't match to a known event (e.g., "Beach Vacation", "Thatcher's Baseball Game")
- Presents all proposed groups for your review before moving a single file — rename, merge, split, or reassign individual items

Photos not associated with any event go into a `[YEAR] - Misc` folder.

### Non-Destructive by Design
Memoria never permanently deletes anything without your explicit action:
- Original downloaded files remain in `/staging/` untouched until you choose to clean up
- Date metadata is written to a copy, not the original
- The recycle folder is soft-delete only — nothing is removed from disk until you empty it
- Every batch of filed photos can be "unfiled" — files moved back, database state reverted
- A full audit log records every action taken by the system, AI, or you

---

## Stack

| Component | Technology |
|---|---|
| Desktop framework | Tauri 2.0 (Rust + WebView2) |
| Frontend | React 18 + TypeScript + Tailwind CSS + shadcn/ui |
| iCloud access | pyicloud (Python sidecar) |
| AI vision | OpenAI GPT-4o / GPT-4o-mini |
| Metadata | exiftool (bundled binary) |
| Thumbnail generation | ffmpeg (bundled binary) |
| Database | SQLite via rusqlite (WAL mode) |
| Credential storage | keyring crate → Windows Credential Manager |

---

## Requirements

- **OS**: Windows 11 (macOS support is a planned future milestone)
- **iCloud account**: Standard iCloud account required. **Advanced Data Protection (ADP) must be disabled** — ADP encrypts your library end-to-end in a way that prevents web-based access, which is how Memoria connects to iCloud.
- **OpenAI API key**: Required for AI classification, date estimation, and event naming. You bring your own key. Estimated cost: $0.01–$0.03 per image for classification. Processing 1,000 photos typically costs $10–$30 depending on how many items need AI analysis.
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

# 3. Install Python sidecar dependencies
python -m pip install -r sidecar/requirements.txt

# 4. Build the Python sidecar executable
python sidecar/build.py

# 5. Place exiftool.exe and ffmpeg.exe in vendor/
#    See vendor/README.md for download links

# 6. Run in development mode
npm run tauri dev
```

---

## Pipeline Overview

```
iCloud  →  /staging/  →  classify  →  /review/ (screenshots, GIFs)
                                   →  date check  →  AI estimate + approval
                                                  →  event grouping + AI naming
                                                  →  /organized/<year>/<year - event>/
```

1. **Download** originals from iCloud into `/staging/`
2. **Extract metadata** via exiftool (EXIF, file type, dimensions)
3. **Classify** media as `legitimate` or `review` using rules + AI vision
4. **Review queue** — you include or soft-delete flagged items
5. **Date enforcement** — missing dates estimated by AI, approved by you, written to EXIF
6. **Event grouping** — temporal clustering, holiday matching, AI-suggested folder names, your approval
7. **File organization** — moved to `organized/<year>/<year - event>/`, logged to audit trail

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
| Classification confidence threshold | 90% | Items below this go to review queue |
| AI cost cap | $20.00 | Processing pauses if this amount is reached |
| Grouping time window | 3 days | Max gap between photos in the same event cluster |
| HEIC handling | Keep originals | Whether to convert HEIC to JPEG on download |

---

## Important Limitations

**Advanced Data Protection (ADP)**: If you have ADP enabled on your iCloud account, Memoria cannot access your library. You would need to disable ADP in your Apple ID settings to use this app.

**MFA re-authentication**: iCloud MFA session tokens expire approximately every 2 months. Memoria will detect this and prompt you to re-authenticate. Downloads in progress are paused and resume after you log back in.

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
      services/           # Business logic (download, classify, organize)
      db/                 # SQLite schema, migrations, queries
      models/             # Shared data structures
  src/                    # React frontend
    components/
      dashboard/          # Processing status overview
      review-queue/       # Media triage interface
      date-approval/      # Date estimation approval
      event-review/       # Event grouping review
      settings/           # App configuration
  sidecar/                # Python iCloud bridge
    icloud_bridge.py
    requirements.txt
    build.py              # PyInstaller build script
  vendor/                 # Bundled third-party binaries
    exiftool.exe
    ffmpeg.exe
```

---

## Roadmap

- [x] Architecture & planning
- [ ] Phase 1 — iCloud authentication, download pipeline, metadata extraction
- [ ] Phase 2 — Rule-based and AI classification, review queue UI
- [ ] Phase 3 — Date metadata enforcement, EXIF writing, approval workflow
- [ ] Phase 4 — Event clustering, AI naming, folder organization
- [ ] Phase 5 — Polish, performance, Windows installer, code signing
- [ ] macOS support (stretch goal)

---

## Acknowledgments

- [pyicloud](https://github.com/picklepete/pyicloud) — iCloud web API access
- [icloudpd](https://github.com/icloud-photos-downloader/icloud_photos_downloader) — community that maintains pyicloud compatibility
- [exiftool](https://exiftool.org/) by Phil Harvey — the gold standard for photo metadata
- [Tauri](https://tauri.app/) — lightweight, performant desktop framework

---

## License

MIT License. See [LICENSE](LICENSE) for details.

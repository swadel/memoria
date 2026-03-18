# CLAUDE.md — Memoria

> Agent onboarding guide for Claude Code, Codex, and similar AI coding agents working in this repo.

---

## What is Memoria?

Memoria is a **Windows-first desktop application** that intelligently organizes local photos and videos into a structured, event-based archive. It is a **Tauri 2.0 app** with a Rust backend, React/TypeScript frontend, and a multi-model AI pipeline for date estimation and event naming.

The core value prop: take a messy media library with inconsistent dates and no folder structure, and produce a clean `YYYY / YYYY - Event Name` archive — with the user in control of every decision.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  React 18 + TypeScript + Tailwind CSS  (WebView2)   │
│  src/App.tsx, src/components/*, src/lib/api.ts      │
├─────────────────────────────────────────────────────┤
│  Tauri IPC (invoke)                                 │
├─────────────────────────────────────────────────────┤
│  Rust Backend (src-tauri/)                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐     │
│  │ commands/ │→ │ services/ │→ │ db/ (SQLite) │     │
│  │ (thin)    │  │ (logic)   │  │ (WAL mode)   │     │
│  └──────────┘  └───────────┘  └──────────────┘     │
│  ┌───────────────────────────────────────────┐      │
│  │ External: exiftool, ffmpeg (vendor/)      │      │
│  │ AI: OpenAI / Anthropic (configurable)     │      │
│  │ Geocoding: Nominatim (cached in SQLite)   │      │
│  └───────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

### Key Architectural Principles
- **Commands are thin** — Tauri `#[tauri::command]` handlers delegate to `services/*` for all business logic.
- **Non-destructive** — No hard deletes. Excludes go to `/recycle/`. Originals stay in `/staging/`.
- **Offline fallbacks** — Every AI-dependent flow has a deterministic offline fallback so the pipeline works without API keys.
- **Auditability** — All state transitions are logged in SQLite. Every file operation is traceable.
- **Deterministic** — No hidden side effects. Fixture seeding is repeatable for testing.

---

## Project Layout

```
memoria/
├── src/                          # React frontend
│   ├── App.tsx                   # Main UI (~154K — monolith, contains all views)
│   ├── components/
│   │   ├── Dashboard/            # Dashboard components
│   │   ├── UI/                   # Reusable (LoadingState, etc.)
│   │   ├── AppShell.tsx
│   │   ├── PageHeader.tsx
│   │   ├── ReviewToolbar.tsx
│   │   └── WorkflowStepper.tsx
│   ├── lib/
│   │   ├── api.ts                # Tauri invoke wrappers (type-safe IPC layer)
│   │   ├── responsiveGrid.ts
│   │   └── responsiveGrid.test.ts
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── styles.css                # Tailwind + custom styles
│   └── themes.css
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # App setup, state init, CLI fixture seeder
│   │   ├── commands/             # Tauri IPC handlers (thin)
│   │   │   ├── settings.rs       # Config, API keys, home location, reset
│   │   │   ├── download.rs       # Media indexing
│   │   │   ├── image_review.rs   # Image review scan, burst, completion
│   │   │   ├── video_review.rs   # Video review, exclude/restore
│   │   │   ├── metadata.rs       # Dashboard stats, date enforcement, approval
│   │   │   ├── organize.rs       # Event grouping, finalization
│   │   │   └── testing.rs        # Fixture seeding command
│   │   ├── services/             # Business logic
│   │   │   ├── ai_client.rs      # Multi-model AI pipeline, prompt builders
│   │   │   ├── event_grouper.rs  # Clustering, location analysis, naming
│   │   │   ├── geocoding.rs      # Forward/reverse geocoding, haversine
│   │   │   ├── date_enforcer.rs  # Date metadata enforcement
│   │   │   ├── file_organizer.rs # File copy/move
│   │   │   ├── exiftool.rs       # exiftool/ffmpeg integration
│   │   │   ├── image_analysis.rs # Blur scoring, perceptual hashing
│   │   │   ├── image_review.rs   # Image flagging, burst detection
│   │   │   ├── video_review.rs   # Video review logic
│   │   │   ├── settings.rs       # Credential storage (Windows Credential Manager)
│   │   │   ├── runtime_log.rs    # Logging, pipeline progress events
│   │   │   └── test_fixtures.rs  # Deterministic fixture seeder
│   │   ├── db/                   # SQLite schema, migrations, queries
│   │   └── models/               # Rust data models
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/ui/                     # Playwright E2E tests
│   ├── browser/                  # Browser-based E2E (Chromium)
│   ├── desktop/                  # Real Tauri app E2E (Windows)
│   └── helpers/                  # Shared test utilities + browser mocks
├── sidecar/                      # Optional Python iCloud bridge
│   ├── icloud_bridge.py
│   └── icloud_bridge.exe         # Pre-built binary
├── vendor/                       # Bundled binaries
│   ├── exiftool.exe
│   └── ffmpeg.exe
├── .github/workflows/ci.yml      # CI pipeline
└── .cursor/rules/                # Existing Cursor rules (see below)
```

---

## Pipeline Phases (State Machine)

Items progress through these statuses in order:

```
queued → indexed → image_reviewed → video_reviewed → date_verified → grouped → filed
                                                                         ↘ excluded (soft delete, restorable)
```

1. **Index** — Scan working dir, copy to `/staging/`, extract metadata
2. **Image Review** — Auto-flag (blur, burst, small, screenshot), manual exclude/restore
3. **Video Review** — Filter by size/duration, exclude/restore
4. **Date Enforcement** — AI estimates missing EXIF dates, user approves/edits/skips
5. **Event Grouping** — Two-pass AI: cluster analysis → event naming (location-aware)
6. **Finalize** — Copy to `/organized/YYYY/YYYY - Event Name/`, mark `filed`
7. **Reset** — Clear state, optionally delete generated folders

---

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop framework | Tauri 2.0 (Rust + WebView2) |
| Frontend | React 18 + TypeScript + Tailwind CSS 3 |
| State management | Zustand + TanStack Query |
| Virtualization | @tanstack/react-virtual |
| Animation | Framer Motion |
| Database | SQLite (rusqlite, WAL mode, bundled) |
| Credentials | keyring crate → Windows Credential Manager |
| AI providers | OpenAI, Anthropic (per-task model routing, 5 configurable slots) |
| Geocoding | Nominatim (persistent SQLite cache) |
| Metadata | exiftool (bundled) |
| Thumbnails | ffmpeg (bundled) |
| Testing | Playwright (browser + desktop E2E), Vitest (unit), cargo test (99 Rust tests) |
| CI | GitHub Actions (lint → build → Rust tests → browser E2E → desktop E2E) |

---

## Dev Commands

```bash
# Development
npm run tauri dev              # Run in dev mode (Vite + Tauri)

# Build
npm run build                  # Frontend only (tsc + vite)

# Lint / Check
npm run lint                   # TypeScript type check
npm run check:rust             # Rust compile check

# Tests
npm run test:rust              # Rust unit tests (99 tests)
npm run test:unit:ui           # Vitest unit tests
npm run test:ui:browser        # Playwright browser E2E (47 tests)
npm run test:ui:desktop        # Playwright desktop E2E (real Tauri app)
npm test                       # Full local pass (lint + Rust tests)

# Debug
MEMORIA_LOG_LEVEL=info         # off | warn | info | debug
MEMORIA_LOG_PROMPTS=1          # Dump full AI prompts during grouping
MEMORIA_APP_DIR=<path>         # Override app data directory
```

---

## Coding Conventions

### Rust (src-tauri/)
- **Commands are thin** — All logic lives in `services/*`. Commands are IPC boundaries only.
- **Error handling** — Use `Result<_, String>` at command boundaries with user-facing error text. No panics in runtime paths.
- **DB migrations** — Must be idempotent. Add columns/indexes safely; never break existing DBs.
- **File ops** — Non-destructive by default. Exclude → `/recycle/`, restore → `/staging/`.
- **AI client** — `AiClient` in `services/ai_client.rs` handles multi-model routing with 5 task slots. Always provide offline fallbacks.

### React/TypeScript (src/)
- **Strict typing** — No `any`. DTO keys must align with backend camelCase contracts.
- **IPC layer** — All Tauri invocations go through `src/lib/api.ts` (never raw `invoke` in components).
- **Test IDs** — Add `data-testid` on interactive controls and stateful cards for E2E tests.
- **Accessibility** — `label` + `htmlFor` on all form inputs; don't rely on placeholders alone.
- **Busy states** — Guard async actions with loading UI and disable controls while processing.

### Testing
- **Fixtures** — Use deterministic seeded fixtures. Profiles: `review-duplicates`, `date-approval`, etc.
- **Selectors** — Prefer `data-testid` over brittle text locators.
- **Structure** — One flow per test, clear arrange/act/assert.
- **No sleeps** — Wait on explicit UI states or command completion signals.
- **Artifacts** — CI uploads Playwright traces/screenshots on failure.

---

## AI Pipeline Details

Five independently configurable model slots:

| Slot | Purpose | Required |
|---|---|---|
| Date Estimation — Primary | Estimates missing EXIF dates | Yes |
| Date Estimation — Fallback | Backup for date estimation | No |
| Grouping Pass 1 — Cluster Analysis | Derives event clues + travel indicators | No (falls back to Pass 2 model) |
| Grouping Pass 2 — Event Naming | Produces final folder name | Yes |
| Event Naming — Fallback | Backup for event naming | No |

- Providers: **OpenAI** and **Anthropic**. Each slot can use any provider/model combo.
- When AI is unavailable: date estimation returns null + zero confidence (user enters manually); event naming falls back to location-aware or date-based names.
- Banned name list prevents generic outputs ("Family Gathering", "Weekend Moments").
- Home location enables away-from-home detection for destination-aware naming.

---

## Important Notes for Agents

1. **`src/App.tsx` is a monolith (~154K)** — All views (Dashboard, Image Review, Video Review, Date Approval, Event Groups, Settings) live in one file. Be careful with edits; understand the full component structure before modifying.

2. **Dual-key IPC args** — `api.ts` sends both camelCase and snake_case keys (e.g., `mediaItemId` and `media_item_id`) because Tauri's deserialization can vary. Maintain this pattern.

3. **Test browser mock** — `window.__MEMORIA_TEST_API__` provides a test shim so Playwright browser tests work without a real Tauri backend.

4. **Vendor binaries not in git** — `exiftool.exe` and `ffmpeg.exe` in `vendor/` are gitignored. CI creates empty placeholders. For actual dev, download the real binaries (see `vendor/README.md`).

5. **Windows-first** — macOS is a future milestone. Path handling, credential storage, and CI all target Windows. The `\\?\` extended-length prefix is used internally for long paths.

6. **SQLite WAL mode** — The database uses WAL for concurrent read performance. Migrations must be idempotent and additive.

7. **Progress events** — Long-running operations emit `pipeline-progress` Tauri events consumed by the frontend's `LoadingState` component for real-time progress bars.

8. **Fixture seeding** — CLI: `memoria.exe --seed-fixture <profile>`. Also available via Tauri command `seed_test_fixture`. Profiles must create both DB rows and real media files.

---

## CI Pipeline

```
lint (ubuntu) → frontend-build (windows + ubuntu) → rust-tests (windows) → ui-browser (ubuntu) → ui-desktop-windows (windows)
```

- Rust tests and desktop E2E run on `windows-latest` (Tauri/WebView2 requirement)
- Browser E2E runs on `ubuntu-latest` (headless Chromium)
- Playwright artifacts uploaded on failure for diagnosis
- Vendor placeholders created in CI (empty files) since real binaries aren't committed

---

## Existing Cursor Rules

The `.cursor/rules/` directory contains three rule files that are already loaded by Cursor. They cover:
- `memoria-stack-best-practices.mdc` — Cross-cutting engineering standards (always applied)
- `rust-tauri-conventions.mdc` — Rust backend conventions (applied to `src-tauri/**/*.rs`)
- `playwright-testing-conventions.mdc` — E2E testing conventions (applied to `tests/ui/**/*.ts`)

These rules remain authoritative for their respective scopes. This CLAUDE.md provides the broader project context that those rules assume you already have.

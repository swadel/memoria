import { useEffect, useMemo, useState } from "react";
import {
  applyDateApproval,
  applyReviewAction,
  finalizeOrganization,
  getDashboardStats,
  getDateReviewQueue,
  getEventGroups,
  getReviewQueue,
  initializeApp,
  renameEventGroup,
  runClassification,
  runEventGrouping,
  setIcloudCredentials,
  setOpenAiKey,
  setOutputDirectory,
  startDownloadSession
} from "./lib/api";
import type { DashboardStats, DateEstimate, EventGroup, MediaItem } from "./types";

type Tab = "dashboard" | "review" | "dates" | "events" | "settings";

const DEFAULT_STATS: DashboardStats = {
  total: 0,
  downloading: 0,
  review: 0,
  legitimate: 0,
  dateNeedsReview: 0,
  grouped: 0,
  filed: 0,
  errors: 0
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [reviewItems, setReviewItems] = useState<MediaItem[]>([]);
  const [dateItems, setDateItems] = useState<DateEstimate[]>([]);
  const [groups, setGroups] = useState<EventGroup[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
  const [message, setMessage] = useState<string>("");

  const [dateRangeStart, setDateRangeStart] = useState("2026-01-01");
  const [dateRangeEnd, setDateRangeEnd] = useState("2026-02-01");
  const [outputDirectory, setOutputDirectory] = useState("C:\\Memoria");
  const [icloudUsername, setIcloudUsername] = useState("");
  const [icloudPassword, setIcloudPassword] = useState("");
  const [icloudMfaCode, setIcloudMfaCode] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedCountLabel = useMemo(() => `${selectedReviewIds.length} selected`, [selectedReviewIds]);

  async function refreshAll() {
    const [s, rq, dq, eg] = await Promise.all([
      getDashboardStats(),
      getReviewQueue(),
      getDateReviewQueue(),
      getEventGroups()
    ]);
    setStats(s);
    setReviewItems(rq);
    setDateItems(dq);
    setGroups(eg);
  }

  useEffect(() => {
    initializeApp()
      .then(refreshAll)
      .catch((err) => setMessage(`Initialization failed: ${String(err)}`));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshAll().catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (tab !== "review") return;
      if (e.key.toLowerCase() === "i") {
        void onApplyReview("include");
      }
      if (e.key.toLowerCase() === "d") {
        void onApplyReview("delete");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, selectedReviewIds]);

  async function onStart() {
    setBusyAction("download");
    try {
      await setOutputDirectory(outputDirectory);
      await startDownloadSession({ dateRangeStart, dateRangeEnd, outputDirectory });
      setMessage("Download session started.");
      await refreshAll();
    } finally {
      setBusyAction(null);
    }
  }

  async function onClassify() {
    setBusyAction("classify");
    try {
      await runClassification();
      setMessage("Classification complete.");
      await refreshAll();
    } finally {
      setBusyAction(null);
    }
  }

  async function onApplyReview(action: "include" | "delete") {
    if (selectedReviewIds.length === 0) return;
    await applyReviewAction(selectedReviewIds, action);
    setSelectedReviewIds([]);
    setMessage(`Applied '${action}' to ${selectedReviewIds.length} items.`);
    await refreshAll();
  }

  async function onRunGrouping() {
    setBusyAction("group");
    try {
      await runEventGrouping();
      setMessage("Grouping generated.");
      await refreshAll();
    } finally {
      setBusyAction(null);
    }
  }

  async function onFinalize() {
    setBusyAction("finalize");
    try {
      await finalizeOrganization();
      setMessage("Organization finalized.");
      await refreshAll();
    } finally {
      setBusyAction(null);
    }
  }

  async function onSaveCredentials() {
    if (!icloudUsername || !icloudPassword) {
      setMessage("Enter iCloud username and password first.");
      return;
    }
    await setIcloudCredentials(icloudUsername, icloudPassword, icloudMfaCode || undefined);
    setMessage("iCloud credentials saved in Windows Credential Manager.");
  }

  async function onSaveOpenAiKey() {
    if (!openAiKey) {
      setMessage("Enter an OpenAI API key first.");
      return;
    }
    await setOpenAiKey(openAiKey);
    setMessage("OpenAI API key saved in Windows Credential Manager.");
  }

  return (
    <div className="layout">
      <div className="topbar">
        <div>
          <h1 className="title">Memoria</h1>
          <p className="subtitle">iCloud Photos Organizer</p>
        </div>
        <div className="statusPill">{message || "Ready"}</div>
      </div>
      <div className="tabStrip">
        <button className={tab === "dashboard" ? "tab active" : "tab"} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button className={tab === "review" ? "tab active" : "tab"} onClick={() => setTab("review")}>
          Review Queue
        </button>
        <button className={tab === "dates" ? "tab active" : "tab"} onClick={() => setTab("dates")}>
          Date Approval
        </button>
        <button className={tab === "events" ? "tab active" : "tab"} onClick={() => setTab("events")}>
          Event Groups
        </button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "dashboard" && (
        <>
          <div className="statsGrid">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Downloading" value={stats.downloading} />
            <StatCard label="Review Queue" value={stats.review} />
            <StatCard label="Legitimate" value={stats.legitimate} />
            <StatCard label="Date Review" value={stats.dateNeedsReview} />
            <StatCard label="Grouped" value={stats.grouped} />
            <StatCard label="Filed" value={stats.filed} />
            <StatCard label="Errors" value={stats.errors} danger={stats.errors > 0} />
          </div>

          <div className="card">
            <h3>Run Pipeline</h3>
            <div className="row">
              <input type="date" value={dateRangeStart} onChange={(e) => setDateRangeStart(e.target.value)} />
              <input type="date" value={dateRangeEnd} onChange={(e) => setDateRangeEnd(e.target.value)} />
              <input
                className="wideInput"
                value={outputDirectory}
                onChange={(e) => setOutputDirectory(e.target.value)}
                placeholder="Output directory"
              />
            </div>
            <div className="row">
              <button className="primaryBtn" disabled={busyAction !== null} onClick={onStart}>
                {busyAction === "download" ? "Downloading..." : "1) Download"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onClassify}>
                {busyAction === "classify" ? "Classifying..." : "2) Classify"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onRunGrouping}>
                {busyAction === "group" ? "Grouping..." : "3) Group"}
              </button>
              <button className="secondaryBtn" disabled={busyAction !== null} onClick={onFinalize}>
                {busyAction === "finalize" ? "Finalizing..." : "4) Finalize"}
              </button>
            </div>
            <div className="progressTrack">
              <div
                className="progressFill"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(((stats.filed + stats.grouped + stats.legitimate) / Math.max(stats.total, 1)) * 100)
                  )}%`
                }}
              />
            </div>
            <div className="muted">Pipeline progress timeline updates every 3 seconds.</div>
          </div>
        </>
      )}

      {tab === "review" && (
        <div className="card">
          <h3>Review Queue</h3>
          <div className="row">
            <span className="muted">{selectedCountLabel}</span>
            <button className="secondaryBtn" onClick={() => onApplyReview("include")}>
              Include
            </button>
            <button className="secondaryBtn" onClick={() => onApplyReview("delete")}>
              Delete (to recycle)
            </button>
          </div>
          <div className="grid">
            {reviewItems.map((item) => (
              <div key={item.id} className="item">
                <label className="row">
                  <input
                    type="checkbox"
                    checked={selectedReviewIds.includes(item.id)}
                    onChange={(e) => {
                      setSelectedReviewIds((prev) =>
                        e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)
                      );
                    }}
                  />
                  <span>{item.filename}</span>
                </label>
                <div className="muted">{item.currentPath}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "dates" && (
        <div className="card">
          <h3>Date Metadata Approval</h3>
          <div className="grid">
            {dateItems.map((item) => (
              <DateCard
                key={item.mediaItemId}
                item={item}
                onApply={async (date) => {
                  await applyDateApproval(item.mediaItemId, date);
                  await refreshAll();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "events" && (
        <div className="card">
          <h3>Event Group Review</h3>
          <div className="grid">
            {groups.map((group) => (
              <EventCard
                key={group.id}
                group={group}
                onRename={async (name) => {
                  await renameEventGroup(group.id, name);
                  await refreshAll();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="card">
          <h3>Settings</h3>
          <p className="muted">Credentials are stored in Windows Credential Manager via Rust keyring.</p>
          <div className="row">
            <input
              style={{ minWidth: 260 }}
              placeholder="iCloud Apple ID email"
              value={icloudUsername}
              onChange={(e) => setIcloudUsername(e.target.value)}
            />
            <input
              type="password"
              style={{ minWidth: 260 }}
              placeholder="iCloud app-specific password / password"
              value={icloudPassword}
              onChange={(e) => setIcloudPassword(e.target.value)}
            />
            <input
              style={{ minWidth: 160 }}
              placeholder="MFA code (optional)"
              value={icloudMfaCode}
              onChange={(e) => setIcloudMfaCode(e.target.value)}
            />
            <button className="primaryBtn" onClick={onSaveCredentials}>
              Save iCloud Credentials
            </button>
          </div>
          <div className="row">
            <input
              type="password"
              style={{ minWidth: 420 }}
              placeholder="OpenAI API Key"
              value={openAiKey}
              onChange={(e) => setOpenAiKey(e.target.value)}
            />
            <button className="secondaryBtn" onClick={onSaveOpenAiKey}>
              Save OpenAI Key
            </button>
          </div>
          <div className="muted">
            Tip: configure output directory in Dashboard, then run Download → Classify → Group → Finalize.
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="card statCard">
      <div className="muted">{label}</div>
      <div className={danger ? "statValue danger" : "statValue"}>{value}</div>
    </div>
  );
}

function DateCard({
  item,
  onApply
}: {
  item: DateEstimate;
  onApply: (date: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(item.aiDate ?? "");
  return (
    <div className="item">
      <strong>{item.filename}</strong>
      <div className="muted">Current: {item.currentDate ?? "(missing)"}</div>
      <div className="muted">AI: {item.aiDate ?? "(none)"} ({Math.round(item.confidence * 100)}%)</div>
      <div className="muted">{item.reasoning}</div>
      <div className="row">
        <input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
        <button onClick={() => onApply(value || null)}>Approve/Edit</button>
        <button onClick={() => onApply(null)}>Skip</button>
      </div>
    </div>
  );
}

function EventCard({
  group,
  onRename
}: {
  group: EventGroup;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(group.name);
  return (
    <div className="item">
      <strong>{group.folderName}</strong>
      <div className="muted">{group.itemCount} items</div>
      <div className="row">
        <input value={value} onChange={(e) => setValue(e.target.value)} />
        <button onClick={() => onRename(value)}>Rename</button>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

export function AppShell({
  title,
  subtitle,
  status,
  progress,
  stepper,
  settingsAction,
  children
}: {
  title: string;
  subtitle: string;
  status: string;
  progress: number;
  stepper: ReactNode;
  settingsAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="layout" data-testid="layout-root">
      <div className="globalProgressTrack" aria-hidden="true">
        <div className="globalProgressFill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
      <header className="appShellHeader">
        <div className="topbar mica-surface">
          <div className="appBrand">
            <span className="appLogo" aria-hidden="true">
              <span className="appLogoPetal appLogoPetalBlue" />
              <span className="appLogoPetal appLogoPetalOrange" />
              <span className="appLogoPetal appLogoPetalPurple" />
            </span>
            <div>
            <h1 className="title">{title}</h1>
            <p className="subtitle">{subtitle}</p>
            </div>
          </div>
          <div className="statusPill" data-testid="status-pill">
            {status}
          </div>
        </div>
        <div className="workflowHeader mica-surface" data-testid="tab-strip">
          {stepper}
          {settingsAction ? <div className="workflowHeaderAction">{settingsAction}</div> : null}
        </div>
      </header>
      <main className="appShellContent">{children}</main>
    </div>
  );
}

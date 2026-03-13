import type { ReactNode } from "react";
import logoImage from "../assets/logo.png";

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
      <header className="appShellHeader mica-surface bg-white/70 backdrop-blur-xl">
        <div className="topbar">
          <div className="appBrand">
            <img
              src={logoImage}
              alt=""
              aria-hidden="true"
              className="appLogo h-10 w-10 drop-shadow-[0_2px_10px_rgba(0,0,0,0.1)]"
            />
            <div>
            <h1 className="title font-semibold text-2xl tracking-tighter">{title}</h1>
            <p className="subtitle">{subtitle}</p>
            </div>
          </div>
          <div className="statusPill" data-testid="status-pill">
            {status}
          </div>
        </div>
        <div className="workflowHeader" data-testid="tab-strip">
          {stepper}
          {settingsAction ? <div className="workflowHeaderAction">{settingsAction}</div> : null}
        </div>
      </header>
      <main className="appShellContent">{children}</main>
    </div>
  );
}

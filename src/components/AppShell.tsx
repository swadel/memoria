import type { ReactNode } from "react";
import { BrandLogo } from "./UI/BrandLogo";

export function AppShell({
  title,
  subtitle,
  status,
  progress,
  stepper,
  settingsAction,
  onHomeClick,
  children
}: {
  title: string;
  subtitle: string;
  status: string;
  progress: number;
  stepper: ReactNode;
  settingsAction?: ReactNode;
  onHomeClick?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="layout" data-testid="layout-root">
      <div className="globalProgressTrack" aria-hidden="true">
        <div className="globalProgressFill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
      <header className="appShellHeader mica-surface bg-white/70 backdrop-blur-xl">
        <div className="headerMainRow" data-testid="tab-strip">
          <div className="appBrand">
            <BrandLogo size="h-12" text={title} onClick={onHomeClick} />
          </div>
          <div className="headerNavRow">
            <div className="workflowHeader">
              {stepper}
            </div>
            {settingsAction ? <div className="workflowHeaderAction">{settingsAction}</div> : null}
          </div>
          <div className="statusPill" data-testid="status-pill">
            {status || subtitle}
          </div>
        </div>
      </header>
      <main className="appShellContent">{children}</main>
    </div>
  );
}

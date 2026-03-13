import type { ReactNode } from "react";

export function AppShell({
  title,
  subtitle,
  status,
  stepper,
  navigation,
  children
}: {
  title: string;
  subtitle: string;
  status: string;
  stepper: ReactNode;
  navigation: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="layout" data-testid="layout-root">
      <header className="appShellHeader">
        <div className="topbar">
          <div>
            <h1 className="title">{title}</h1>
            <p className="subtitle">{subtitle}</p>
          </div>
          <div className="statusPill" data-testid="status-pill">
            {status}
          </div>
        </div>
        {stepper}
        {navigation}
      </header>
      <main className="appShellContent">{children}</main>
    </div>
  );
}

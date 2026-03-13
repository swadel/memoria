import type { ReactNode } from "react";

export function PageHeader({
  title,
  summary,
  action
}: {
  title: string;
  summary?: string;
  action?: ReactNode;
}) {
  return (
    <div className="pageHeader">
      <div>
        <h2 className="pageTitle">{title}</h2>
        {summary ? <p className="pageSummary">{summary}</p> : null}
      </div>
      {action ? <div className="pageHeaderAction">{action}</div> : null}
    </div>
  );
}

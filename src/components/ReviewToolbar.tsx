import type { ReactNode } from "react";

export function ReviewToolbar({
  left,
  right,
  testId
}: {
  left?: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="reviewToolbar item" data-testid={testId}>
      <div className="reviewToolbarLeft">{left}</div>
      <div className="reviewToolbarRight">{right}</div>
    </div>
  );
}

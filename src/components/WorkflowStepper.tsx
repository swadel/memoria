export type WorkflowStepState = "complete" | "current" | "pending";

export function WorkflowStepper({
  steps
}: {
  steps: Array<{ id: string; label: string; state: WorkflowStepState; disabled?: boolean; onClick?: () => void; testId?: string; pendingCount?: number }>;
}) {
  return (
    <div className="workflowStepper" data-testid="workflow-stepper">
      {steps.map((step, index) => (
        <div className="workflowStepWrap" key={step.id}>
          <button
            type="button"
            className={`workflowStep workflowStep${capitalize(step.state)}`}
            data-testid={step.testId ?? `workflow-step-${step.id}`}
            data-workflow-step={`workflow-step-${step.id}`}
            aria-current={step.state === "current" ? "step" : undefined}
            disabled={step.disabled}
            onClick={step.onClick}
          >
            <span className="workflowStepPetal" aria-hidden="true">
              <span className="workflowStepPetalDot workflowStepPetalDotA" />
              <span className="workflowStepPetalDot workflowStepPetalDotB" />
              <span className="workflowStepPetalDot workflowStepPetalDotC" />
            </span>
            <span className="workflowStepLabel">{step.label}</span>
            {step.pendingCount && step.pendingCount > 0 ? (
              <span className="workflowStepBadge" data-testid={`workflow-step-badge-${step.id}`}>{step.pendingCount}</span>
            ) : null}
          </button>
          {index < steps.length - 1 ? <div className="workflowStepConnector" aria-hidden="true" /> : null}
        </div>
      ))}
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

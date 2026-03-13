export type WorkflowStepState = "complete" | "current" | "pending";

export function WorkflowStepper({
  steps
}: {
  steps: Array<{ id: string; label: string; state: WorkflowStepState; disabled?: boolean; onClick?: () => void; testId?: string }>;
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

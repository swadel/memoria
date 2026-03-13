export type WorkflowStepState = "complete" | "current" | "pending";

export function WorkflowStepper({
  steps
}: {
  steps: Array<{ id: string; label: string; state: WorkflowStepState }>;
}) {
  return (
    <div className="workflowStepper" data-testid="workflow-stepper">
      {steps.map((step, index) => (
        <div className="workflowStepWrap" key={step.id}>
          <div
            className={`workflowStep workflowStep${capitalize(step.state)}`}
            data-testid={`workflow-step-${step.id}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="workflowStepIndex">{index + 1}</span>
            <span className="workflowStepLabel">{step.label}</span>
          </div>
          {index < steps.length - 1 ? <div className="workflowStepConnector" aria-hidden="true" /> : null}
        </div>
      ))}
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

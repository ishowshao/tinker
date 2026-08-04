import { Box, Text } from "ink";
import type { TimelineItem } from "../event-store";

export function PlanView(props: { plan: NonNullable<TimelineItem["plan"]> }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {props.plan.explanation === undefined ? null : (
        <Text dimColor italic>
          {props.plan.explanation}
        </Text>
      )}
      {props.plan.steps.length === 0 ? (
        <Text dimColor italic>
          (no steps)
        </Text>
      ) : (
        props.plan.steps.map((step, index) => (
          <PlanStepRow key={`${index}:${step.step}`} step={step} />
        ))
      )}
    </Box>
  );
}

function PlanStepRow(props: {
  step: NonNullable<TimelineItem["plan"]>["steps"][number];
}) {
  if (props.step.status === "completed") {
    return (
      <Text dimColor strikethrough>
        ✓ {props.step.step}
      </Text>
    );
  }
  if (props.step.status === "in_progress") {
    return (
      <Text color="cyan" bold>
        → {props.step.step}
      </Text>
    );
  }
  return <Text dimColor>• {props.step.step}</Text>;
}

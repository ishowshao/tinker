import { Box, Text } from "ink";
import type { RuntimeSkillsSnapshot } from "../../agent/runtime-session";

export function SkillsPanel(props: { snapshot: RuntimeSkillsSnapshot }) {
  return (
    <Box flexDirection="column">
      <Text bold>Agent Skills</Text>
      {props.snapshot.skills.length === 0 ? (
        <Text color="yellow"> no skills available</Text>
      ) : (
        props.snapshot.skills.map((skill) => (
          <Box key={skill.name} flexDirection="column">
            <Text>
              {" "}
              <Text bold>{skill.name}</Text>
              {` (${skill.scope}${skill.active ? ", active" : ""})`}
            </Text>
            <Text dimColor> {skill.description}</Text>
          </Box>
        ))
      )}
      {props.snapshot.shadowedNames.length === 0 ? null : (
        <>
          <Text> </Text>
          <Text bold>Shadowed user skills</Text>
          <Text> {props.snapshot.shadowedNames.join(", ")}</Text>
        </>
      )}
    </Box>
  );
}

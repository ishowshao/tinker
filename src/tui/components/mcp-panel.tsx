import { Box, Text } from "ink";
import type { McpInventorySnapshot } from "../../mcp/mcp-manager";

export function McpPanel(props: { snapshot: McpInventorySnapshot }) {
  return (
    <Box flexDirection="column">
      <Text bold>MCP Tools</Text>
      {props.snapshot.servers.length === 0 ? (
        <Text color="yellow"> no MCP servers configured</Text>
      ) : (
        props.snapshot.servers.map((server) => (
          <Box key={server.name} flexDirection="column">
            <Text>
              {" "}
              <Text bold>{server.name}</Text>
              {` (connected, ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"})`}
            </Text>
            <Text dimColor>
              {server.tools.length === 0
                ? "  no tools available"
                : `  ${server.tools.join(", ")}`}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

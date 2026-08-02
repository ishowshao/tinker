/**
 * Compact AX formatter adapted from ChromeDevTools/chrome-devtools-mcp
 * SnapshotFormatter (Apache-2.0).
 */
import type { TextSnapshot, TextSnapshotNode } from "./text-snapshot";

export type FormattedSnapshot = {
  text: string;
  truncated: boolean;
};

export class SnapshotFormatter {
  constructor(private readonly snapshot: TextSnapshot) {}

  toBoundedString(maxCodePoints: number): FormattedSnapshot {
    if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints <= 0) {
      throw new Error("Snapshot output limit must be a positive integer.");
    }
    const output: string[] = [];
    const state = { codePoints: 0, truncated: false };
    this.collectBoundedLines(this.snapshot.root, 0, maxCodePoints, output, state);
    return { text: output.join(""), truncated: state.truncated };
  }

  private collectBoundedLines(
    node: TextSnapshotNode,
    depth: number,
    maxCodePoints: number,
    output: string[],
    state: { codePoints: number; truncated: boolean },
  ): boolean {
    const line = `${" ".repeat(depth * 2)}${this.attributes(node).join(" ")}\n`;
    const lineLength = codePointLength(line);
    if (state.codePoints + lineLength > maxCodePoints) {
      const prefix = `${output.join("")}${line}`;
      output.splice(0, output.length, truncateWithMarker(prefix, maxCodePoints));
      state.codePoints = maxCodePoints;
      state.truncated = true;
      return false;
    }
    output.push(line);
    state.codePoints += lineLength;
    for (const child of node.children) {
      if (!this.collectBoundedLines(child, depth + 1, maxCodePoints, output, state)) {
        return false;
      }
    }
    return true;
  }

  private attributes(node: TextSnapshotNode): string[] {
    const attributes = [`uid=${node.id}`];
    if (node.role) {
      attributes.push(node.role === "none" ? "ignored" : node.role);
    }
    if (node.name) {
      attributes.push(`"${node.name}"`);
    }
    const simple = this.extractedAttributes(node);
    for (const attribute of Object.keys(node).sort()) {
      if (EXCLUDED_ATTRIBUTES.has(attribute)) {
        continue;
      }
      const mapped = BOOLEAN_PROPERTY_MAP[attribute];
      if (mapped !== undefined && simple[mapped]) {
        attributes.push(mapped);
      }
      const value = simple[attribute];
      if (value === true) {
        attributes.push(attribute);
      } else if (typeof value === "string" || typeof value === "number") {
        attributes.push(`${attribute}="${value}"`);
      }
    }
    return attributes;
  }

  private extractedAttributes(node: TextSnapshotNode): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const attribute of Object.keys(node).sort()) {
      if (EXCLUDED_ATTRIBUTES.has(attribute)) {
        continue;
      }
      const value = (node as unknown as Record<string, unknown>)[attribute];
      if (typeof value === "boolean") {
        const mapped = BOOLEAN_PROPERTY_MAP[attribute];
        if (mapped !== undefined) {
          result[mapped] = true;
        }
        if (value) {
          result[attribute] = true;
        }
      } else if (typeof value === "string" || typeof value === "number") {
        result[attribute] = value;
      }
    }
    return result;
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateWithMarker(value: string, maxCodePoints: number): string {
  const marker = "... snapshot truncated ...\n";
  const markerLength = codePointLength(marker);
  const codePoints = Array.from(value);
  if (markerLength > maxCodePoints) {
    return codePoints.slice(0, maxCodePoints).join("");
  }
  return `${codePoints.slice(0, maxCodePoints - markerLength).join("")}${marker}`;
}

const BOOLEAN_PROPERTY_MAP: Record<string, string> = {
  disabled: "disableable",
  expanded: "expandable",
  focused: "focusable",
  selected: "selectable",
};

const EXCLUDED_ATTRIBUTES = new Set([
  "id",
  "role",
  "name",
  "elementHandle",
  "children",
  "backendNodeId",
  "loaderId",
]);

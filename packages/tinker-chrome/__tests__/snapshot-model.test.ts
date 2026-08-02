import { describe, expect, test } from "bun:test";
import type { SerializedAXNode } from "puppeteer-core";
import { parseKey } from "../extension/src/keyboard";
import { SnapshotFormatter } from "../extension/src/snapshot-formatter";
import {
  TextSnapshot,
  TextSnapshotState,
  type TextSnapshotNode,
} from "../extension/src/text-snapshot";

describe("Tinker Chrome accessibility snapshots", () => {
  test("reuses UIDs for the same loader/backend node and invalidates them on navigation", () => {
    const state = new TextSnapshotState();
    const first = state.assignUids(
      axNode(1, "loader-a", [axNode(2, "loader-a")]),
      false,
    );
    const firstRootUid = first.root.id;
    const firstChildUid = first.root.children[0]?.id;

    const second = state.assignUids(
      axNode(1, "loader-a", [axNode(2, "loader-a")]),
      false,
    );
    expect(second.root.id).toBe(firstRootUid);
    expect(second.root.children[0]?.id).toBe(firstChildUid);

    state.assignUids(axNode(1, "loader-a"), false);
    const afterRemoval = state.assignUids(
      axNode(1, "loader-a", [axNode(2, "loader-a")]),
      false,
    );
    expect(afterRemoval.root.id).toBe(firstRootUid);
    expect(afterRemoval.root.children[0]?.id).not.toBe(firstChildUid);

    state.invalidateForNavigation();
    const afterNavigation = state.assignUids(
      axNode(1, "loader-a", [axNode(2, "loader-a")]),
      false,
    );
    expect(afterNavigation.root.id).not.toBe(firstRootUid);
    expect(afterNavigation.root.children[0]?.id).not.toBe(
      afterRemoval.root.children[0]?.id,
    );
  });

  test("formats the compact upstream shape and never exceeds the code-point limit", () => {
    const root = snapshotNode({
      id: "1_0",
      role: "RootWebArea",
      name: "Example",
      focused: false,
      children: [
        snapshotNode({
          id: "1_1",
          role: "link",
          name: "Learn more",
          selected: true,
        }),
      ],
    });
    const compact = new SnapshotFormatter(
      new TextSnapshot({ root, idToNode: indexNodes(root), verbose: false }),
    ).toBoundedString(1_000);
    expect(compact).toEqual({
      text: [
        'uid=1_0 RootWebArea "Example" focusable',
        '  uid=1_1 link "Learn more" selectable selected',
        "",
      ].join("\n"),
      truncated: false,
    });

    const largeRoot = snapshotNode({
      id: "2_0",
      role: "RootWebArea",
      name: "😀".repeat(100),
    });
    const formatter = new SnapshotFormatter(
      new TextSnapshot({
        root: largeRoot,
        idToNode: indexNodes(largeRoot),
        verbose: false,
      }),
    );
    const bounded = formatter.toBoundedString(40);
    expect(Array.from(bounded.text)).toHaveLength(40);
    expect(bounded.text).toEndWith("... snapshot truncated ...\n");
    expect(bounded.truncated).toBe(true);

    const tiny = formatter.toBoundedString(5);
    expect(Array.from(tiny.text)).toHaveLength(5);
    expect(tiny.truncated).toBe(true);
  });
});

describe("Tinker Chrome key parsing", () => {
  test("ports key-combination parsing and validates before dispatch", () => {
    expect(parseKey("Control+Shift+R")).toEqual(["R", "Control", "Shift"]);
    expect(parseKey("Control++")).toEqual(["+", "Control"]);
    expect(() => parseKey("NoSuchKey")).toThrow("is not a supported Puppeteer key");
    expect(() => parseKey("Enter+A")).toThrow("Enter is not a supported modifier");
    expect(() => parseKey("Shift")).toThrow("must end in a non-modifier key");
  });
});

function axNode(
  backendNodeId: number,
  loaderId: string,
  children: SerializedAXNode[] = [],
): SerializedAXNode {
  return {
    role: backendNodeId === 1 ? "RootWebArea" : "link",
    name: `node-${backendNodeId}`,
    backendNodeId,
    loaderId,
    children,
    elementHandle: async () => null,
  } as unknown as SerializedAXNode;
}

function snapshotNode(
  input: Partial<TextSnapshotNode> & Pick<TextSnapshotNode, "id" | "role">,
): TextSnapshotNode {
  return {
    children: [],
    elementHandle: async () => null,
    ...input,
  };
}

function indexNodes(root: TextSnapshotNode): Map<string, TextSnapshotNode> {
  const index = new Map<string, TextSnapshotNode>();
  const visit = (node: TextSnapshotNode) => {
    index.set(node.id, node);
    node.children.forEach(visit);
  };
  visit(root);
  return index;
}

/**
 * Accessibility snapshot UID assignment adapted from ChromeDevTools/
 * chrome-devtools-mcp TextSnapshot (Apache-2.0).
 */
import type { Page, SerializedAXNode } from "puppeteer-core";

export interface TextSnapshotNode extends SerializedAXNode {
  id: string;
  backendNodeId?: number;
  loaderId?: string;
  children: TextSnapshotNode[];
}

export class TextSnapshot {
  readonly root: TextSnapshotNode;
  readonly idToNode: Map<string, TextSnapshotNode>;
  readonly verbose: boolean;

  constructor(options: {
    root: TextSnapshotNode;
    idToNode: Map<string, TextSnapshotNode>;
    verbose: boolean;
  }) {
    this.root = options.root;
    this.idToNode = options.idToNode;
    this.verbose = options.verbose;
  }
}

export class TextSnapshotState {
  private readonly uniqueBackendNodeIdToUid = new Map<string, string>();
  private nextSnapshotId = 1;

  async capture(page: Page, verbose: boolean): Promise<TextSnapshot> {
    const root = await page.accessibility.snapshot({
      includeIframes: true,
      interestingOnly: !verbose,
    });
    if (root === null) {
      throw new Error("Failed to create an accessibility snapshot.");
    }
    return this.assignUids(root, verbose);
  }

  assignUids(root: SerializedAXNode, verbose: boolean): TextSnapshot {
    const snapshotId = this.nextSnapshotId++;
    let idCounter = 0;
    const idToNode = new Map<string, TextSnapshotNode>();
    const seenUniqueIds = new Set<string>();

    const assign = (node: SerializedAXNode): TextSnapshotNode => {
      const backendNodeId = (node as SerializedAXNode & { backendNodeId?: number })
        .backendNodeId;
      const loaderId = (node as SerializedAXNode & { loaderId?: string }).loaderId;
      const uniqueBackendId = `${loaderId}_${backendNodeId}`;
      let id = this.uniqueBackendNodeIdToUid.get(uniqueBackendId);
      if (id === undefined) {
        id = `${snapshotId}_${idCounter++}`;
        this.uniqueBackendNodeIdToUid.set(uniqueBackendId, id);
      }
      seenUniqueIds.add(uniqueBackendId);

      const nodeWithId: TextSnapshotNode = {
        ...node,
        id,
        children: (node.children ?? []).map(assign),
      };
      if (node.role === "option" && node.name) {
        nodeWithId.value = node.name.toString();
      }
      idToNode.set(id, nodeWithId);
      return nodeWithId;
    };

    const rootWithIds = assign(root);
    for (const key of this.uniqueBackendNodeIdToUid.keys()) {
      if (!seenUniqueIds.has(key)) {
        this.uniqueBackendNodeIdToUid.delete(key);
      }
    }
    return new TextSnapshot({ root: rootWithIds, idToNode, verbose });
  }

  invalidateForNavigation(): void {
    this.uniqueBackendNodeIdToUid.clear();
  }
}

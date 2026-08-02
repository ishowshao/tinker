import type { Page } from "puppeteer-core";
import { ChromeBridgeError } from "../../src/errors";
import type {
  ConsoleMessageTypeV2,
  GetConsoleMessageResultV2,
  GetNetworkRequestResultV2,
  ListConsoleMessagesParamsV2,
  ListConsoleMessagesResultV2,
  ListNetworkRequestsParamsV2,
  ListNetworkRequestsResultV2,
} from "../../src/protocol-v2";
import {
  formatConsoleDetail,
  formatConsoleList,
  formatNetworkDetail,
  formatNetworkList,
} from "./debug-formatters";
import { ConsoleCollector, NetworkCollector } from "./page-collector";

export class PageDebugSession {
  private readonly consoleCollector: ConsoleCollector;
  private readonly networkCollector: NetworkCollector;

  constructor(page: Page) {
    this.consoleCollector = new ConsoleCollector(page);
    this.networkCollector = new NetworkCollector(page);
  }

  dispose(): void {
    this.consoleCollector.dispose();
    this.networkCollector.dispose();
  }

  listConsoleMessages(
    params: ListConsoleMessagesParamsV2,
  ): ListConsoleMessagesResultV2 {
    const typeFilter = new Set(params.types);
    const entries = this.consoleCollector
      .getData(params.includePreservedMessages)
      .filter(({ item }) => {
        const type: ConsoleMessageTypeV2 =
          item instanceof Error ? "error" : item.type();
        return typeFilter.size === 0 || typeFilter.has(type);
      });
    const formatted = formatConsoleList(entries, params);
    return {
      schemaVersion: 2,
      pageId: params.pageId,
      pageIdx: formatted.pageIdx,
      pageSize: formatted.pageSize,
      totalMessages: formatted.totalItems,
      totalPages: formatted.totalPages,
      output: formatted.output,
      truncated: formatted.truncated,
    };
  }

  async getConsoleMessage(
    pageId: string,
    msgid: number,
  ): Promise<GetConsoleMessageResultV2> {
    const entry = this.consoleCollector.getById(msgid);
    if (entry === undefined) {
      throw new ChromeBridgeError({
        code: "CONSOLE_MESSAGE_NOT_FOUND",
        message: `Console message ${msgid} is not available for this page.`,
        retryable: false,
        outcome: "not_started",
      });
    }
    const formatted = await formatConsoleDetail(entry);
    return {
      schemaVersion: 2,
      pageId,
      msgid,
      output: formatted.output,
      truncated: formatted.truncated,
    };
  }

  listNetworkRequests(
    params: ListNetworkRequestsParamsV2,
  ): ListNetworkRequestsResultV2 {
    const typeFilter = new Set(params.resourceTypes);
    const entries = this.networkCollector
      .getData(params.includePreservedRequests)
      .filter(
        ({ item }) => typeFilter.size === 0 || typeFilter.has(item.resourceType()),
      );
    const formatted = formatNetworkList(entries, params);
    return {
      schemaVersion: 2,
      pageId: params.pageId,
      pageIdx: formatted.pageIdx,
      pageSize: formatted.pageSize,
      totalRequests: formatted.totalItems,
      totalPages: formatted.totalPages,
      output: formatted.output,
      truncated: formatted.truncated,
    };
  }

  async getNetworkRequest(
    pageId: string,
    reqid: number,
  ): Promise<GetNetworkRequestResultV2> {
    const entry = this.networkCollector.getById(reqid);
    if (entry === undefined) {
      throw new ChromeBridgeError({
        code: "NETWORK_REQUEST_NOT_FOUND",
        message: `Network request ${reqid} is not available for this page.`,
        retryable: false,
        outcome: "not_started",
      });
    }
    const formatted = await formatNetworkDetail(entry, (request) =>
      this.networkCollector.getIdForItem(request),
    );
    return {
      schemaVersion: 2,
      pageId,
      reqid,
      output: formatted.output,
      truncated: formatted.truncated,
    };
  }
}

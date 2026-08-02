/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-navigation resource collection adapted from ChromeDevTools/
 * chrome-devtools-mcp PageCollector.
 */
import type { ConsoleMessage, Frame, HTTPRequest, Page } from "puppeteer-core";
import {
  MAX_DEBUG_ITEMS_PER_NAVIGATION,
  MAX_DEBUG_NAVIGATIONS,
} from "../../src/constants";

export type CollectedItem<T> = {
  id: number;
  item: T;
};

export class PageCollector<T> {
  protected readonly storage: Array<Array<CollectedItem<T>>> = [[]];
  private nextId = 1;

  private readonly onFrameNavigated = (frame: Frame): void => {
    if (frame === this.page.mainFrame()) {
      this.splitAfterNavigation();
    }
  };

  constructor(
    protected readonly page: Page,
    private readonly maxItemsPerNavigation = MAX_DEBUG_ITEMS_PER_NAVIGATION,
  ) {
    page.on("framenavigated", this.onFrameNavigated);
  }

  dispose(): void {
    this.page.off("framenavigated", this.onFrameNavigated);
  }

  getData(includePreservedData: boolean): Array<CollectedItem<T>> {
    if (!includePreservedData) {
      return [...(this.storage[0] ?? [])];
    }
    return this.storage
      .slice()
      .reverse()
      .flatMap((navigation) => navigation);
  }

  getById(id: number): CollectedItem<T> | undefined {
    for (const navigation of this.storage) {
      const found = navigation.find((entry) => entry.id === id);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  getIdForItem(item: T): number | undefined {
    for (const navigation of this.storage) {
      const found = navigation.find((entry) => entry.item === item);
      if (found !== undefined) {
        return found.id;
      }
    }
    return undefined;
  }

  protected collect(item: T): void {
    const current = this.storage[0] ?? [];
    current.push({ id: this.nextId++, item });
    if (current.length > this.maxItemsPerNavigation) {
      current.splice(0, current.length - this.maxItemsPerNavigation);
    }
  }

  protected splitAfterNavigation(): void {
    this.storage.unshift([]);
    this.storage.splice(MAX_DEBUG_NAVIGATIONS);
  }
}

export type ConsoleEntry = ConsoleMessage | Error;

export class ConsoleCollector extends PageCollector<ConsoleEntry> {
  private readonly onConsole = (message: ConsoleMessage): void => {
    this.collect(message);
  };

  private readonly onPageError = (error: unknown): void => {
    this.collect(error instanceof Error ? error : new Error(String(error)));
  };

  constructor(page: Page) {
    super(page);
    page.on("console", this.onConsole);
    page.on("pageerror", this.onPageError);
  }

  override dispose(): void {
    this.page.off("console", this.onConsole);
    this.page.off("pageerror", this.onPageError);
    super.dispose();
  }
}

export class NetworkCollector extends PageCollector<HTTPRequest> {
  private readonly onRequest = (request: HTTPRequest): void => {
    this.collect(request);
  };

  constructor(page: Page) {
    super(page);
    page.on("request", this.onRequest);
  }

  override dispose(): void {
    this.page.off("request", this.onRequest);
    super.dispose();
  }

  protected override splitAfterNavigation(): void {
    const requests = this.storage[0] ?? [];
    let lastNavigationRequestIndex = -1;
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index]?.item;
      if (
        request !== undefined &&
        request.frame() === this.page.mainFrame() &&
        request.isNavigationRequest()
      ) {
        lastNavigationRequestIndex = index;
        break;
      }
    }
    if (lastNavigationRequestIndex === -1) {
      this.storage.unshift([]);
    } else {
      this.storage.unshift(requests.splice(lastNavigationRequestIndex));
    }
    this.storage.splice(MAX_DEBUG_NAVIGATIONS);
  }
}

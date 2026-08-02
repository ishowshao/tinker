import type { Browser, Dialog, ElementHandle, KeyInput, Page } from "puppeteer-core";
import {
  MAX_DIALOG_TEXT_CODE_POINTS,
  MAX_SNAPSHOT_CODE_POINTS,
} from "../../src/constants";
import { ChromeBridgeError } from "../../src/errors";
import type {
  DialogActionV2,
  GetConsoleMessageResultV2,
  GetNetworkRequestResultV2,
  ListConsoleMessagesParamsV2,
  ListConsoleMessagesResultV2,
  ListNetworkRequestsParamsV2,
  ListNetworkRequestsResultV2,
  NavigationTypeV2,
  OpenPageResultV2,
  PageActionResultV2,
  PageSnapshotV2,
  PageWaitResultV2,
  ScrollDirectionV2,
} from "../../src/protocol-v2";
import { PageDebugSession } from "./page-debug";
import { parseKey } from "./keyboard";
import { SnapshotFormatter } from "./snapshot-formatter";
import {
  TextSnapshot,
  type TextSnapshotNode,
  TextSnapshotState,
} from "./text-snapshot";

declare const Puppeteer: Pick<
  typeof import("puppeteer-core"),
  "connect" | "ExtensionTransport"
>;

const DEFAULT_TIMEOUT_MS = 5_000;
const PROTOCOL_TIMEOUT_MS = 10_000;
const EXPECT_NAVIGATION_MS = 100;
const NAVIGATION_SETTLE_TIMEOUT_MS = 3_000;
const NAVIGATION_OPERATION_TIMEOUT_MS = 25_000;
const STABLE_DOM_TIMEOUT_MS = 3_000;
const STABLE_DOM_FOR_MS = 100;

export class PageAutomationManager {
  private readonly sessions = new Map<number, PageAutomationSession>();

  async open(options: {
    pageId: string;
    tabId: number;
    url: string;
    timeoutMs: number;
  }): Promise<OpenPageResultV2> {
    return this.session(options.tabId).run((session) =>
      session.open(options.pageId, options.url, options.timeoutMs),
    );
  }

  async snapshot(options: {
    pageId: string;
    tabId: number;
    verbose: boolean;
  }): Promise<PageSnapshotV2> {
    return this.session(options.tabId).run((session) =>
      session.snapshot(options.pageId, options.verbose),
    );
  }

  async click(options: {
    pageId: string;
    tabId: number;
    uid: string;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.click(options.pageId, options.uid),
    );
  }

  async fill(options: {
    pageId: string;
    tabId: number;
    uid: string;
    value: string;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.fill(options.pageId, options.uid, options.value),
    );
  }

  async pressKey(options: {
    pageId: string;
    tabId: number;
    key: string;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.pressKey(options.pageId, options.key),
    );
  }

  async typeText(options: {
    pageId: string;
    tabId: number;
    text: string;
    submitKey: string | null;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.typeText(options.pageId, options.text, options.submitKey),
    );
  }

  async waitFor(options: {
    pageId: string;
    tabId: number;
    texts: string[];
    timeoutMs: number;
  }): Promise<PageWaitResultV2> {
    return this.session(options.tabId).run((session) =>
      session.waitFor(options.pageId, options.texts, options.timeoutMs),
    );
  }

  async scroll(options: {
    pageId: string;
    tabId: number;
    direction: ScrollDirectionV2;
    amount: number;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.scroll(options.pageId, options.direction, options.amount),
    );
  }

  async hover(options: {
    pageId: string;
    tabId: number;
    uid: string;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.hover(options.pageId, options.uid),
    );
  }

  async navigate(options: {
    pageId: string;
    tabId: number;
    type: NavigationTypeV2;
    url: string | null;
    ignoreCache: boolean;
    handleBeforeUnload: DialogActionV2;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.navigate(
        options.pageId,
        options.type,
        options.url,
        options.ignoreCache,
        options.handleBeforeUnload,
      ),
    );
  }

  async handleDialog(options: {
    pageId: string;
    tabId: number;
    action: DialogActionV2;
    promptText: string | null;
  }): Promise<PageActionResultV2> {
    return this.session(options.tabId).run((session) =>
      session.handleDialog(options.pageId, options.action, options.promptText),
    );
  }

  async listConsoleMessages(options: {
    tabId: number;
    params: ListConsoleMessagesParamsV2;
  }): Promise<ListConsoleMessagesResultV2> {
    return this.session(options.tabId).run((session) =>
      session.listConsoleMessages(options.params),
    );
  }

  async getConsoleMessage(options: {
    pageId: string;
    tabId: number;
    msgid: number;
  }): Promise<GetConsoleMessageResultV2> {
    return this.session(options.tabId).run((session) =>
      session.getConsoleMessage(options.pageId, options.msgid),
    );
  }

  async listNetworkRequests(options: {
    tabId: number;
    params: ListNetworkRequestsParamsV2;
  }): Promise<ListNetworkRequestsResultV2> {
    return this.session(options.tabId).run((session) =>
      session.listNetworkRequests(options.params),
    );
  }

  async getNetworkRequest(options: {
    pageId: string;
    tabId: number;
    reqid: number;
  }): Promise<GetNetworkRequestResultV2> {
    return this.session(options.tabId).run((session) =>
      session.getNetworkRequest(options.pageId, options.reqid),
    );
  }

  invalidateTab(tabId: number): void {
    this.sessions.get(tabId)?.invalidateForNavigation();
  }

  async closeTab(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    await session?.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  private session(tabId: number): PageAutomationSession {
    let session = this.sessions.get(tabId);
    if (session === undefined) {
      session = new PageAutomationSession(tabId);
      this.sessions.set(tabId, session);
    }
    return session;
  }
}

class PageAutomationSession {
  private readonly snapshotState = new TextSnapshotState();
  private browser: Browser | undefined;
  private page: Page | undefined;
  private debugSession: PageDebugSession | undefined;
  private currentDialog: Dialog | undefined;
  private dialogBlockedAction: Promise<void> | undefined;
  private currentSnapshot: TextSnapshot | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  private readonly onDialog = (dialog: Dialog): void => {
    this.currentDialog = dialog;
  };

  constructor(private readonly tabId: number) {}

  run<T>(operation: (session: PageAutomationSession) => Promise<T>): Promise<T> {
    const result = this.operationTail.then(
      () => operation(this),
      () => operation(this),
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async open(
    pageId: string,
    url: string,
    timeoutMs: number,
  ): Promise<OpenPageResultV2> {
    const page = await this.requirePage();
    try {
      await page.goto(url, { timeout: timeoutMs });
      if (this.dialogInfo() === null) {
        await waitForStableDom(page);
      }
      const tab = await requireHttpTab(this.tabId);
      return {
        schemaVersion: 2,
        pageId,
        url: tab.url,
        title: tab.title ?? "",
        loadState: "complete",
      };
    } catch (error) {
      const current = await chrome.tabs.get(this.tabId).catch(() => undefined);
      throw new ChromeBridgeError({
        code: "NAVIGATION_TIMEOUT",
        message: `Chrome page navigation failed: ${asError(error).message}`,
        retryable: true,
        outcome: "performed",
        details: {
          pageId,
          ...(current?.url === undefined ? {} : { url: current.url }),
        },
        cause: error,
      });
    }
  }

  async snapshot(pageId: string, verbose: boolean): Promise<PageSnapshotV2> {
    const page = await this.requirePage();
    let snapshot: TextSnapshot;
    try {
      snapshot = await this.snapshotState.capture(page, verbose);
    } catch (error) {
      throw new ChromeBridgeError({
        code: "SNAPSHOT_FAILED",
        message: `Chrome accessibility snapshot failed: ${asError(error).message}`,
        retryable: true,
        outcome: "not_started",
        cause: error,
      });
    }
    this.currentSnapshot = snapshot;
    const formatted = new SnapshotFormatter(snapshot).toBoundedString(
      MAX_SNAPSHOT_CODE_POINTS,
    );
    const tab = await requireHttpTab(this.tabId);
    return {
      schemaVersion: 2,
      pageId,
      url: tab.url,
      title: tab.title ?? "",
      verbose,
      snapshot: formatted.text,
      truncated: formatted.truncated,
    };
  }

  async click(pageId: string, uid: string): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    const handle = await this.resolveElement(uid);
    try {
      const point = await elementCenter(handle);
      if (point === null) {
        throw new ChromeBridgeError({
          code: "ELEMENT_STALE",
          message: `Element uid ${uid} has no visible bounding box.`,
          retryable: false,
          outcome: "not_started",
        });
      }
      return await this.performAction(pageId, "click", async () => {
        await page.mouse.click(point.x, point.y);
      });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async fill(pageId: string, uid: string, value: string): Promise<PageActionResultV2> {
    const handle = await this.resolveElement(uid);
    const node = this.requireSnapshotNode(uid);
    try {
      return await this.performAction(pageId, "fill", () =>
        fillElement(handle, node, value),
      );
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async pressKey(pageId: string, input: string): Promise<PageActionResultV2> {
    let keys: [KeyInput, ...KeyInput[]];
    try {
      keys = parseKey(input);
    } catch (error) {
      throw new ChromeBridgeError({
        code: "INVALID_KEY",
        message: asError(error).message,
        retryable: false,
        outcome: "not_started",
        cause: error,
      });
    }
    const page = await this.requirePage();
    return this.performAction(pageId, "press_key", () => pressKeyboard(page, keys));
  }

  async typeText(
    pageId: string,
    text: string,
    submitKey: string | null,
  ): Promise<PageActionResultV2> {
    let submitKeys: [KeyInput, ...KeyInput[]] | undefined;
    if (submitKey !== null) {
      try {
        submitKeys = parseKey(submitKey);
      } catch (error) {
        throw new ChromeBridgeError({
          code: "INVALID_KEY",
          message: asError(error).message,
          retryable: false,
          outcome: "not_started",
          cause: error,
        });
      }
    }
    const page = await this.requirePage();
    return this.performAction(pageId, "type_text", async () => {
      await page.keyboard.type(text);
      if (submitKeys !== undefined) {
        await pressKeyboard(page, submitKeys);
      }
    });
  }

  async waitFor(
    pageId: string,
    texts: string[],
    timeoutMs: number,
  ): Promise<PageWaitResultV2> {
    const page = await this.requirePage();
    let matchedText: string;
    try {
      matchedText = await waitForTextOnPage(page, texts, timeoutMs);
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        throw error;
      }
      throw new ChromeBridgeError({
        code: "WAIT_TIMEOUT",
        message: `None of the requested texts appeared within ${timeoutMs} ms.`,
        retryable: true,
        outcome: "not_started",
        cause: error,
      });
    }
    const tab = await requireHttpTab(this.tabId);
    return { schemaVersion: 2, pageId, matchedText, url: tab.url };
  }

  async scroll(
    pageId: string,
    direction: ScrollDirectionV2,
    amount: number,
  ): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    const delta = scrollDelta(direction, amount);
    return this.performAction(pageId, "scroll", () => page.mouse.wheel(delta));
  }

  async hover(pageId: string, uid: string): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    const handle = await this.resolveElement(uid);
    try {
      const point = await elementCenter(handle);
      if (point === null) {
        throw new ChromeBridgeError({
          code: "ELEMENT_STALE",
          message: `Element uid ${uid} has no visible bounding box.`,
          retryable: false,
          outcome: "not_started",
        });
      }
      return await this.performAction(pageId, "hover", () =>
        page.mouse.move(point.x, point.y),
      );
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async navigate(
    pageId: string,
    type: NavigationTypeV2,
    url: string | null,
    ignoreCache: boolean,
    handleBeforeUnload: DialogActionV2,
  ): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    let autoHandledDialog: Promise<void> | undefined;
    const onDialog = (dialog: Dialog): void => {
      if (dialog.type() !== "beforeunload") {
        return;
      }
      autoHandledDialog = (
        handleBeforeUnload === "dismiss" ? dialog.dismiss() : dialog.accept()
      ).then(() => {
        if (this.currentDialog === dialog) {
          this.currentDialog = undefined;
        }
      });
    };
    page.on("dialog", onDialog);
    try {
      const result = await this.performAction(pageId, "navigate_page", async () => {
        const options = { timeout: NAVIGATION_OPERATION_TIMEOUT_MS };
        switch (type) {
          case "url":
            if (url === null) {
              throw new Error("Navigation URL is missing.");
            }
            await page.goto(url, options);
            break;
          case "back":
            await page.goBack(options);
            break;
          case "forward":
            await page.goForward(options);
            break;
          case "reload":
            await page.reload({ ...options, ignoreCache });
            break;
        }
      });
      try {
        await autoHandledDialog;
      } catch (error) {
        throw new ChromeBridgeError({
          code: "INTERACTION_FAILED",
          message: `Chrome could not handle the beforeunload dialog: ${asError(error).message}`,
          retryable: false,
          outcome: "unknown",
          cause: error,
        });
      }
      return { ...result, dialog: this.dialogInfo() };
    } finally {
      page.off("dialog", onDialog);
    }
  }

  async handleDialog(
    pageId: string,
    action: DialogActionV2,
    promptText: string | null,
  ): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    const dialog = this.currentDialog;
    if (dialog === undefined || dialog.handled) {
      this.currentDialog = undefined;
      throw new ChromeBridgeError({
        code: "DIALOG_NOT_FOUND",
        message: "No open Chrome dialog is available for this page.",
        retryable: false,
        outcome: "not_started",
      });
    }
    const blockedAction = this.dialogBlockedAction;
    try {
      const result = await this.performAction(pageId, "handle_dialog", async () => {
        await (action === "dismiss"
          ? dialog.dismiss()
          : dialog.accept(promptText ?? undefined));
        await blockedAction;
        // A mouseReleased CDP command can outlive the dialog while Puppeteer's
        // transaction still records the button as pressed. Normalize it before
        // the next serialized action.
        await page.mouse.reset();
      });
      return { ...result, dialog: null };
    } finally {
      this.currentDialog = undefined;
      this.dialogBlockedAction = undefined;
    }
  }

  async listConsoleMessages(
    params: ListConsoleMessagesParamsV2,
  ): Promise<ListConsoleMessagesResultV2> {
    await this.requirePage();
    return this.requireDebugSession().listConsoleMessages(params);
  }

  async getConsoleMessage(
    pageId: string,
    msgid: number,
  ): Promise<GetConsoleMessageResultV2> {
    await this.requirePage();
    return this.requireDebugSession().getConsoleMessage(pageId, msgid);
  }

  async listNetworkRequests(
    params: ListNetworkRequestsParamsV2,
  ): Promise<ListNetworkRequestsResultV2> {
    await this.requirePage();
    return this.requireDebugSession().listNetworkRequests(params);
  }

  async getNetworkRequest(
    pageId: string,
    reqid: number,
  ): Promise<GetNetworkRequestResultV2> {
    await this.requirePage();
    return this.requireDebugSession().getNetworkRequest(pageId, reqid);
  }

  invalidateForNavigation(): void {
    this.currentSnapshot = undefined;
    this.snapshotState.invalidateForNavigation();
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const page = this.page;
    page?.off("dialog", this.onDialog);
    this.debugSession?.dispose();
    this.browser = undefined;
    this.page = undefined;
    this.debugSession = undefined;
    this.currentDialog = undefined;
    this.dialogBlockedAction = undefined;
    this.currentSnapshot = undefined;
    if (browser !== undefined) {
      await browser.disconnect().catch(() => undefined);
    }
  }

  private async requirePage(): Promise<Page> {
    if (this.page !== undefined && this.browser?.connected === true) {
      return this.page;
    }
    this.page?.off("dialog", this.onDialog);
    this.debugSession?.dispose();
    this.page = undefined;
    this.debugSession = undefined;
    this.currentDialog = undefined;
    this.dialogBlockedAction = undefined;
    let transport: Awaited<ReturnType<typeof Puppeteer.ExtensionTransport.connectTab>>;
    try {
      transport = await Puppeteer.ExtensionTransport.connectTab(this.tabId);
    } catch (error) {
      throw new ChromeBridgeError({
        code: "PAGE_ACCESS_DENIED",
        message: `Chrome debugger attach failed: ${asError(error).message}`,
        retryable: false,
        outcome: "not_started",
        cause: error,
      });
    }
    try {
      const browser = await Puppeteer.connect({
        transport,
        defaultViewport: null,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
      const [page] = await browser.pages();
      if (page === undefined) {
        throw new Error("ExtensionTransport did not expose the attached page.");
      }
      page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
      page.on("dialog", this.onDialog);
      this.browser = browser;
      this.page = page;
      this.debugSession = new PageDebugSession(page);
      return page;
    } catch (error) {
      transport.close();
      throw new ChromeBridgeError({
        code: "PAGE_ACCESS_DENIED",
        message: `Puppeteer could not connect to the Chrome tab: ${asError(error).message}`,
        retryable: false,
        outcome: "not_started",
        cause: error,
      });
    }
  }

  private requireDebugSession(): PageDebugSession {
    if (this.debugSession === undefined) {
      throw new Error("Chrome page debug collectors are not attached.");
    }
    return this.debugSession;
  }

  private dialogInfo(): PageActionResultV2["dialog"] {
    const dialog = this.currentDialog;
    if (dialog === undefined || dialog.handled) {
      if (dialog?.handled === true) {
        this.currentDialog = undefined;
      }
      return null;
    }
    return {
      type: dialog.type(),
      message: truncateCodePoints(dialog.message(), MAX_DIALOG_TEXT_CODE_POINTS),
      defaultValue: truncateCodePoints(
        dialog.defaultValue(),
        MAX_DIALOG_TEXT_CODE_POINTS,
      ),
    };
  }

  private requireSnapshotNode(uid: string): TextSnapshotNode {
    if (this.currentSnapshot === undefined) {
      throw new ChromeBridgeError({
        code: "SNAPSHOT_REQUIRED",
        message: "Take a fresh accessibility snapshot before using an element uid.",
        retryable: false,
        outcome: "not_started",
      });
    }
    const node = this.currentSnapshot.idToNode.get(uid);
    if (node === undefined) {
      throw new ChromeBridgeError({
        code: "ELEMENT_NOT_FOUND",
        message: `Element uid ${uid} is not present in the latest snapshot.`,
        retryable: false,
        outcome: "not_started",
      });
    }
    return node;
  }

  private async resolveElement(uid: string): Promise<ElementHandle<Element>> {
    const node = this.requireSnapshotNode(uid);
    try {
      const handle = await node.elementHandle();
      if (handle === null) {
        throw new Error("AX node has no DOM element.");
      }
      return handle;
    } catch (error) {
      throw new ChromeBridgeError({
        code: "ELEMENT_STALE",
        message: `Element uid ${uid} no longer exists on the page.`,
        retryable: false,
        outcome: "not_started",
        cause: error,
      });
    }
  }

  private async performAction(
    pageId: string,
    action: PageActionResultV2["action"],
    operation: () => Promise<unknown>,
  ): Promise<PageActionResultV2> {
    const page = await this.requirePage();
    const initialTab = await requireHttpTab(this.tabId);
    const watcher = new TabNavigationWatcher(this.tabId, initialTab.url);
    const returnWhenDialogOpens =
      action !== "navigate_page" && action !== "handle_dialog";
    const dialogOpened = deferred<Dialog>();
    const onDialog = (dialog: Dialog): void => {
      dialogOpened.resolve(dialog);
    };
    if (returnWhenDialogOpens) {
      page.on("dialog", onDialog);
    }
    let started = false;
    try {
      started = true;
      const operationPromise = Promise.resolve().then(operation);
      const firstCompleted = returnWhenDialogOpens
        ? await Promise.race([
            operationPromise.then(() => "operation" as const),
            dialogOpened.promise.then(() => "dialog" as const),
          ])
        : await operationPromise.then(() => "operation" as const);
      if (firstCompleted === "dialog") {
        // Like upstream WaitForHelper, a dialog is a terminal observation for
        // the action. ExtensionTransport can keep the input command pending
        // while the renderer is paused, so let handle_dialog release it.
        const blockedAction = operationPromise.then(
          () => undefined,
          () => undefined,
        );
        this.dialogBlockedAction = blockedAction;
        void blockedAction.then(() => {
          if (this.dialogBlockedAction === blockedAction) {
            this.dialogBlockedAction = undefined;
          }
        });
        const tab = await requireHttpTab(this.tabId);
        return {
          schemaVersion: 2,
          pageId,
          action,
          performed: true,
          url: tab.url,
          navigatedToUrl: null,
          dialog: this.dialogInfo(),
        };
      }
      const navigatedToUrl = await watcher.settle(page, this.dialogInfo() !== null);
      const tab = await requireHttpTab(this.tabId);
      return {
        schemaVersion: 2,
        pageId,
        action,
        performed: true,
        url: tab.url,
        navigatedToUrl,
        dialog: this.dialogInfo(),
      };
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        throw error;
      }
      throw new ChromeBridgeError({
        code: "INTERACTION_FAILED",
        message: `Chrome ${action} failed: ${asError(error).message}`,
        retryable: false,
        outcome: started ? "unknown" : "not_started",
        cause: error,
      });
    } finally {
      if (returnWhenDialogOpens) {
        page.off("dialog", onDialog);
      }
      watcher.close();
    }
  }
}

class TabNavigationWatcher {
  private readonly started = deferred<void>();
  private readonly completed = deferred<chrome.tabs.Tab>();
  private navigationStarted = false;

  constructor(
    private readonly tabId: number,
    private readonly initialUrl: string,
  ) {
    chrome.tabs.onUpdated.addListener(this.onUpdated);
  }

  async settle(page: Page, dialogOpen: boolean): Promise<string | null> {
    await Promise.race([this.started.promise, sleep(EXPECT_NAVIGATION_MS)]);
    if (this.navigationStarted) {
      await Promise.race([
        this.completed.promise,
        sleep(NAVIGATION_SETTLE_TIMEOUT_MS),
      ]).catch(() => undefined);
    }
    if (!dialogOpen) {
      await waitForStableDom(page);
    }
    const tab = await requireHttpTab(this.tabId);
    return tab.url === this.initialUrl ? null : tab.url;
  }

  close(): void {
    chrome.tabs.onUpdated.removeListener(this.onUpdated);
  }

  private readonly onUpdated = (
    updatedTabId: number,
    changeInfo: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    if (updatedTabId !== this.tabId) {
      return;
    }
    if (
      changeInfo.status === "loading" ||
      (tab.url !== undefined && tab.url !== this.initialUrl)
    ) {
      this.navigationStarted = true;
      this.started.resolve();
    }
    if (changeInfo.status === "complete") {
      this.completed.resolve(tab);
    }
  };
}

async function fillElement(
  handle: ElementHandle<Element>,
  node: TextSnapshotNode,
  value: string,
): Promise<void> {
  if (node.role === "combobox") {
    const options = node.children.filter((child) => child.role === "option");
    const option = node.children.find(
      (child) => child.role === "option" && child.name === value,
    );
    if (option !== undefined) {
      const optionHandle = await option.elementHandle();
      if (optionHandle === null) {
        throw new ChromeBridgeError({
          code: "ELEMENT_STALE",
          message: `Select option ${JSON.stringify(value)} no longer exists.`,
          retryable: false,
          outcome: "not_started",
        });
      }
      try {
        const valueHandle = await optionHandle.getProperty("value");
        try {
          const optionValue = await valueHandle.jsonValue();
          if (typeof optionValue === "string") {
            await handle.asLocator().fill(optionValue);
            return;
          }
        } finally {
          await valueHandle.dispose().catch(() => undefined);
        }
        throw new ChromeBridgeError({
          code: "INTERACTION_FAILED",
          message: `Select option ${JSON.stringify(value)} has no string value.`,
          retryable: false,
          outcome: "not_started",
        });
      } finally {
        await optionHandle.dispose().catch(() => undefined);
      }
    }
    if (options.length > 0) {
      throw new ChromeBridgeError({
        code: "INVALID_ARGUMENT",
        message: `Could not find a select option named ${JSON.stringify(value)}.`,
        retryable: false,
        outcome: "not_started",
      });
    }
  }
  const toggle = await handle.evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      return element.type === "checkbox" || element.type === "radio";
    }
    const role = element.getAttribute("role");
    return role === "checkbox" || role === "radio" || role === "switch";
  });
  if (toggle) {
    if (value !== "true" && value !== "false") {
      throw new ChromeBridgeError({
        code: "INVALID_ARGUMENT",
        message: "Checkboxes, radios, and switches require true or false.",
        retryable: false,
        outcome: "not_started",
      });
    }
    await handle.asLocator().fill(value === "true");
    return;
  }
  await handle
    .asLocator()
    .setTimeout(DEFAULT_TIMEOUT_MS + value.length * 10)
    .fill(value);
}

async function pressKeyboard(
  page: Page,
  [key, ...modifiers]: [KeyInput, ...KeyInput[]],
): Promise<void> {
  const held: KeyInput[] = [];
  try {
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier);
      held.push(modifier);
    }
    await page.keyboard.press(key);
  } finally {
    for (const modifier of [...held].reverse()) {
      await page.keyboard.up(modifier);
    }
  }
}

async function elementCenter(
  handle: ElementHandle<Element>,
): Promise<{ x: number; y: number } | null> {
  return handle.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

function scrollDelta(
  direction: ScrollDirectionV2,
  amount: number,
): { deltaX: number; deltaY: number } {
  switch (direction) {
    case "up":
      return { deltaX: 0, deltaY: -amount };
    case "down":
      return { deltaX: 0, deltaY: amount };
    case "left":
      return { deltaX: -amount, deltaY: 0 };
    case "right":
      return { deltaX: amount, deltaY: 0 };
  }
}

async function waitForStableDom(page: Page): Promise<void> {
  await Promise.race([
    page.evaluate((stableForMs) => {
      return new Promise<void>((resolve) => {
        let timer = setTimeout(finish, stableForMs);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(finish, stableForMs);
        });
        function finish() {
          observer.disconnect();
          resolve();
        }
        if (document.body === null) {
          finish();
          return;
        }
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      });
    }, STABLE_DOM_FOR_MS),
    sleep(STABLE_DOM_TIMEOUT_MS),
  ]).catch(() => undefined);
}

async function waitForTextOnPage(
  page: Page,
  texts: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (page.isClosed()) {
      throw new ChromeBridgeError({
        code: "TAB_CLOSED",
        message: "The Chrome tab was closed while waiting for page text.",
        retryable: false,
        outcome: "not_started",
      });
    }
    const surfaces = await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(() => {
            const visibleText = document.body?.innerText ?? "";
            const accessibleNames = Array.from(
              document.querySelectorAll("[aria-label], [alt], [title]"),
            )
              .filter((element) => {
                const style = getComputedStyle(element);
                return (
                  element.getClientRects().length > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              })
              .flatMap((element) =>
                ["aria-label", "alt", "title"]
                  .map((attribute) => element.getAttribute(attribute))
                  .filter((value): value is string => value !== null),
              );
            return `${visibleText}\n${accessibleNames.join("\n")}`;
          })
          .catch(() => ""),
      ),
    );
    const matched = texts.find((text) =>
      surfaces.some((surface) => surface.includes(text)),
    );
    if (matched !== undefined) {
      return matched;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Timed out waiting for page text.");
    }
    await sleep(Math.min(100, remaining));
  }
}

async function requireHttpTab(
  tabId: number,
): Promise<chrome.tabs.Tab & { url: string }> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new ChromeBridgeError({
      code: "TAB_CLOSED",
      message: "The Chrome tab for this page has been closed.",
      retryable: false,
      outcome: "not_started",
      cause: error,
    });
  }
  if (
    tab.url === undefined ||
    (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))
  ) {
    throw new ChromeBridgeError({
      code: "PAGE_ACCESS_DENIED",
      message: "Only HTTP and HTTPS Chrome pages can be automated.",
      retryable: false,
      outcome: "not_started",
    });
  }
  return tab as chrome.tabs.Tab & { url: string };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

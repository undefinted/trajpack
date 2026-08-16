import { afterEach, describe, expect, it } from "vitest";
import { captureVisibleConversation } from "./capture.js";
import type { AuthorizedSelectorRecipe } from "./recipe.js";

class FakeElement {
  readonly tagName = "DIV";
  readonly hidden: boolean;
  readonly innerText: string;
  readonly shadowRoot: FakeElement | null;
  parentElement: FakeElement | null = null;
  readonly computedStyle: {
    display: string;
    visibility: string;
    opacity: string;
    contentVisibility: string;
  };
  readonly #attributes: Record<string, string>;
  readonly #queries: Record<string, FakeElement[]>;

  constructor(options: {
    text?: string;
    hidden?: boolean;
    attributes?: Record<string, string>;
    queries?: Record<string, FakeElement[]>;
    shadowRoot?: FakeElement;
    style?: Partial<FakeElement["computedStyle"]>;
  } = {}) {
    this.innerText = options.text ?? "";
    this.hidden = options.hidden ?? false;
    this.shadowRoot = options.shadowRoot ?? null;
    this.#attributes = options.attributes ?? {};
    this.#queries = options.queries ?? {};
    this.computedStyle = {
      display: "block",
      visibility: "visible",
      opacity: "1",
      contentVisibility: "visible",
      ...options.style,
    };
    for (const children of Object.values(this.#queries)) {
      for (const child of children) child.parentElement = this;
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.#queries[selector] ?? [];
  }

  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name === "hidden" ? this.hidden || name in this.#attributes : name in this.#attributes;
  }

  getClientRects(): unknown[] {
    return this.hidden ? [] : [{}];
  }
}

const recipe: AuthorizedSelectorRecipe = {
  schema_version: "selector-recipe/0.1",
  recipe_id: "fixture",
  name: "Fixture",
  origin: "https://agent.example.test",
  version: "1",
  authorization: {
    basis: "site_owner",
    evidence_ref: "fixture",
    attested_by: "fixture",
    attested_at: "2026-08-16T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  },
  selectors: { root: "#conversation", item: ".message", content: ".content", role_attribute: "data-role" },
  role_map: { human: "user", bot: "assistant" },
  expectations: {
    root_count: 1,
    min_items: 1,
    max_items: 10,
    content_nodes_per_item: 1,
    max_text_characters_per_item: 1000,
  },
  fingerprint_probes: [{ selector: "[data-app]", min_matches: 1, max_matches: 1 }],
  recipe_sha256: "0".repeat(64),
};

function installPage(rootMatches: FakeElement[], probeMatches: FakeElement[]): void {
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: recipe.origin },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      title: "Owned agent",
      querySelectorAll: (selector: string) => selector === "#conversation" ? rootMatches :
        selector === "[data-app]" ? probeMatches : [],
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element: FakeElement) => element.computedStyle,
  });
}

afterEach(() => {
  for (const key of ["HTMLElement", "location", "document", "getComputedStyle"]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

describe("isolated visible-DOM capture", () => {
  it("is self-contained when Chrome serializes it into an isolated world", () => {
    expect(captureVisibleConversation.toString()).not.toContain("AUTHORIZED_DOM_INTERFACE_VERSION");
  });

  it("captures innerText only and excludes hidden matching items", () => {
    const visibleContent = new FakeElement({ text: "Visible answer" });
    const hiddenContent = new FakeElement({ text: "hidden secret" });
    const visibleItem = new FakeElement({
      attributes: { "data-role": "bot" },
      queries: { ".content": [visibleContent] },
    });
    const hiddenItem = new FakeElement({
      hidden: true,
      attributes: { "data-role": "human" },
      queries: { ".content": [hiddenContent] },
    });
    const root = new FakeElement({ queries: { ".message": [visibleItem, hiddenItem] } });
    installPage([root], [root]);

    const result = captureVisibleConversation(recipe);
    expect(result.messages).toEqual([{ sequence: 0, role: "assistant", text: "Visible answer" }]);
    expect(JSON.stringify(result)).not.toContain("hidden secret");
  });

  it("rejects content beneath an opacity-zero ancestor even when the child has layout boxes", () => {
    const content = new FakeElement({ text: "Visually suppressed answer" });
    const item = new FakeElement({
      attributes: { "data-role": "bot" },
      queries: { ".content": [content] },
    });
    const root = new FakeElement({ queries: { ".message": [item] } });
    const opacityZeroAncestor = new FakeElement({
      style: { opacity: "0.0" },
      queries: { ".mounted-conversation": [root] },
    });
    installPage([root], [opacityZeroAncestor]);

    expect(content.getClientRects()).toHaveLength(1);
    expect(() => captureVisibleConversation(recipe)).toThrow("conversation root is not visible");
  });

  it.each([
    { label: "display:none", style: { display: "none" } },
    { label: "visibility:hidden", style: { visibility: "hidden" } },
    { label: "visibility:collapse", style: { visibility: "collapse" } },
    { label: "content-visibility:hidden", style: { contentVisibility: "hidden" } },
    { label: "hidden", hidden: true },
    { label: "aria-hidden", attributes: { "aria-hidden": " TRUE " } },
  ])("rejects content beneath a $label ancestor", (ancestorOptions) => {
    const content = new FakeElement({ text: "Suppressed answer" });
    const item = new FakeElement({
      attributes: { "data-role": "bot" },
      queries: { ".content": [content] },
    });
    const root = new FakeElement({ queries: { ".message": [item] } });
    const ancestor = new FakeElement({ ...ancestorOptions, queries: { ".mounted-conversation": [root] } });
    installPage([root], [ancestor]);

    expect(() => captureVisibleConversation(recipe)).toThrow("conversation root is not visible");
  });

  it("treats markup-looking content as inert rendered text", () => {
    const malicious = `<img src=x onerror="globalThis.__trajpackExecuted=true"><script>globalThis.__trajpackExecuted=true</script>`;
    const content = new FakeElement({ text: malicious });
    const item = new FakeElement({
      attributes: { "data-role": "bot" },
      queries: { ".content": [content] },
    });
    const root = new FakeElement({ queries: { ".message": [item] } });
    installPage([root], [root]);
    Object.defineProperty(globalThis, "__trajpackExecuted", { configurable: true, writable: true, value: false });

    const result = captureVisibleConversation(recipe);
    expect(result.messages[0]?.text).toBe(malicious);
    expect((globalThis as typeof globalThis & { __trajpackExecuted?: boolean }).__trajpackExecuted).toBe(false);
    Reflect.deleteProperty(globalThis, "__trajpackExecuted");
  });

  it("does not pierce Shadow DOM and fails closed when the recipe root is shadow-only", () => {
    const shadowConversation = new FakeElement();
    const shadowRoot = new FakeElement({ queries: { "#conversation": [shadowConversation] } });
    const host = new FakeElement({ shadowRoot });
    installPage([], [host]);

    expect(host.shadowRoot?.querySelectorAll("#conversation")).toEqual([shadowConversation]);
    expect(() => captureVisibleConversation(recipe)).toThrow("expected exactly one root");
  });

  it("returns a point-in-time snapshot and sees later DOM only on another explicit capture", () => {
    const firstContent = new FakeElement({ text: "First answer" });
    const secondContent = new FakeElement({ text: "Loaded later" });
    const firstItem = new FakeElement({
      attributes: { "data-role": "bot" },
      queries: { ".content": [firstContent] },
    });
    const secondItem = new FakeElement({
      attributes: { "data-role": "human" },
      queries: { ".content": [secondContent] },
    });
    const liveItems = [firstItem];
    const root = new FakeElement({ queries: { ".message": liveItems } });
    installPage([root], [root]);

    const firstSnapshot = captureVisibleConversation(recipe);
    liveItems.push(secondItem);

    expect(firstSnapshot.messages.map(({ text }) => text)).toEqual(["First answer"]);
    expect(captureVisibleConversation(recipe).messages.map(({ text }) => text)).toEqual(["First answer", "Loaded later"]);
  });

  it("fails closed on selector drift", () => {
    installPage([], [new FakeElement()]);
    expect(() => captureVisibleConversation(recipe)).toThrow("expected exactly one root");

    installPage([new FakeElement()], []);
    expect(() => captureVisibleConversation(recipe)).toThrow("fingerprint mismatch");
  });
});

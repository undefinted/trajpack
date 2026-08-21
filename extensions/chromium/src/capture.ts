import type { RawEnvelope } from "@trajpack/schema";
import { canonicalJson, sha256Hex } from "./hash.js";
import type { AuthorizedSelectorRecipe, CapturedRole } from "./recipe.js";

export const AUTHORIZED_DOM_INTERFACE_VERSION = "authorized-dom/0.1" as const;

export interface VisibleMessage {
  sequence: number;
  role: CapturedRole;
  text: string;
}

export interface AuthorizedDomCapture {
  schema_version: typeof AUTHORIZED_DOM_INTERFACE_VERSION;
  captured_at: string;
  page: { origin: string; title: string };
  recipe: AuthorizedSelectorRecipe;
  observed_fingerprint: Array<{ selector: string; matches: number }>;
  messages: VisibleMessage[];
}

/**
 * This entire function is serialized into the page's isolated world by
 * chrome.scripting.executeScript. Keep all helpers inside the function.
 */
export function captureVisibleConversation(recipe: AuthorizedSelectorRecipe): AuthorizedDomCapture {
  const query = (scope: Document | Element, selector: string, label: string): Element[] => {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch {
      throw new Error(`${label} is not a valid selector on this page`);
    }
  };

  const isVisible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
        return false;
      }
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return false;
      }
    }
    return element.getClientRects().length > 0;
  };

  if (location.origin !== recipe.origin) throw new Error("Page origin changed before capture");

  const observedFingerprint = recipe.fingerprint_probes.map((probe, index) => {
    const matches = query(document, probe.selector, `fingerprint probe ${index}`).length;
    if (matches < probe.min_matches || matches > probe.max_matches) {
      throw new Error(`Selector fingerprint mismatch at probe ${index}: observed ${matches}`);
    }
    return { selector: probe.selector, matches };
  });

  const roots = query(document, recipe.selectors.root, "root selector");
  if (roots.length !== recipe.expectations.root_count) {
    throw new Error(`Selector drift: expected exactly one root, observed ${roots.length}`);
  }
  const root = roots[0];
  if (!root || !isVisible(root)) throw new Error("The selected conversation root is not visible");

  const visibleItems = query(root, recipe.selectors.item, "item selector").filter(isVisible);
  if (visibleItems.length < recipe.expectations.min_items || visibleItems.length > recipe.expectations.max_items) {
    throw new Error(`Selector drift: observed ${visibleItems.length} visible items outside the allowed range`);
  }

  let totalCharacters = 0;
  const messages = visibleItems.map((item, sequence): VisibleMessage => {
    const sourceRole = item.getAttribute(recipe.selectors.role_attribute);
    // executeScript serializes the recipe into the isolated world, which drops
    // the null prototype the validator used. Resolve only own properties and
    // re-validate the type so prototype members ("constructor", "toString",
    // "__proto__", ...) cannot bypass the fail-closed role mapping.
    const role = sourceRole !== null
      && Object.prototype.hasOwnProperty.call(recipe.role_map, sourceRole)
      ? recipe.role_map[sourceRole]
      : undefined;
    if (typeof role !== "string") throw new Error(`Item ${sequence} has an unmapped or missing role attribute`);

    const contents = query(item, recipe.selectors.content, `content selector for item ${sequence}`);
    if (contents.length !== recipe.expectations.content_nodes_per_item) {
      throw new Error(`Selector drift: item ${sequence} does not have exactly one content node`);
    }
    const content = contents[0];
    if (!content || !isVisible(content)) throw new Error(`Content for item ${sequence} is not visible`);

    const text = content.innerText.replace(/\r\n?/gu, "\n").trim();
    if (text.length === 0) throw new Error(`Visible content for item ${sequence} is empty`);
    if (text.length > recipe.expectations.max_text_characters_per_item) {
      throw new Error(`Content for item ${sequence} exceeds the recipe text limit`);
    }
    totalCharacters += text.length;
    if (totalCharacters > 10_000_000) throw new Error("Capture exceeds the 10,000,000-character safety limit");
    return { sequence, role, text };
  });

  return {
    schema_version: "authorized-dom/0.1",
    captured_at: new Date().toISOString(),
    page: { origin: location.origin, title: document.title.slice(0, 500) },
    recipe,
    observed_fingerprint: observedFingerprint,
    messages,
  };
}

export async function createBrowserRawEnvelope(capture: AuthorizedDomCapture): Promise<RawEnvelope> {
  const payload = {
    record_kind: "authorized_dom_capture",
    provenance: {
      capture_method: "authorized_dom",
      source_origin: capture.page.origin,
      selector_recipe_id: capture.recipe.recipe_id,
      selector_recipe_version: capture.recipe.version,
      selector_recipe_sha256: capture.recipe.recipe_sha256,
      authorization: capture.recipe.authorization,
      visible_text_only: true,
      fidelity: "C",
    },
    capture,
  };
  return {
    envelope_version: "raw/0.1",
    adapter: "browser",
    adapter_version: "0.1.0",
    interface_version: AUTHORIZED_DOM_INTERFACE_VERSION,
    captured_at: capture.captured_at,
    sequence: 0,
    source_event_id: null,
    session_id: null,
    turn_id: null,
    payload_sha256: await sha256Hex(canonicalJson(payload)),
    payload,
  };
}

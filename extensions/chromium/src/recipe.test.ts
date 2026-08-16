import { describe, expect, it } from "vitest";
import {
  assertAuthorizedCaptureContext,
  computeRecipeSha256,
  type AuthorizedSelectorRecipe,
  validateAuthorizedSelectorRecipe,
} from "./recipe.js";

async function fixture(origin = "https://agent.example.test"): Promise<AuthorizedSelectorRecipe> {
  const input: Record<string, unknown> = {
    schema_version: "selector-recipe/0.1",
    recipe_id: "owned-agent",
    name: "Owned agent UI",
    origin,
    version: "1.0.0",
    authorization: {
      basis: "site_owner",
      evidence_ref: "internal-asset-registry:agent-ui",
      attested_by: "fixture-reviewer",
      attested_at: "2026-08-16T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    selectors: {
      root: "#conversation",
      item: ".message",
      content: ".content",
      role_attribute: "data-role",
    },
    role_map: { human: "user", bot: "assistant" },
    expectations: {
      root_count: 1,
      min_items: 1,
      max_items: 100,
      content_nodes_per_item: 1,
      max_text_characters_per_item: 10000,
    },
    fingerprint_probes: [{ selector: "[data-app='owned-agent']", min_matches: 1, max_matches: 1 }],
    recipe_sha256: "",
  };
  input.recipe_sha256 = await computeRecipeSha256(input);
  return validateAuthorizedSelectorRecipe(input, new Date("2026-08-16T01:00:00.000Z"));
}

describe("authorized selector recipes", () => {
  it("binds authorization, selectors, origin, and version to the recipe hash", async () => {
    const recipe = await fixture();
    expect(recipe.recipe_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const modified = structuredClone(recipe) as unknown as Record<string, unknown>;
    (modified.selectors as Record<string, unknown>).content = ".different";
    await expect(validateAuthorizedSelectorRecipe(modified, new Date("2026-08-16T01:00:00.000Z"))).rejects.toThrow(
      "does not match",
    );
  });

  it("rejects commercial AI origins even with a user-supplied recipe", async () => {
    await expect(fixture("https://chatgpt.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://platform.openai.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://claude.ai")).rejects.toThrow("official/manual export");
    await expect(fixture("https://console.anthropic.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://chat.deepseek.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://gemini.google.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://bard.google.com")).rejects.toThrow("official/manual export");
    await expect(fixture("https://aistudio.google.com")).rejects.toThrow("official/manual export");
  });

  it("fails closed when the active tab origin differs or is incognito", async () => {
    const recipe = await fixture();
    expect(() => assertAuthorizedCaptureContext({ url: "https://other.example.test/chat", incognito: false }, recipe)).toThrow(
      "does not match",
    );
    expect(() => assertAuthorizedCaptureContext({ url: `${recipe.origin}/chat`, incognito: true }, recipe)).toThrow("Incognito");
  });

  it("rejects unsupported recipe fields rather than silently ignoring them", async () => {
    const recipe = await fixture();
    const input = structuredClone(recipe) as unknown as Record<string, unknown>;
    input["future_capture_bypass"] = true;
    input.recipe_sha256 = await computeRecipeSha256(input);
    await expect(validateAuthorizedSelectorRecipe(input, new Date("2026-08-16T01:00:00.000Z"))).rejects.toThrow(
      "unsupported field",
    );
  });
});

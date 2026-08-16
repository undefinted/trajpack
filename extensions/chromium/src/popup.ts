import type { RawEnvelope } from "@trajpack/schema";
import { captureVisibleConversation, createBrowserRawEnvelope } from "./capture.js";
import { validateCollectorBaseUrl, validatePairingNonce } from "./pairing.js";
import {
  assertAuthorizedCaptureContext,
  computeRecipeSha256,
  type AuthorizedSelectorRecipe,
  validateAuthorizedSelectorRecipe,
} from "./recipe.js";

const get = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

const recipeInput = get<HTMLTextAreaElement>("recipe");
const collectorInput = get<HTMLInputElement>("collector");
const nonceInput = get<HTMLInputElement>("nonce");
const attestationInput = get<HTMLInputElement>("attestation");
const hashButton = get<HTMLButtonElement>("hash-recipe");
const captureButton = get<HTMLButtonElement>("capture");
const uploadButton = get<HTMLButtonElement>("upload");
const preview = get<HTMLPreElement>("preview");
const status = get<HTMLParagraphElement>("status");

let pendingEnvelope: RawEnvelope | null = null;
let pendingRecipe: AuthorizedSelectorRecipe | null = null;

function showStatus(message: string, kind: "info" | "error" | "success" = "info"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function parseRecipeInput(): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recipeInput.value);
  } catch {
    throw new Error("Recipe is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Recipe must be a JSON object");
  return parsed as Record<string, unknown>;
}

function resetPendingCapture(): void {
  pendingEnvelope = null;
  pendingRecipe = null;
  uploadButton.disabled = true;
  preview.textContent = "No capture preview yet.";
}

async function hashRecipe(): Promise<void> {
  const recipe = parseRecipeInput();
  recipe.recipe_sha256 = await computeRecipeSha256(recipe);
  recipeInput.value = JSON.stringify(recipe, null, 2);
  await chrome.storage.local.set({ authorizedSelectorRecipe: recipeInput.value });
  resetPendingCapture();
  showStatus("Recipe hash updated. Review the recipe before capture.", "success");
}

async function captureForPreview(): Promise<void> {
  resetPendingCapture();
  if (!attestationInput.checked) throw new Error("Confirm that you are authorized to collect from this site");
  const recipe = await validateAuthorizedSelectorRecipe(parseRecipeInput());
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || tab.id === undefined) throw new Error("No active capturable tab was found");
  assertAuthorizedCaptureContext(tab, recipe);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: captureVisibleConversation,
    args: [recipe],
  });
  const capture = results[0]?.result;
  if (!capture) throw new Error("The page returned no capture result");
  pendingEnvelope = await createBrowserRawEnvelope(capture);
  pendingRecipe = recipe;
  await chrome.storage.local.set({ authorizedSelectorRecipe: recipeInput.value });

  preview.textContent = capture.messages
    .map((message) => `[${message.role}]\n${message.text}`)
    .join("\n\n");
  uploadButton.disabled = false;
  showStatus(`Previewed ${capture.messages.length} visible messages. Nothing has been uploaded.`, "success");
}

async function uploadOnce(): Promise<void> {
  if (!pendingEnvelope || !pendingRecipe) throw new Error("Capture and review a preview first");
  const collector = validateCollectorBaseUrl(collectorInput.value.trim());
  const nonce = validatePairingNonce(nonceInput.value.trim());
  nonceInput.value = "";
  uploadButton.disabled = true;

  const endpoint = new URL("/v1/browser/captures", collector);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trajpack-Pairing-Nonce": nonce,
        "X-Trajpack-Recipe-Sha256": pendingRecipe.recipe_sha256,
      },
      body: JSON.stringify({ envelope: pendingEnvelope }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Collector rejected the upload with HTTP ${response.status}`);
    pendingEnvelope = null;
    pendingRecipe = null;
    preview.textContent = "Capture uploaded once. The nonce was cleared.";
    showStatus("Encrypted collector accepted the capture.", "success");
  } finally {
    clearTimeout(timeout);
  }
}

hashButton.addEventListener("click", () => void hashRecipe().catch((error: unknown) => {
  showStatus(error instanceof Error ? error.message : "Could not hash the recipe", "error");
}));
captureButton.addEventListener("click", () => void captureForPreview().catch((error: unknown) => {
  resetPendingCapture();
  showStatus(error instanceof Error ? error.message : "Capture failed", "error");
}));
uploadButton.addEventListener("click", () => void uploadOnce().catch((error: unknown) => {
  uploadButton.disabled = pendingEnvelope === null;
  showStatus(error instanceof Error ? error.message : "Upload failed; obtain a fresh nonce before retrying", "error");
}));
recipeInput.addEventListener("input", resetPendingCapture);
attestationInput.addEventListener("change", resetPendingCapture);

void chrome.storage.local.get(["authorizedSelectorRecipe"]).then((stored) => {
  const saved = stored["authorizedSelectorRecipe"];
  if (typeof saved === "string") recipeInput.value = saved;
});

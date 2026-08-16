import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
const injectedSource = readFileSync(new URL("./capture.ts", import.meta.url), "utf8");
const popupSource = readFileSync(new URL("./popup.ts", import.meta.url), "utf8");

describe("least-privilege MV3 manifest", () => {
  it("contains only the approved permissions and loopback host access", () => {
    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["permissions"]).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest["host_permissions"]).toEqual(["http://127.0.0.1/*"]);
    expect(manifest["incognito"]).toBe("not_allowed");
  });

  it("has no persistent injection, background, network interception, or external connection surface", () => {
    for (const forbidden of [
      "background",
      "content_scripts",
      "externally_connectable",
      "optional_host_permissions",
      "web_accessible_resources",
    ]) {
      expect(manifest).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/webRequest|cookies|debugger|<all_urls>/u);
  });

  it("reads rendered text without page storage, markup, credential, or network APIs", () => {
    expect(injectedSource).toContain("innerText");
    expect(injectedSource).not.toMatch(/innerHTML|outerHTML|document\.cookie|localStorage|sessionStorage|XMLHttpRequest|\bfetch\s*\(/u);
  });

  it("has no observer or timer that could continue collecting after the click snapshot", () => {
    expect(injectedSource).not.toMatch(/MutationObserver|ResizeObserver|IntersectionObserver|setInterval|setTimeout|requestAnimationFrame/u);
    expect(manifest).not.toHaveProperty("background");
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("renders all captured provider text with textContent rather than executable markup", () => {
    expect(popupSource).toContain("preview.textContent = capture.messages");
    expect(popupSource).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/u);
  });
});

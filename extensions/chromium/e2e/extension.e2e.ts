import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { chromium, expect, test, type CDPSession } from "@playwright/test";
import { captureVisibleConversation } from "../dist/capture.js";
import type { AuthorizedSelectorRecipe } from "../dist/recipe.js";

const extensionPath = resolve(import.meta.dirname, "../build");
const windowsBrowsers = [
  { name: "Chrome", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Edge", executable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
] as const;

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

let fixtureServer: Server;
let fixtureOrigin = "";

test.beforeAll(async () => {
  fixtureServer = createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/shadow") {
      response.end(`<!doctype html>
        <title>Shadow-only authorized agent</title>
        <main data-app="owned-agent"><div id="shadow-host"></div></main>
        <script>
          document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML =
            '<section id="conversation"><article class="message" data-role="bot"><p class="content">shadow answer</p></article></section>';
        </script>`);
      return;
    }
    response.end(`<!doctype html>
      <title>Dynamic authorized agent</title>
      <main data-app="owned-agent">
        <section id="conversation">
          <article class="message" data-role="bot"><p class="content">First answer</p></article>
        </section>
      </main>`);
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    fixtureServer.once("error", rejectListening);
    fixtureServer.listen(0, "127.0.0.1", () => resolveListening());
  });
  const address = fixtureServer.address() as AddressInfo | null;
  if (!address) throw new Error("Could not determine the fixture server address");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!fixtureServer) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    fixtureServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
});

function recipeFor(origin: string): AuthorizedSelectorRecipe {
  return {
    schema_version: "selector-recipe/0.1",
    recipe_id: "browser-e2e",
    name: "Browser E2E authorized site",
    origin,
    version: "1.0.0",
    authorization: {
      basis: "site_owner",
      evidence_ref: "e2e-owned-fixture",
      attested_by: "e2e-reviewer",
      attested_at: "2026-01-01T00:00:00.000Z",
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
      max_items: 10,
      content_nodes_per_item: 1,
      max_text_characters_per_item: 10_000,
    },
    fingerprint_probes: [{ selector: "[data-app='owned-agent']", min_matches: 1, max_matches: 1 }],
    recipe_sha256: "",
  };
}

async function targetSession(cdp: CDPSession, targetId: string): Promise<Send> {
  const attached = await cdp.send("Target.attachToTarget" as never, { targetId, flatten: false } as never) as { sessionId: string };
  let nextId = 0;
  return async (method, params = {}) => {
    const id = ++nextId;
    const response = new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
      const listener = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== attached.sessionId) return;
        const parsed = JSON.parse(event.message) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        if (parsed.id !== id) return;
        cdp.off("Target.receivedMessageFromTarget" as never, listener as never);
        if (parsed.error) rejectResponse(new Error(parsed.error.message));
        else resolveResponse(parsed.result ?? {});
      };
      cdp.on("Target.receivedMessageFromTarget" as never, listener as never);
    });
    await cdp.send("Target.sendMessageToTarget" as never, {
      sessionId: attached.sessionId,
      message: JSON.stringify({ id, method, params }),
    } as never);
    return response;
  };
}

async function evaluateValue<Result>(send: Send, expression: string): Promise<Result> {
  const evaluated = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }) as {
    result?: { value?: Result; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return evaluated.result?.value as Result;
}

for (const browser of windowsBrowsers) {
  test(`${browser.name} enforces click-only, fail-closed authorized DOM capture`, async () => {
    test.skip(process.platform !== "win32" || !existsSync(browser.executable), `${browser.name} is not installed`);
    const browserProcess = await chromium.launch({
      executablePath: browser.executable,
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
    });
    try {
      const cdp = await browserProcess.newBrowserCDPSession();
      const loaded = await cdp.send("Extensions.loadUnpacked" as never, { path: extensionPath, enableInIncognito: false } as never) as { id: string };
      expect(loaded.id).toMatch(/^[a-p]{32}$/u);
      const created = await cdp.send("Target.createTarget" as never, { url: `chrome-extension://${loaded.id}/popup.html` } as never) as { targetId: string };
      const send = await targetSession(cdp, created.targetId);
      await expect.poll(async () => {
        return evaluateValue(send, "document.readyState === 'complete' && document.querySelector('h1')?.textContent");
      }).toBe("Authorized DOM capture");
      expect(await evaluateValue(send, "document.querySelector('#upload')?.disabled")).toBe(true);
      const targets = await cdp.send("Target.getTargets" as never) as { targetInfos: Array<{ type: string; url: string }> };
      expect(targets.targetInfos.filter((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${loaded.id}/`))).toHaveLength(0);

      const unsignedRecipe = recipeFor(fixtureOrigin);
      await evaluateValue(send, `(() => {
        const input = document.querySelector('#recipe');
        input.value = ${JSON.stringify(JSON.stringify(unsignedRecipe))};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#hash-recipe').click();
        return true;
      })()`);
      await expect.poll(async () => {
        const value = await evaluateValue<string>(send, "document.querySelector('#recipe').value");
        return JSON.parse(value).recipe_sha256;
      }).toMatch(/^[a-f0-9]{64}$/u);

      const maliciousText = `<img src=x onerror="window.__trajpackExecuted=true"><script>window.__trajpackExecuted=true</script>`;
      await evaluateValue(send, `(() => {
        window.__trajpackExecuted = false;
        Object.defineProperty(chrome.tabs, 'query', {
          configurable: true,
          value: async () => [{ id: 7, url: ${JSON.stringify(`${fixtureOrigin}/dynamic`)}, incognito: false }],
        });
        Object.defineProperty(chrome.scripting, 'executeScript', {
          configurable: true,
          value: async (details) => [{ result: {
            schema_version: 'authorized-dom/0.1',
            captured_at: new Date().toISOString(),
            page: { origin: ${JSON.stringify(fixtureOrigin)}, title: 'Malicious-looking fixture' },
            recipe: details.args[0],
            observed_fingerprint: [],
            messages: [{ sequence: 0, role: 'assistant', text: ${JSON.stringify(maliciousText)} }],
          } }],
        });
        document.querySelector('#attestation').checked = true;
        document.querySelector('#capture').click();
        return true;
      })()`);
      await expect.poll(() => evaluateValue(send, "document.querySelector('#status').textContent")).toContain("Previewed 1 visible message");
      const preview = await evaluateValue<{ text: string; html: string; executed: boolean; uploadDisabled: boolean }>(send, `({
        text: document.querySelector('#preview').textContent,
        html: document.querySelector('#preview').innerHTML,
        executed: window.__trajpackExecuted,
        uploadDisabled: document.querySelector('#upload').disabled,
      })`);
      expect(preview.text).toBe(`[assistant]\n${maliciousText}`);
      expect(preview.html).not.toContain("<img");
      expect(preview.html).not.toContain("<script");
      expect(preview.executed).toBe(false);
      expect(preview.uploadDisabled).toBe(false);

      for (const unauthorizedTab of [
        { url: "https://unowned.example.test/chat", incognito: false, message: "does not match" },
        { url: `${fixtureOrigin}/dynamic`, incognito: true, message: "Incognito" },
      ]) {
        await evaluateValue(send, `(() => {
          window.__trajpackInjectionAttempts = 0;
          Object.defineProperty(chrome.tabs, 'query', {
            configurable: true,
            value: async () => [{ id: 8, url: ${JSON.stringify(unauthorizedTab.url)}, incognito: ${unauthorizedTab.incognito} }],
          });
          Object.defineProperty(chrome.scripting, 'executeScript', {
            configurable: true,
            value: async () => { window.__trajpackInjectionAttempts += 1; return []; },
          });
          document.querySelector('#capture').click();
          return true;
        })()`);
        await expect.poll(() => evaluateValue(send, "document.querySelector('#status').textContent")).toContain(unauthorizedTab.message);
        expect(await evaluateValue(send, "window.__trajpackInjectionAttempts")).toBe(0);
        expect(await evaluateValue(send, "document.querySelector('#upload').disabled")).toBe(true);
      }

      const page = await browserProcess.newPage();
      const recipe = recipeFor(fixtureOrigin);
      await page.goto(`${fixtureOrigin}/dynamic`);
      const firstSnapshot = await page.evaluate(captureVisibleConversation, recipe);
      await page.evaluate(() => {
        const item = document.createElement("article");
        item.className = "message";
        item.setAttribute("data-role", "human");
        const content = document.createElement("p");
        content.className = "content";
        content.textContent = "Loaded later";
        item.append(content);
        document.querySelector("#conversation")?.append(item);
      });
      await page.waitForTimeout(100);
      expect(firstSnapshot.messages.map(({ text }) => text)).toEqual(["First answer"]);
      const secondSnapshot = await page.evaluate(captureVisibleConversation, recipe);
      expect(secondSnapshot.messages.map(({ text }) => text)).toEqual(["First answer", "Loaded later"]);

      await page.evaluate(() => {
        const duplicateRoot = document.querySelector("#conversation")?.cloneNode(true);
        if (duplicateRoot) document.body.append(duplicateRoot);
      });
      await expect(page.evaluate(captureVisibleConversation, recipe)).rejects.toThrow("expected exactly one root");

      await page.goto(`${fixtureOrigin}/shadow`);
      expect(await page.locator("#shadow-host").evaluate((host) => host.shadowRoot?.querySelectorAll("#conversation").length)).toBe(1);
      await expect(page.evaluate(captureVisibleConversation, recipe)).rejects.toThrow("expected exactly one root");
      await page.close();
    } finally {
      await browserProcess.close();
    }
  });
}

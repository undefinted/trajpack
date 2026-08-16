import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { importFile, importOfficialZipArchive, sha256Bytes } from "./index.js";

const capturedAt = "2026-08-16T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function chatGptConversation(id: string, text = "hello"): Record<string, unknown> {
  return {
    id,
    title: `Fixture ${id}`,
    mapping: {
      [`node-${id}`]: {
        message: {
          author: { role: "user" },
          content: { content_type: "text", parts: [text] },
        },
      },
    },
  };
}

function claudeConversation(id: string): Record<string, unknown> {
  return {
    uuid: id,
    name: `Fixture ${id}`,
    chat_messages: [{ uuid: `message-${id}`, sender: "human", text: "hello" }],
  };
}

function json(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

function mutateHeaders(zip: Uint8Array, callback: (view: DataView, offset: number, signature: number) => void): Uint8Array {
  const copy = zip.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let offset = 0; offset + 4 <= copy.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50 || signature === 0x02014b50) callback(view, offset, signature);
  }
  return copy;
}

describe("bounded official ZIP import", () => {
  it("prefers validated ChatGPT JSON, preserves archive and entry hashes, and never extracts to disk", async () => {
    const archive = zipSync({
      "conversations.json": json([chatGptConversation("chatgpt-one")]),
      "chat.html": strToU8("<!doctype html><title>ChatGPT Data Export</title><script>globalThis.__zipOwned=true</script>"),
      "user.json": json({ email: "private@example.invalid" }),
    });
    const directory = await mkdtemp(join(tmpdir(), "trajpack-zip-"));
    temporaryDirectories.push(directory);
    const archivePath = join(directory, "official-export.zip");
    await writeFile(archivePath, archive);

    const result = await importFile(archivePath, { capturedAt });
    expect(result.detectedFormat).toBe("chatgpt_official_json");
    expect(result.envelopes).toHaveLength(1);
    expect((globalThis as Record<string, unknown>)["__zipOwned"]).toBeUndefined();
    expect(result.sourceMetadata).toMatchObject({
      archive: {
        container_format: "zip",
        archive_filename: "official-export.zip",
        archive_sha256: sha256Bytes(archive),
        archive_entry_count: 3,
        selected_entries: [{ name: "conversations.json", detected_format: "chatgpt_official_json" }],
      },
    });
    const payload = result.envelopes[0]?.payload as { provenance?: Record<string, unknown> };
    expect(payload.provenance?.archive).toMatchObject({
      archive_sha256: sha256Bytes(archive),
      selected_entry_name: "conversations.json",
      selected_entry_index: 0,
      selected_entry_count: 1,
    });
  });

  it("imports contiguous ChatGPT conversation shards in numeric order", () => {
    const first = json([chatGptConversation("first")]);
    const second = json([chatGptConversation("second")]);
    const archive = zipSync({
      "export/conversations-001.json": second,
      "export/conversations-000.json": first,
    });
    const result = importOfficialZipArchive(archive, { capturedAt, filename: "chatgpt.zip" });
    expect(result.detection.format).toBe("chatgpt_official_json");
    expect(result.envelopes.map((envelope) => [envelope.sequence, envelope.session_id])).toEqual([
      [0, "first"],
      [1, "second"],
    ]);
    expect(result.archive.selected_entries.map((entry) => entry.name)).toEqual([
      "export/conversations-000.json",
      "export/conversations-001.json",
    ]);
  });

  it("recognizes a Claude official conversations.json archive", () => {
    const archive = zipSync({
      "claude-export/conversations.json": json([claudeConversation("claude-one")]),
      "claude-export/users.json": json([{ uuid: "user-one" }]),
    });
    const result = importOfficialZipArchive(archive, { capturedAt });
    expect(result.detection.format).toBe("claude_official_json");
    expect(result.envelopes[0]?.session_id).toBe("claude-one");
  });

  it("imports a bounded Google Takeout Gemini Apps activity archive without treating it as full chat history", () => {
    const activity = [{
      header: "Gemini Apps",
      title: "Prompted Explain trajectory provenance",
      time: "2026-08-15T12:00:00.000Z",
      products: ["Gemini Apps"],
    }];
    const archive = zipSync({
      "Takeout/My Activity/Gemini Apps/MyActivity.json": json(activity),
      "Takeout/My Activity/Gemini Apps/MyActivity.html": strToU8(
        "<!doctype html><title>My Activity</title><h1>Gemini Apps</h1><p>Prompted ignored viewer</p>",
      ),
    });
    const result = importOfficialZipArchive(archive, { capturedAt, filename: "takeout.zip" });
    expect(result.detection.format).toBe("gemini_takeout_activity_json");
    expect(result.provenance.source_product).toBe("gemini");
    expect(result.archive.selected_entries).toMatchObject([{
      name: "Takeout/My Activity/Gemini Apps/MyActivity.json",
      detected_format: "gemini_takeout_activity_json",
    }]);
    expect(result.warnings.join(" ")).toContain("activity log");
    expect(result.warnings.join(" ")).toContain("HTML viewer was ignored");
  });

  it("accepts a uniquely selected conversations.jsonl only after every record validates", () => {
    const jsonl = `${JSON.stringify(chatGptConversation("line-one"))}\n${JSON.stringify(chatGptConversation("line-two"))}\n`;
    const result = importOfficialZipArchive(zipSync({ "conversations.jsonl": strToU8(jsonl) }), { capturedAt });
    expect(result.detection).toMatchObject({
      format: "chatgpt_official_json",
      mediaType: "application/x-ndjson",
    });
    expect(result.envelopes.map((envelope) => envelope.session_id)).toEqual(["line-one", "line-two"]);
  });

  it("accepts only a marked inert ChatGPT chat.html fallback and never executes it", () => {
    const archive = zipSync({
      "chat.html": strToU8([
        "<!doctype html><html><head><title>ChatGPT Data Export</title></head>",
        "<body><script>globalThis.__zipOwned=true</script><p>Visible archive text</p></body></html>",
      ].join("")),
    });
    const result = importOfficialZipArchive(archive, { capturedAt });
    expect(result.detection.format).toBe("chatgpt_official_html");
    expect(JSON.stringify(result.envelopes[0]?.payload)).toContain("Visible archive text");
    expect((globalThis as Record<string, unknown>)["__zipOwned"]).toBeUndefined();

    expect(() => importOfficialZipArchive(zipSync({
      "chat.html": strToU8("<!doctype html><title>Unrelated viewer</title><p>not official</p>"),
    }), { capturedAt })).toThrow("does not match a supported official");
  });

  it("fails closed on ambiguous, incomplete, and shape-drifted conversation selections", () => {
    expect(() => importOfficialZipArchive(zipSync({
      "one/conversations.json": json([chatGptConversation("one")]),
      "two/conversations.json": json([chatGptConversation("two")]),
    }), { capturedAt })).toThrow("Ambiguous ZIP");

    expect(() => importOfficialZipArchive(zipSync({
      "conversations-000.json": json([chatGptConversation("zero")]),
      "conversations-002.json": json([chatGptConversation("two")]),
    }), { capturedAt })).toThrow("contiguous");

    expect(() => importOfficialZipArchive(zipSync({
      "conversations.json": json([{ unexpected: true }]),
      "chat.html": strToU8("<!doctype html><title>ChatGPT Data Export</title>"),
    }), { capturedAt })).toThrow("does not match a supported official");
  });

  it("rejects traversal, encrypted, symlink-like, duplicate-confusable, and corrupt entries", () => {
    expect(() => importOfficialZipArchive(zipSync({
      "../conversations.json": json([chatGptConversation("escape")]),
    }), { capturedAt })).toThrow("Unsafe ZIP entry path");

    const ordinary = zipSync({ "conversations.json": json([chatGptConversation("encrypted")]) });
    const encryptedFlag = mutateHeaders(ordinary, (view, offset, signature) => {
      const flagsOffset = offset + (signature === 0x04034b50 ? 6 : 8);
      view.setUint16(flagsOffset, view.getUint16(flagsOffset, true) | 1, true);
    });
    expect(() => importOfficialZipArchive(encryptedFlag, { capturedAt })).toThrow("encrypted entries");

    const symlink = zipSync({
      "conversations.json": json([chatGptConversation("safe")]),
      "conversation-link": [strToU8("conversations.json"), { os: 3, attrs: 0o120777 << 16 }],
    });
    expect(() => importOfficialZipArchive(symlink, { capturedAt })).toThrow("symlink or special-file");

    const confusable = zipSync({
      "conversations.json": json([chatGptConversation("safe")]),
      "metadata.txt": strToU8("one"),
      "METADATA.TXT": strToU8("two"),
    });
    expect(() => importOfficialZipArchive(confusable, { capturedAt })).toThrow("duplicate or confusable");

    const corruptChecksum = mutateHeaders(ordinary, (view, offset, signature) => {
      const crcOffset = offset + (signature === 0x04034b50 ? 14 : 16);
      view.setUint32(crcOffset, 0, true);
    });
    expect(() => importOfficialZipArchive(corruptChecksum, { capturedAt })).toThrow("checksum mismatch");

    const dishonestSize = mutateHeaders(zipSync({
      "conversations.json": json([chatGptConversation("bomb", "x".repeat(1_000_000))]),
    }), (view, offset, signature) => {
      const sizeOffset = offset + (signature === 0x04034b50 ? 22 : 24);
      view.setUint32(sizeOffset, 1, true);
    });
    expect(() => importOfficialZipArchive(dishonestSize, { capturedAt })).toThrow("actual decoded data exceeds");
  });

  it("enforces explicit entry-count, per-entry, and total-uncompressed limits before decoding", () => {
    const archive = zipSync({
      "conversations.json": json([chatGptConversation("limits", "repeated repeated repeated")]),
      "metadata.json": json({ value: "metadata" }),
    });
    expect(() => importOfficialZipArchive(archive, { capturedAt, maxBytes: archive.byteLength - 1 })).toThrow("compressed input limit");
    expect(() => importOfficialZipArchive(archive, { capturedAt, maxArchiveEntries: 1 })).toThrow("entry limit");
    expect(() => importOfficialZipArchive(archive, { capturedAt, maxArchiveEntryBytes: 16 })).toThrow("per-entry limit");
    expect(() => importOfficialZipArchive(archive, { capturedAt, maxArchiveUncompressedBytes: 32 })).toThrow("uncompressed limit");
  });

  it("rejects a .zip filename whose bytes are not a ZIP archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-zip-invalid-"));
    temporaryDirectories.push(directory);
    const archivePath = join(directory, "not-an-export.zip");
    await writeFile(archivePath, "not a zip", "utf8");
    await expect(importFile(archivePath, { capturedAt })).rejects.toThrow("Invalid ZIP");
  });
});

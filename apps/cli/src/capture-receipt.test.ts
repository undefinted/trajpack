import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CAPTURE_RECEIPT_SCHEMA,
  makeCaptureReceipt,
  prepareCaptureReceiptPath,
  writeCaptureReceipt,
} from "./capture-receipt.js";

const stats = Object.freeze({
  rawEvents: 3,
  rawBytes: 1_024,
  normalizedEvents: 4,
  rawLineageSha256: "a".repeat(64),
});

describe("content-free capture receipts", () => {
  it("writes one exclusive terminal JSON receipt without provider content", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-receipt-"));
    const target = join(root, "capture.json");
    try {
      const destination = await prepareCaptureReceiptPath(target);
      const receipt = makeCaptureReceipt({
        traceId: "1".repeat(32),
        host: "deepseek_harness",
        interfaceVersion: "deepseek-harness@0.1.0-rc.6/session-event/0",
        status: "stored",
        reason: "CAPTURE_FINALIZED",
        hostExitCode: 0,
        stats,
        terminalAt: "2026-08-22T00:00:00.000Z",
      });
      const writtenPath = await writeCaptureReceipt(destination, receipt);
      const [writtenStat, targetStat] = await Promise.all([
        stat(writtenPath),
        stat(target),
      ]);
      expect({ dev: writtenStat.dev, ino: writtenStat.ino }).toEqual({
        dev: targetStat.dev,
        ino: targetStat.ino,
      });
      const encoded = await readFile(target, "utf8");
      const parsed = JSON.parse(encoded) as Record<string, unknown>;
      expect(parsed).toEqual({
        schema: CAPTURE_RECEIPT_SCHEMA,
        trace_id: "1".repeat(32),
        terminal_at: "2026-08-22T00:00:00.000Z",
        host: "deepseek_harness",
        interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
        status: "stored",
        reason: "CAPTURE_FINALIZED",
        host_exit_code: 0,
        raw_event_count: 3,
        normalized_event_count: 4,
        raw_bytes: 1_024,
        raw_lineage_sha256: "a".repeat(64),
      });
      expect(Object.keys(parsed).sort()).toEqual([
        "host", "host_exit_code", "interface_version", "normalized_event_count",
        "raw_bytes", "raw_event_count", "raw_lineage_sha256", "reason", "schema",
        "status", "terminal_at", "trace_id",
      ]);
      expect(encoded).not.toContain("prompt");
      expect(encoded).not.toContain("tool_result");
      if (process.platform !== "win32") {
        expect((await stat(target)).mode & 0o077).toBe(0);
      }
      await expect(writeCaptureReceipt(destination, receipt)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before capture when the requested receipt already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-receipt-existing-"));
    const target = join(root, "capture.json");
    try {
      await writeFile(target, "owned", { flag: "wx" });
      await expect(prepareCaptureReceiptPath(target)).rejects.toThrow("already exists");
      expect(await readFile(target, "utf8")).toBe("owned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a receipt beneath a symlink or junction ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-receipt-link-"));
    const actual = join(root, "actual");
    const linked = join(root, "linked");
    try {
      await mkdir(actual);
      await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(prepareCaptureReceiptPath(join(linked, "capture.json")))
        .rejects.toThrow("symbolic-link or junction ancestor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a real parent directory replaced after preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-receipt-parent-swap-"));
    const parent = join(root, "output");
    const moved = join(root, "moved");
    const target = join(parent, "capture.json");
    try {
      await mkdir(parent);
      const destination = await prepareCaptureReceiptPath(target);
      await rename(parent, moved);
      await mkdir(parent);
      const receipt = makeCaptureReceipt({
        traceId: "3".repeat(32),
        host: "deepseek_harness",
        interfaceVersion: interfaceVersionForTest,
        status: "aborted",
        reason: "CAPTURE_FAILED",
        hostExitCode: null,
        stats: { ...stats, normalizedEvents: null },
      });
      await expect(writeCaptureReceipt(destination, receipt))
        .rejects.toThrow("parent changed after validation");
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicitly named JSON file", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-receipt-extension-"));
    try {
      await expect(prepareCaptureReceiptPath(join(root, "capture.txt")))
        .rejects.toThrow("new .json file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cannot turn arbitrary metadata or an error message into plaintext receipt content", () => {
    const receipt = makeCaptureReceipt({
      traceId: "2".repeat(32),
      host: "deepseek_harness",
      interfaceVersion: "c2VjcmV0LXByb21wdC1lbmNvZGVkLWFzLWFuLWlkZW50aWZpZXI",
      status: "aborted",
      reason: "CAPTURE_FAILED",
      hostExitCode: null,
      stats: { ...stats, normalizedEvents: null },
      terminalAt: "2026-08-22T00:00:00.000Z",
    });
    expect(receipt.interface_version).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain("c2VjcmV0LXByb21wdC1lbmNvZGVkLWFzLWFuLWlkZW50aWZpZXI");
    expect(() => makeCaptureReceipt({
      traceId: "2".repeat(32),
      host: "deepseek_harness",
      interfaceVersion: interfaceVersionForTest,
      status: "aborted",
      reason: "failure included a raw tool result",
      hostExitCode: null,
      stats,
    })).toThrow("stable code");
    for (const terminalAt of ["08/22/2026", "2026-02-30T00:00:00Z"]) {
      expect(() => makeCaptureReceipt({
        traceId: "2".repeat(32),
        host: "deepseek_harness",
        interfaceVersion: interfaceVersionForTest,
        status: "aborted",
        reason: "CAPTURE_FAILED",
        hostExitCode: null,
        stats,
        terminalAt,
      })).toThrow("ISO-8601 UTC");
    }
  });
});

const interfaceVersionForTest = "deepseek-harness@0.1.0-rc.6/session-event/0";

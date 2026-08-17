import type { ImportDetection, ImportSourceHint } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basename(filename: string | undefined): string {
  if (!filename) return "";
  return filename.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function isConversationJsonFilename(file: string): boolean {
  return file === "conversations.json" || /^conversations-\d{3,6}\.json$/u.test(file);
}

function hasChatGptHtmlShape(text: string): boolean {
  if (!/^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(text)) return false;
  return /<title\b[^>]*>\s*chatgpt\s+data\s+export\s*<\/title>/iu.test(text) ||
    /<h1\b[^>]*>\s*chatgpt\s+data\s+export\s*<\/h1>/iu.test(text);
}

function hasGeminiTakeoutHtmlShape(text: string): boolean {
  if (!/^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(text)) return false;
  return /<title\b[^>]*>[^<]*(?:my\s+activity|google\s+activity)[^<]*<\/title>/iu.test(text)
    && /gemini\s+apps/iu.test(text);
}

function hasChatGptShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((conversation) => {
    if (!isRecord(conversation) || !isRecord(conversation.mapping)) return false;
    return Object.values(conversation.mapping).some((node) => {
      if (!isRecord(node) || !isRecord(node.message)) return false;
      const message = node.message;
      return isRecord(message.author) && typeof message.author.role === "string" && isRecord(message.content);
    });
  });
}

function hasClaudeShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((conversation) => {
    if (!isRecord(conversation) || typeof conversation.uuid !== "string" || !Array.isArray(conversation.chat_messages)) {
      return false;
    }
    return conversation.chat_messages.every(
      (message) => isRecord(message) && typeof message.sender === "string" &&
        (typeof message.text === "string" || Array.isArray(message.content)),
    );
  });
}

function hasGeminiActivityShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((activity) => {
    if (!isRecord(activity) || typeof activity.time !== "string" || !Number.isFinite(Date.parse(activity.time))) {
      return false;
    }
    if (!Array.isArray(activity.products)
      || !activity.products.some((product) => typeof product === "string" && /^gemini\s+apps$/iu.test(product.trim()))) {
      return false;
    }
    return typeof activity.title === "string"
      || typeof activity.description === "string"
      || typeof activity.header === "string";
  });
}

function hasTokenUsageShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens"]
    .some((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0);
}

function hasToolCallsShape(value: unknown, streaming: boolean): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((candidate) => {
    if (!isRecord(candidate)) return false;
    if (candidate.index !== undefined && (!Number.isInteger(candidate.index) || (candidate.index as number) < 0)) return false;
    if (!streaming && (typeof candidate.id !== "string" || candidate.id.length === 0)) return false;
    if (candidate.type !== undefined && candidate.type !== "function") return false;
    if (!isRecord(candidate.function)) return streaming && typeof candidate.id === "string";
    const fn = candidate.function;
    if (!streaming && (typeof fn.name !== "string" || fn.name.length === 0)) return false;
    if (fn.name !== undefined && typeof fn.name !== "string") return false;
    return fn.arguments === undefined || typeof fn.arguments === "string";
  });
}

function hasAssistantPayloadShape(value: Record<string, unknown>, streaming: boolean, finishReason: unknown): boolean {
  if (value.role !== undefined && value.role !== "assistant") return false;
  if (!streaming && value.role !== "assistant") return false;

  let hasPayload = false;
  for (const key of ["reasoning_content", "content"] as const) {
    if (value[key] !== undefined) {
      if (value[key] !== null && typeof value[key] !== "string") return false;
      hasPayload = true;
    }
  }
  if (value.tool_calls !== undefined) {
    if (!hasToolCallsShape(value.tool_calls, streaming)) return false;
    hasPayload = true;
  }

  return hasPayload || (streaming && (value.role === "assistant" || finishReason !== null));
}

function hasDeepSeekApiRecordShape(value: unknown, requireDeepSeekModel: boolean): boolean {
  if (!isRecord(value)) return false;
  const streaming = value.object === "chat.completion.chunk";
  if (!streaming && value.object !== "chat.completion") return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.created !== "number" || !Number.isFinite(value.created) || value.created < 0) return false;
  if (typeof value.model !== "string" || value.model.length === 0) return false;
  if (requireDeepSeekModel && !/^deepseek(?:[-_/]|$)/iu.test(value.model)) return false;
  if (value.usage !== undefined && value.usage !== null && !hasTokenUsageShape(value.usage)) return false;
  if (!Array.isArray(value.choices)) return false;
  if (value.choices.length === 0) return streaming && hasTokenUsageShape(value.usage);

  return value.choices.every((candidate) => {
    if (!isRecord(candidate) || !Number.isInteger(candidate.index) || (candidate.index as number) < 0) return false;
    const finishReason = candidate.finish_reason ?? null;
    if (candidate.finish_reason !== undefined && candidate.finish_reason !== null && typeof candidate.finish_reason !== "string") {
      return false;
    }
    const body = streaming ? candidate.delta : candidate.message;
    return isRecord(body) && hasAssistantPayloadShape(body, streaming, finishReason);
  });
}

function hasDeepSeekApiShape(value: unknown, requireDeepSeekModel: boolean): boolean {
  const records = Array.isArray(value) ? value : [value];
  return records.length > 0 && records.every((record) => hasDeepSeekApiRecordShape(record, requireDeepSeekModel));
}

function hasDeepSeekHarnessHeaderShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.type !== "session" || value.version !== 0) return false;
  return typeof value.id === "string" && value.id.length > 0
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.delegationDepth) && (value.delegationDepth as number) >= 0
    && (value.cwd === undefined || typeof value.cwd === "string")
    && (value.parentSession === undefined || typeof value.parentSession === "string")
    && (value.seedLength === undefined || (Number.isSafeInteger(value.seedLength) && (value.seedLength as number) >= 0));
}

function hasDeepSeekHarnessEventShape(value: unknown, expectedSeq: number): boolean {
  if (!isRecord(value) || value.seq !== expectedSeq || typeof value.type !== "string" || !value.type.includes("/")) return false;
  return typeof value.time === "number" && Number.isFinite(value.time) && value.time >= 0
    && isRecord(value.data)
    && (value.ignorable === undefined || value.ignorable === true)
    && (value.surfaceOp === undefined || value.surfaceOp === "append" || isRecord(value.surfaceOp))
    && (value.sourceEventSeqs === undefined || (Array.isArray(value.sourceEventSeqs)
      && value.sourceEventSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)));
}

function hasDeepSeekHarnessSessionShape(records: unknown[]): boolean {
  if (records.length < 2 || !hasDeepSeekHarnessHeaderShape(records[0])) return false;
  // Packed assistant chunk rows require the upstream lossless codec. v1 accepts
  // only the official uncompressed one-event-per-line representation and fails
  // closed instead of partially decoding text-chunks/reasoning-chunks rows.
  return records.slice(1).every((record, index) => hasDeepSeekHarnessEventShape(record, index));
}

function officialDetection(
  parsed: unknown,
  filename: string | undefined,
  sourceHint: ImportSourceHint | undefined,
): ImportDetection | null {
  const file = basename(filename);
  const expectedFilename = isConversationJsonFilename(file);

  if ((sourceHint === "chatgpt" || (sourceHint === undefined && expectedFilename)) && hasChatGptShape(parsed)) {
    return {
      format: "chatgpt_official_json",
      mediaType: "application/json",
      basis: sourceHint === "chatgpt"
        ? "explicit ChatGPT source hint plus validated conversation mapping shape"
        : "conversations.json filename plus validated ChatGPT mapping shape",
    };
  }

  if ((sourceHint === "claude" || (sourceHint === undefined && expectedFilename)) && hasClaudeShape(parsed)) {
    return {
      format: "claude_official_json",
      mediaType: "application/json",
      basis: sourceHint === "claude"
        ? "explicit Claude source hint plus validated chat_messages shape"
        : "conversations.json filename plus validated Claude chat_messages shape",
    };
  }

  if ((sourceHint === "gemini" || (sourceHint === undefined && file === "myactivity.json"))
    && hasGeminiActivityShape(parsed)) {
    return {
      format: "gemini_takeout_activity_json",
      mediaType: "application/json",
      basis: sourceHint === "gemini"
        ? "explicit Gemini source hint plus validated Google Takeout Gemini Apps activity shape"
        : "MyActivity.json filename plus validated Google Takeout Gemini Apps activity shape",
    };
  }

  const explicitlyDeepSeek = sourceHint === "deepseek-api";
  if ((explicitlyDeepSeek || sourceHint === undefined) && hasDeepSeekApiShape(parsed, true)) {
    return {
      format: "deepseek_api_response",
      mediaType: "application/json",
      basis: explicitlyDeepSeek
        ? "explicit DeepSeek API source hint plus validated Chat Completions response shape"
        : "validated Chat Completions response shape plus DeepSeek model identifier",
    };
  }

  if (sourceHint === "deepseek-api") {
    throw new Error("The input does not match the conservative DeepSeek API response shape");
  }
  if (sourceHint === "chatgpt" || sourceHint === "claude" || sourceHint === "gemini") {
    throw new Error(`The input does not match the conservative ${sourceHint} official export shape`);
  }

  return null;
}

export function detectImportFormat(
  text: string,
  options: { filename?: string; sourceHint?: ImportSourceHint } = {},
): { detection: ImportDetection; records: unknown[] } {
  const trimmed = text.trimStart();
  const file = basename(options.filename);
  if (trimmed.length === 0) throw new Error("Import input is empty");

  if (trimmed.startsWith("PK\u0003\u0004")) {
    throw new Error("ZIP archives are not read directly; extract the official export and import conversations.json");
  }

  const isHtmlFilename = file.endsWith(".html") || file.endsWith(".htm");
  const looksLikeHtml = /^<!doctype\s+html\b|^<html\b|^<head\b|^<body\b/i.test(trimmed);
  if (isHtmlFilename || looksLikeHtml) {
    if (options.sourceHint === "dsh-session") {
      throw new Error("DeepSeek Harness session persistence must be an unpacked JSONL v0 artifact");
    }
    if (options.sourceHint === "deepseek-api") {
      throw new Error("The HTML input is not a validated DeepSeek API response; import it as generic HTML instead");
    }
    if (
      (options.sourceHint === "chatgpt" || (options.sourceHint === undefined && file === "chat.html")) &&
      hasChatGptHtmlShape(text)
    ) {
      return {
        detection: {
          format: "chatgpt_official_html",
          mediaType: "text/html",
          basis: "chat.html filename plus validated inert ChatGPT Data Export document marker",
        },
        records: [text],
      };
    }
    if ((options.sourceHint === "gemini" || (options.sourceHint === undefined && file === "myactivity.html"))
      && hasGeminiTakeoutHtmlShape(text)) {
      return {
        detection: {
          format: "gemini_takeout_activity_html",
          mediaType: "text/html",
          basis: "MyActivity.html marker plus validated inert Gemini Apps activity marker",
        },
        records: [text],
      };
    }
    if (options.sourceHint === "chatgpt" || options.sourceHint === "claude" || options.sourceHint === "gemini") {
      throw new Error(`The HTML input is not a validated ${options.sourceHint} official export shape; import it as generic HTML instead`);
    }
    return {
      detection: {
        format: "generic_html",
        mediaType: "text/html",
        basis: isHtmlFilename ? "HTML file extension" : "HTML document prefix",
      },
      records: [text],
    };
  }

  let parsed: unknown;
  let parsedAsJson = false;
  try {
    parsed = JSON.parse(text);
    parsedAsJson = true;
  } catch {
    // Fall through to line-oriented JSON only when whole-document parsing fails.
  }

  if (parsedAsJson) {
    if (options.sourceHint === "dsh-session") {
      throw new Error("DeepSeek Harness session persistence must contain a header line followed by event JSONL rows");
    }
    const official = officialDetection(parsed, options.filename, options.sourceHint);
    const detection = official ?? {
      format: "generic_json" as const,
      mediaType: "application/json" as const,
      basis: "complete input parsed as JSON without a validated official export signature",
    };
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.length === 0) throw new Error("Import JSON array contains no records");
    return { detection, records };
  }

  const lines = text.split(/\r?\n/u);
  const records: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`Input is neither JSON, JSONL, nor HTML; invalid JSONL at line ${index + 1}`);
    }
  }

  if (records.length === 0) throw new Error("Import input contains no JSONL records");
  if (options.sourceHint === "dsh-session") {
    if (!hasDeepSeekHarnessSessionShape(records)) {
      throw new Error("The input is not an unpacked DeepSeek Harness session JSONL v0 artifact");
    }
    return {
      detection: {
        format: "deepseek_harness_session_jsonl",
        mediaType: "application/x-ndjson",
        basis: "explicit dsh-session hint plus validated session header v0 and contiguous unpacked SessionEvent rows",
      },
      records,
    };
  }
  const expectedConversationJsonl = file === "conversations.jsonl";
  if ((options.sourceHint === "chatgpt" || (options.sourceHint === undefined && expectedConversationJsonl)) && hasChatGptShape(records)) {
    return {
      detection: {
        format: "chatgpt_official_json",
        mediaType: "application/x-ndjson",
        basis: "conversations.jsonl filename plus validated ChatGPT mapping records",
      },
      records,
    };
  }
  if ((options.sourceHint === "claude" || (options.sourceHint === undefined && expectedConversationJsonl)) && hasClaudeShape(records)) {
    return {
      detection: {
        format: "claude_official_json",
        mediaType: "application/x-ndjson",
        basis: "conversations.jsonl filename plus validated Claude chat_messages records",
      },
      records,
    };
  }
  const explicitlyDeepSeek = options.sourceHint === "deepseek-api";
  if ((explicitlyDeepSeek || options.sourceHint === undefined) && hasDeepSeekApiShape(records, true)) {
    return {
      detection: {
        format: "deepseek_api_response",
        mediaType: "application/x-ndjson",
        basis: explicitlyDeepSeek
          ? "explicit DeepSeek API source hint plus validated Chat Completions JSONL stream"
          : "validated Chat Completions JSONL stream plus DeepSeek model identifiers",
      },
      records,
    };
  }
  if (options.sourceHint === "deepseek-api") {
    throw new Error("The input does not match the conservative DeepSeek API response shape");
  }
  if (options.sourceHint === "chatgpt" || options.sourceHint === "claude" || options.sourceHint === "gemini") {
    throw new Error(`The input does not match the conservative ${options.sourceHint} official export shape`);
  }
  return {
    detection: {
      format: "generic_jsonl",
      mediaType: "application/x-ndjson",
      basis: "each non-empty input line parsed independently as JSON",
    },
    records,
  };
}

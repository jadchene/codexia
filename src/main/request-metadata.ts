/** Bounded, observational JSON scanner. Never buffers input/history or changes the wire body. */
export function createRequestMetadataParser() {
  const decoder = new TextDecoder();
  const fields: Record<string, string> = {};
  const selected = new Set(["model", "service_tier"]);
  const maxFieldLength = 4096;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let capture = false;
  let token = "";
  let key = "";
  let stage: "key" | "colon" | "value" | "after" = "key";
  let started = false;
  let ended = false;
  let invalid = false;
  let overflow = false;

  const scan = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      if (invalid) return;
      let char = text[index]!;
      // Skip large input/base64 strings using native searches, retaining no content.
      if (inString && !capture && !escaped) {
        const quote = text.indexOf('"', index);
        const slash = text.indexOf("\\", index);
        if (quote < 0 && slash < 0) return;
        index = quote < 0 ? slash : slash < 0 ? quote : Math.min(quote, slash);
        char = text[index]!;
      }
      if (inString) {
        if (capture && !overflow) {
          if (token.length < maxFieldLength) token += char;
          else { overflow = true; token = ""; }
        }
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char !== '"') continue;
        inString = false;
        if (depth === 1) {
          let value = "";
          if (capture && !overflow) {
            try { value = JSON.parse(token); } catch { invalid = true; }
          }
          if (stage === "key") { key = value; stage = "colon"; }
          else if (stage === "value") {
            if (selected.has(key)) fields[key] = value;
            stage = "after";
          }
        }
        token = "";
        continue;
      }
      if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
      if (!started) {
        if (char !== "{") { invalid = true; return; }
        started = true; depth = 1; continue;
      }
      if (ended) { invalid = true; return; }
      if (char === '"') {
        inString = true; escaped = false; overflow = false;
        capture = depth === 1 && (stage === "key" || (stage === "value" && selected.has(key)));
        token = capture ? '"' : "";
        continue;
      }
      if (char === "{" || char === "[") {
        if (depth === 1 && stage === "value") { delete fields[key]; stage = "after"; }
        depth += 1; continue;
      }
      if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) { ended = char === "}"; invalid ||= !ended; }
        continue;
      }
      if (depth !== 1) continue;
      if (char === ":" && stage === "colon") stage = "value";
      else if (char === ",") { stage = "key"; key = ""; }
      else if (stage === "value") { delete fields[key]; stage = "after"; }
    }
  };
  return {
    feed(chunk: Uint8Array) { scan(decoder.decode(chunk, { stream: true })); },
    finish(): { model: string; serviceTier: string | null } {
      scan(decoder.decode());
      if (invalid || !ended || inString) return { model: "", serviceTier: null };
      return { model: (fields.model || "").trim(), serviceTier: fields.service_tier || null };
    }
  };
}

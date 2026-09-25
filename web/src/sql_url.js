const MAX_SQL_BYTES = 1_000_000;
const MAX_ENCODED_LENGTH = 1_500_000;

function base64Url(bytes) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_ENCODED_LENGTH) {
    throw new Error("The saved SQL fragment is invalid or too large.");
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function collect(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("The saved SQL is too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function encodeSql(sql) {
  const bytes = new TextEncoder().encode(sql);
  if (bytes.byteLength > MAX_SQL_BYTES) throw new Error("SQL is too large to save in a URL.");
  if (typeof CompressionStream !== "function") return `u.${base64Url(bytes)}`;
  const compressed = await collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), MAX_SQL_BYTES + 4096);
  return `g.${base64Url(compressed)}`;
}

export async function decodeSql(encoded) {
  const match = /^(g|u)\.([A-Za-z0-9_-]+)$/.exec(encoded || "");
  if (!match) throw new Error("The saved SQL fragment has an unknown format.");
  const bytes = fromBase64Url(match[2]);
  let decoded = bytes;
  if (match[1] === "g") {
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot read compressed SQL links.");
    decoded = await collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_SQL_BYTES);
  }
  if (decoded.byteLength > MAX_SQL_BYTES) throw new Error("The saved SQL is too large.");
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
}

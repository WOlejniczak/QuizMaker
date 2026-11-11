// Wspólne elementy dostawców AI.
export class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Zamienia standardowy JSON Schema (używany przez Claude) na podzbiór OpenAPI używany przez Gemini:
 * typy wielkimi literami, bez additionalProperties, enum jako format "enum".
 */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (out.enum && out.type === 'STRING') out.format = 'enum';
  return out;
}

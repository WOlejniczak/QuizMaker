// Gemini API – wywołania bezpośrednio z przeglądarki (klucz użytkownika).
import { AIError, sleep, toGeminiSchema } from './common.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_ATTEMPTS = 4;

function retryDelayMs(errJson) {
  const info = errJson?.error?.details?.find((d) => String(d['@type'] || '').includes('RetryInfo'));
  const sec = parseFloat(info?.retryDelay);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

async function request(apiKey, path, init = {}) {
  try {
    return await fetch(`${BASE}/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init.headers || {}) },
    });
  } catch {
    throw new AIError('Nie udało się połączyć z Gemini API. Sprawdź połączenie z internetem.', 0);
  }
}

function errorFor(status, msg, model) {
  if (status === 400 && /api key/i.test(msg)) return new AIError('Nieprawidłowy klucz API Gemini.', 400);
  if (status === 401 || status === 403) return new AIError('Klucz API Gemini nie ma dostępu do tego API.', status);
  if (status === 404) return new AIError(`Model „${model}” nie istnieje lub jest niedostępny dla tego klucza.`, 404);
  return new AIError(`Błąd Gemini (${status}): ${msg || 'nieznany'}`, status);
}

/**
 * @param {{apiKey:string, model:string, doc:string, task:string, schema:object, temperature?:number, onStatus?:Function}} p
 * Dokument idzie jako PIERWSZA część promptu, a zadanie po nim – dzięki temu kolejne zapytania o ten sam
 * plik mają identyczny początek i Gemini może użyć automatycznego cache (implicit caching).
 */
export async function generateJSON({ apiKey, model, doc, task, schema, temperature = 0.4, onStatus }) {
  if (!apiKey) throw new AIError('Brak klucza API Gemini.', 0);

  const generationConfig = {
    temperature,
    responseMimeType: 'application/json',
    responseSchema: toGeminiSchema(schema),
  };
  // Myślenie zużywa tokeny – we Flash/Flash-Lite 2.5 wyłączamy je (wystarcza do układania pytań).
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const parts = doc ? [{ text: doc }, { text: task }] : [{ text: task }];
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });

  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await request(apiKey, `models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body });

    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      const u = data.usageMetadata || {};
      const usage = {
        input: u.promptTokenCount || 0,
        cached: u.cachedContentTokenCount || 0,
        output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      };
      if (!text) {
        const reason = cand?.finishReason || data.promptFeedback?.blockReason || 'nieznany';
        throw new AIError(`Gemini zwróciło pustą odpowiedź (powód: ${reason}).`, 200);
      }
      try {
        return { data: JSON.parse(text), usage };
      } catch {
        throw new AIError('Gemini zwróciło niepoprawny JSON (odpowiedź mogła zostać ucięta). Spróbuj ponownie.', 200);
      }
    }

    let errJson = null;
    try { errJson = await res.json(); } catch { /* brak treści */ }
    const msg = errJson?.error?.message || '';

    if (res.status === 429 || res.status >= 500) {
      lastErr = new AIError(
        res.status === 429
          ? 'Przekroczono limit darmowego planu Gemini. Odczekaj chwilę lub zmień model.'
          : 'Serwer Gemini jest chwilowo przeciążony. Spróbuj ponownie za moment.',
        res.status,
      );
      if (attempt === MAX_ATTEMPTS - 1) break;
      const wait = Math.min(65_000, (retryDelayMs(errJson) ?? 2000 * 2 ** attempt) + 500);
      onStatus?.(`${res.status === 429 ? 'Limit zapytań Gemini' : 'Gemini przeciążone'} – ponawiam za ${Math.ceil(wait / 1000)} s…`);
      await sleep(wait);
      continue;
    }
    throw errorFor(res.status, msg, model);
  }
  throw lastErr;
}

/** Sprawdza klucz i model bez zużywania tokenów (zapytanie o metadane modelu). */
export async function testConnection({ apiKey, model }) {
  if (!apiKey) throw new AIError('Brak klucza API Gemini.', 0);
  const res = await request(apiKey, `models/${encodeURIComponent(model)}`);
  if (res.ok) {
    const m = await res.json();
    return { name: m.displayName || model };
  }
  let msg = '';
  try { msg = (await res.json()).error?.message || ''; } catch { /* brak treści */ }
  throw errorFor(res.status, msg, model);
}

/** Lista modeli dostępnych dla klucza (tylko te, które generują tekst). */
export async function listModels({ apiKey }) {
  const res = await request(apiKey, 'models?pageSize=200');
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name)
      && !/embedding|image|tts|audio|live|vision/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
}

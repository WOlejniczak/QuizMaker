// Claude API (Anthropic) – oficjalne SDK ładowane z CDN, wywołania bezpośrednio z przeglądarki
// kluczem użytkownika (dangerouslyAllowBrowser – klucz nigdy nie trafia do plików strony).
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm';
import { AIError } from './common.js';

// Modele, dla których włączamy serwerowy fallback po odmowie (przy odmowie zapytanie przejmuje inny model).
const FALLBACK_MODELS = /^claude-(fable-5-2|fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
// Modele obsługujące parametr effort.
const EFFORT_MODELS = /^claude-(opus|sonnet|haiku|fable|mythos)-5/;

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

function translateError(e, model) {
  if (e instanceof AIError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AIError('Nieprawidłowy klucz API Claude.', 401);
  if (e instanceof Anthropic.PermissionDeniedError) return new AIError('Klucz API Claude nie ma uprawnień do tego modelu.', 403);
  if (e instanceof Anthropic.NotFoundError) return new AIError(`Model „${model}” nie istnieje lub jest niedostępny dla tego klucza.`, 404);
  if (e instanceof Anthropic.RateLimitError) return new AIError('Przekroczono limit zapytań Claude. Odczekaj chwilę i spróbuj ponownie.', 429);
  if (e instanceof Anthropic.BadRequestError) return new AIError(`Claude odrzucił zapytanie: ${e.error?.error?.message || e.message}`, 400);
  if (e instanceof Anthropic.APIConnectionError) return new AIError('Nie udało się połączyć z Claude API. Sprawdź połączenie z internetem.', 0);
  if (e instanceof Anthropic.APIError) return new AIError(`Błąd Claude (${e.status ?? '?'}): ${e.error?.error?.message || e.message}`, e.status);
  return new AIError(`Błąd Claude: ${e?.message || e}`, 0);
}

/**
 * Dokument trafia do promptu systemowego z cache_control – kolejne zapytania o ten sam plik
 * (ocena, generowanie, baza pytań) w ciągu kilku minut czytają go z cache, co jest dużo tańsze.
 */
export async function generateJSON({ apiKey, model, doc, task, schema }) {
  if (!apiKey) throw new AIError('Brak klucza API Claude.', 0);
  const c = client(apiKey);

  const params = {
    model,
    max_tokens: 64000,
    messages: [{ role: 'user', content: task }],
    output_config: {
      ...(EFFORT_MODELS.test(model) ? { effort: 'medium' } : {}),
      format: { type: 'json_schema', schema },
    },
  };
  if (doc) params.system = [{ type: 'text', text: doc, cache_control: { type: 'ephemeral' } }];

  let msg;
  try {
    const stream = FALLBACK_MODELS.test(model)
      ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : c.messages.stream(params);
    msg = await stream.finalMessage();
  } catch (e) {
    throw translateError(e, model);
  }

  if (msg.stop_reason === 'refusal') {
    throw new AIError(`Claude odmówił wykonania zadania${msg.stop_details?.category ? ` (kategoria: ${msg.stop_details.category})` : ''}.`, 200);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new AIError('Odpowiedź Claude została ucięta (limit długości). Zmniejsz liczbę pytań.', 200);
  }

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = msg.usage || {};
  const usage = {
    input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    cached: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
  };
  try {
    return { data: JSON.parse(text), usage };
  } catch {
    throw new AIError('Claude zwrócił niepoprawny JSON. Spróbuj ponownie.', 200);
  }
}

/** Sprawdza klucz i model bez zużywania tokenów (Models API). */
export async function testConnection({ apiKey, model }) {
  if (!apiKey) throw new AIError('Brak klucza API Claude.', 0);
  try {
    const m = await client(apiKey).models.retrieve(model);
    return { name: m.display_name || model };
  } catch (e) {
    throw translateError(e, model);
  }
}

/** Lista modeli dostępnych dla klucza. */
export async function listModels({ apiKey }) {
  const out = [];
  try {
    for await (const m of client(apiKey).models.list()) {
      out.push({ id: m.id, label: m.display_name || m.id });
    }
  } catch {
    return [];
  }
  return out;
}

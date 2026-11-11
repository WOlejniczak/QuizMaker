// Warstwa AI niezależna od dostawcy: prompty, schematy odpowiedzi, wybór dostawcy (Gemini / Claude).
import { AIError } from './providers/common.js';

export { AIError };
export const MAX_DOC_CHARS = 300_000; // ~75k tokenów
const BANK_CHUNK_CHARS = 20_000;      // większe porcje = mniej zapytań, w każdym jest cały dokument

export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Darmowy klucz z Google AI Studio',
    placeholder: 'AIza...',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (zalecany, darmowy)' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (najszybszy, wyższe limity)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (najlepsza jakość, niskie limity)' },
    ],
    load: () => import('./providers/gemini.js'),
  },
  claude: {
    label: 'Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Płatny klucz z konsoli Anthropic (rozliczenie za tokeny)',
    placeholder: 'sk-ant-...',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (zalecany)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (szybszy, tańszy)' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (najtańszy)' },
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 (najmocniejszy, najdroższy)' },
    ],
    load: () => import('./providers/claude.js'),
  },
};

async function provider(cfg) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new AIError(`Nieznany dostawca: ${cfg.provider}`, 0);
  try {
    return await p.load();
  } catch {
    throw new AIError(`Nie udało się załadować modułu ${p.label}. Sprawdź połączenie z internetem.`, 0);
  }
}

export async function testConnection(cfg) {
  return (await provider(cfg)).testConnection(cfg);
}

export async function listModels(cfg) {
  try { return await (await provider(cfg)).listModels(cfg); } catch { return []; }
}

// Statystyki zużycia tokenów (wyświetlane w UI).
async function run(cfg, { doc, task, schema, temperature, onStatus, label }) {
  const p = await provider(cfg);
  const { data, usage } = await p.generateJSON({ ...cfg, doc, task, schema, temperature, onStatus });
  window.dispatchEvent(new CustomEvent('ai-usage', { detail: { ...usage, label, provider: cfg.provider, model: cfg.model } }));
  return data;
}

// ---------- Dokument ----------
const DOC_HEADER = `Poniżej znajduje się dokument źródłowy w formacie Markdown, przekonwertowany z PDF.
Początek każdej strony oznaczony jest komentarzem <!-- strona: N -->, gdzie N to numer strony w PDF.

=== DOKUMENT ŹRÓDŁOWY ===
`;

/**
 * Zwięzła, DETERMINISTYCZNA wersja dokumentu dla AI. Ten sam plik daje zawsze identyczny tekst,
 * więc kolejne zapytania mają wspólny początek, który dostawcy mogą czytać z cache.
 */
export function prepareDoc(markdown) {
  let doc = markdown
    .replace(/^---$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const truncated = doc.length > MAX_DOC_CHARS;
  if (truncated) doc = doc.slice(0, MAX_DOC_CHARS);
  return { doc: DOC_HEADER + doc + '\n=== KONIEC DOKUMENTU ŹRÓDŁOWEGO ===', truncated };
}

// ---------- Schematy (standardowy JSON Schema; dla Gemini konwertowany automatycznie) ----------
const obj = (properties, extra = {}) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...extra,
});
const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description) => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });

const ASSESS_SCHEMA = obj({
  suitable: bool('Czy z dokumentu da się zrobić sensowny quiz ABCD'),
  reason: str('Krótkie uzasadnienie (1-3 zdania, po polsku)'),
  topics: arr(str(), 'Główne tematy dokumentu (maks. 8)'),
  maxQuestions: int('Ile dobrych, nie powtarzających się pytań można ułożyć'),
  language: str('Język dokumentu, np. polski'),
});

const QUESTION_PROPS = {
  type: { type: 'string', enum: ['abcd', 'open'] },
  question: str(),
  options: arr(str(), 'Dokładnie 4 odpowiedzi dla abcd, pusta lista dla open'),
  correctIndex: int('0-3 dla abcd, -1 dla open'),
  optionExplanations: arr(str(), 'Dla abcd: 4 krótkie wyjaśnienia – dlaczego każda odpowiedź jest poprawna/błędna. Dla open: pusta lista'),
  modelAnswer: str('Dla open: wzorcowa odpowiedź. Dla abcd: pusty string'),
  explanation: str('Ogólne wyjaśnienie poprawnej odpowiedzi'),
  sourceQuote: str('Dosłowny fragment dokumentu (maks. 200 znaków) potwierdzający odpowiedź'),
  page: int('Numer strony, z której pochodzi sourceQuote'),
};

const QUESTIONS_SCHEMA = obj({ questions: arr(obj(QUESTION_PROPS)) });

const OWN_SCHEMA = obj({
  questions: arr(obj({
    ...QUESTION_PROPS,
    inDocument: bool('Czy odpowiedź da się potwierdzić w dokumencie źródłowym'),
    bankNote: str('Uwaga, gdy odpowiedź zaznaczona w bazie różni się od dokumentu lub baza nie miała odpowiedzi/wariantów. Inaczej pusty string'),
  })),
});

const GRADE_SCHEMA = obj({
  results: arr(obj({
    id: int(),
    correct: bool(),
    feedback: str('Krótki komentarz (1-2 zdania): co było dobrze/źle'),
  })),
});

const QUESTION_RULES = `- Pytania "abcd": dokładnie 4 odpowiedzi, dokładnie jedna poprawna, błędne odpowiedzi wiarygodne
  (podobna długość i styl jak poprawna). Nie używaj odpowiedzi typu "wszystkie powyższe".
  Nie dodawaj liter A/B/C/D ani numerów na początku odpowiedzi.
- optionExplanations: dla każdej z 4 odpowiedzi jedno zdanie wyjaśniające, dlaczego jest poprawna lub błędna,
  odwołując się do treści dokumentu źródłowego.
- sourceQuote: DOSŁOWNIE skopiowany, ciągły fragment tekstu dokumentu źródłowego (maks. 200 znaków), który
  potwierdza poprawną odpowiedź. Nie parafrazuj, nie kopiuj znaczników Markdown ani komentarzy.
- page: numer strony (z najbliższego wcześniejszego znacznika <!-- strona: N -->), na której jest sourceQuote.
- Pytania "open": options = [], correctIndex = -1, optionExplanations = [], modelAnswer = zwięzła wzorcowa odpowiedź.`;

function isValidQuestion(q) {
  if (!q || !q.question) return false;
  if (q.type === 'open') return true;
  return Array.isArray(q.options) && q.options.length === 4 && q.correctIndex >= 0 && q.correctIndex <= 3;
}

// ---------- 1. Ocena dokumentu ----------
export async function assessDocument(cfg, markdown, { onStatus } = {}) {
  const { doc, truncated } = prepareDoc(markdown);
  const task = `Zadanie: oceń, czy na podstawie powyższego dokumentu źródłowego da się ułożyć quiz jednokrotnego
wyboru (A/B/C/D) sprawdzający wiedzę z jego treści. Dokument nadaje się, jeśli zawiera merytoryczne informacje
(fakty, definicje, pojęcia, procesy, daty, zależności). Nie nadaje się, jeśli jest pusty, składa się głównie
z nieczytelnego tekstu, samych tabel liczb bez kontekstu, formularza itp. Odpowiadaj po polsku.`;
  const result = await run(cfg, { doc, task, schema: ASSESS_SCHEMA, temperature: 0.2, onStatus, label: 'Ocena dokumentu' });
  return { ...result, truncated };
}

// ---------- 2. Generowanie pytań ----------
/**
 * @param {string[]} avoid – treści pytań, które już są w puli (żeby nie generować duplikatów)
 */
export async function generateQuestions(cfg, markdown, { abcdCount, openCount, language = 'polski', avoid = [], onStatus }) {
  const { doc } = prepareDoc(markdown);
  const avoidList = avoid.slice(-150).map((q) => `- ${q.slice(0, 140)}`).join('\n');
  const task = `Zadanie: ułóż quiz sprawdzający wiedzę z powyższego dokumentu źródłowego.
- Liczba pytań typu "abcd": ${abcdCount}
- Liczba pytań typu "open" (otwartych): ${openCount}

Zasady:
- Pytania muszą wynikać WYŁĄCZNIE z treści dokumentu. Nie dodawaj wiedzy spoza niego.
- Pytania mają pokrywać cały dokument (początek, środek i koniec), bez powtórzeń.
- Poprawna odpowiedź ma być na losowej pozycji.
${QUESTION_RULES}
- Język pytań: ${language}.
${avoidList ? `
Te pytania już istnieją – NIE powtarzaj ich ani nie pytaj o to samo innymi słowami, wybierz inne fragmenty dokumentu:
${avoidList}` : ''}`;

  const result = await run(cfg, { doc, task, schema: QUESTIONS_SCHEMA, temperature: 0.7, onStatus, label: 'Generowanie pytań' });
  return (result.questions || []).filter(isValidQuestion);
}

// ---------- 3. Własna baza pytań ----------
const QUESTION_START_RE = /^\s*(\d{1,4}\s*[.)]|pytanie\s*\d+|zadanie\s*\d+|q\s*\d+|\{\s*"question")/i;

/** Dzieli bazę pytań na porcje, starając się nie rozcinać pojedynczych pytań. */
export function splitBank(text, max = BANK_CHUNK_CHARS) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasMarkers = lines.filter((l) => QUESTION_START_RE.test(l)).length >= 2;

  const blocks = [];
  let cur = [];
  for (const line of lines) {
    const boundary = hasMarkers ? QUESTION_START_RE.test(line) : line.trim() === '';
    if (boundary && cur.length) { blocks.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));

  const chunks = [];
  let chunk = '';
  for (let block of blocks) {
    while (block.length > max) {
      if (chunk) { chunks.push(chunk); chunk = ''; }
      chunks.push(block.slice(0, max));
      block = block.slice(max);
    }
    if (chunk.length + block.length + 1 > max && chunk) { chunks.push(chunk); chunk = ''; }
    chunk += (chunk ? '\n' : '') + block;
  }
  if (chunk.trim()) chunks.push(chunk);
  return chunks.filter((c) => c.trim());
}

export async function processOwnQuestions(cfg, markdown, bankText, { openQuestions, language = 'polski', onProgress, onStatus }) {
  const { doc } = prepareDoc(markdown);
  const chunks = splitBank(bankText);
  const all = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const task = `Poniżej jest fragment WŁASNEJ BAZY PYTAŃ użytkownika (może to być lista pytań, test z odpowiedziami,
JSON, CSV albo luźny tekst). Zadanie: wyodrębnij KAŻDE pytanie z bazy i zamień je na pytanie quizu
oparte na powyższym dokumencie źródłowym.

Zasady:
- Zachowaj treść pytania z bazy (możesz poprawić tylko literówki i formatowanie). Nie wymyślaj nowych pytań
  i nie pomijaj żadnego pytania z bazy. Pomiń tylko fragmenty, które nie są pytaniami (nagłówki, instrukcje).
- Jeśli pytanie z bazy ma warianty odpowiedzi – użyj ich. Gdy jest ich więcej niż 4, zostaw poprawną i 3 najlepsze
  błędne; gdy mniej niż 4 – dopisz wiarygodne błędne warianty na podstawie dokumentu.
- Jeśli w bazie zaznaczono poprawną odpowiedź (np. gwiazdką, pogrubieniem, kluczem odpowiedzi, "Odp: B"),
  sprawdź ją z dokumentem źródłowym. Gdy dokument wyraźnie mówi co innego – jako poprawną ustaw wersję
  z dokumentu i opisz rozbieżność w bankNote (np. "W Twojej bazie zaznaczono: ...").
- Jeśli baza nie podaje odpowiedzi – ustal ją na podstawie dokumentu źródłowego.
- Pytanie bez wariantów: ${openQuestions
    ? 'zostaw jako typ "open" z modelAnswer.'
    : 'zamień na typ "abcd" (poprawna odpowiedź z dokumentu + 3 wiarygodne błędne) i odnotuj to w bankNote.'}
- Jeśli odpowiedzi nie da się znaleźć w dokumencie źródłowym: inDocument = false, odpowiedz najlepiej jak umiesz,
  sourceQuote = "" i page = 0, a w explanation napisz, że materiał tego nie obejmuje.
${QUESTION_RULES}
- Język wyjaśnień: ${language}.

=== WŁASNA BAZA PYTAŃ (część ${i + 1} z ${chunks.length}) ===
${chunks[i]}`;

    const result = await run(cfg, { doc, task, schema: OWN_SCHEMA, temperature: 0.2, onStatus, label: `Baza pytań ${i + 1}/${chunks.length}` });
    all.push(...(result.questions || []).filter(isValidQuestion).map((q) => ({ ...q, origin: 'own' })));
  }
  onProgress?.(chunks.length, chunks.length);
  return all;
}

// ---------- 4. Ocena pytań otwartych ----------
export async function gradeOpenAnswers(cfg, items, { onStatus } = {}) {
  if (!items.length) return [];
  const task = `Oceń odpowiedzi ucznia na pytania otwarte. Dla każdego pytania porównaj odpowiedź ucznia
z odpowiedzią wzorcową i fragmentem źródłowym. Uznaj odpowiedź za poprawną, jeśli zawiera kluczowe
informacje z odpowiedzi wzorcowej (nie wymagaj identycznego sformułowania). Pusta odpowiedź jest błędna.
Komentarze pisz po polsku.

${JSON.stringify(items, null, 2)}`;
  const result = await run(cfg, { doc: '', task, schema: GRADE_SCHEMA, temperature: 0.1, onStatus, label: 'Ocena odpowiedzi otwartych' });
  return result.results || [];
}

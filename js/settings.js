// Ustawienia, dostawca, modele i klucze API – przechowywane tylko w localStorage przeglądarki.
import { PROVIDERS } from './ai.js';

const SETTINGS_KEY = 'quizmaker.settings';
const PROVIDER_KEY = 'quizmaker.provider';
const apiKeyName = (p) => `quizmaker.key.${p}`;
const modelKeyName = (p) => `quizmaker.model.${p}`;

export const DEFAULT_SETTINGS = {
  shuffleQuestions: true,
  shuffleAnswers: true,
  openQuestions: false,
  questionCount: 10,
  questionSource: 'mixed', // 'generated' | 'own' | 'mixed' – używane, gdy wczytano własną bazę pytań
  saver: true,             // tryb oszczędny: używaj zapisanych pytań zamiast generować nowe
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* np. tryb prywatny */ }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignoruj */ }
}

// Migracja z wersji, która obsługiwała tylko Gemini.
(function migrate() {
  const oldKey = safeGet('quizmaker.apiKey');
  if (oldKey && !safeGet(apiKeyName('gemini'))) safeSet(apiKeyName('gemini'), oldKey);
  const oldModel = safeGet('quizmaker.model');
  if (oldModel && !safeGet(modelKeyName('gemini'))) safeSet(modelKeyName('gemini'), oldModel);
  safeRemove('quizmaker.apiKey');
  safeRemove('quizmaker.model');
})();

export function loadSettings() {
  try {
    const raw = safeGet(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  safeSet(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadProvider() {
  const p = safeGet(PROVIDER_KEY);
  return PROVIDERS[p] ? p : 'gemini';
}
export function saveProvider(p) { safeSet(PROVIDER_KEY, p); }

export function loadApiKey(p = loadProvider()) { return safeGet(apiKeyName(p)) || ''; }
export function saveApiKey(p, key) {
  if (key.trim()) safeSet(apiKeyName(p), key.trim()); else safeRemove(apiKeyName(p));
}

export function loadModel(p = loadProvider()) { return safeGet(modelKeyName(p)) || PROVIDERS[p].models[0].id; }
export function saveModel(p, model) { safeSet(modelKeyName(p), model); }

/** Aktualna konfiguracja AI: dostawca, klucz i model. */
export function aiConfig() {
  const provider = loadProvider();
  return { provider, apiKey: loadApiKey(provider), model: loadModel(provider) };
}

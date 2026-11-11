import { pdfToMarkdown } from './pdf2md.js';
import * as ai from './ai.js';
import {
  loadSettings, saveSettings, loadProvider, saveProvider, loadApiKey, saveApiKey, loadModel, saveModel, aiConfig,
} from './settings.js';
import { getDoc, putDoc, deleteDoc, listDocs, sha256 } from './db.js';
import { buildQuiz, scoreQuiz, shuffle } from './quiz.js';
import { renderSummary, escapeHtml } from './summary.js';

const $ = (id) => document.getElementById(id);
const LETTERS = ['A', 'B', 'C', 'D'];
const MIN_BATCH = 15;  // przy generowaniu prosimy o co najmniej tyle pytań – jedno zapytanie zasila kilka quizów
const MAX_BATCH = 40;  // maksimum pytań w jednym zapytaniu – większe liczby generujemy w kilku porcjach
const MAX_QUESTIONS = 100;

const state = {
  rec: null,          // zapisany rekord pliku: { hash, name, markdown, pages, numPages, charCount, assessment, pool, banks, activeBank }
  forced: false,      // użytkownik kliknął „Mimo to spróbuj”
  rawQuestions: [],
  quiz: [],
  current: 0,
  answers: new Map(),
  score: null,
  conn: { status: 'idle', message: '' },
  liveModels: {},     // provider -> [{id,label}] pobrane z API
  usage: { calls: 0, input: 0, cached: 0, output: 0, saved: 0 },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fmt = (n) => Number(n || 0).toLocaleString('pl-PL');

// ---------- Pomocnicze UI ----------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  const order = ['upload', 'setup', 'quiz', 'summary'];
  const idx = order.indexOf(name);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('current', i === idx);
    if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loading(text) {
  if (text === false) { $('loader').hidden = true; return; }
  $('loader-text').textContent = text;
  $('loader').hidden = false;
}

let toastTimer;
function toast(msg, type = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type === 'info' ? '' : 'error'}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, type === 'info' ? 2500 : 6000);
}

// Polska odmiana: 1 pytanie, 2–4 pytania, 5+ pytań
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n === 1) return one;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
}
const pytan = (n) => `${n} ${plural(n, 'pytanie', 'pytania', 'pytań')}`;

function requireApiKey() {
  if (loadApiKey()) return true;
  openApiPanel();
  toast(`Najpierw zapisz klucz API ${ai.PROVIDERS[loadProvider()].label}.`);
  return false;
}

function openApiPanel() {
  const dlg = $('api-dialog');
  if (!dlg.open) dlg.showModal();
}

async function saveRecord() {
  if (state.rec) await putDoc(state.rec);
}

// ---------- Motyw ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('quizmaker.theme'); } catch { /* ignoruj */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $('btn-theme').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('quizmaker.theme', next); } catch { /* ignoruj */ }
  });
}

// ---------- Model AI, klucz i status połączenia ----------
function renderModelSelect() {
  const provider = loadProvider();
  const recommended = ai.PROVIDERS[provider].models;
  const recIds = new Set(recommended.map((m) => m.id));
  const live = (state.liveModels[provider] || []).filter((m) => !recIds.has(m.id));
  const current = loadModel(provider);
  const known = recIds.has(current) || live.some((m) => m.id === current);

  const opt = (m, withId) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}${withId && m.label !== m.id ? ` (${escapeHtml(m.id)})` : ''}</option>`;
  $('api-model').innerHTML = `
    <optgroup label="Polecane">${recommended.map((m) => opt(m, false)).join('')}</optgroup>
    ${live.length ? `<optgroup label="Inne dostępne dla Twojego klucza">${live.map((m) => opt(m, true)).join('')}</optgroup>` : ''}
    ${known ? '' : `<optgroup label="Zapisany">${opt({ id: current, label: current }, false)}</optgroup>`}`;
  $('api-model').value = current;
}

function renderApiPanel() {
  const provider = loadProvider();
  const info = ai.PROVIDERS[provider];
  document.querySelectorAll('input[name="provider"]').forEach((r) => { r.checked = r.value === provider; });
  $('api-key').value = loadApiKey(provider);
  $('api-key').placeholder = info.placeholder;
  $('key-hint').textContent = info.keyHint;
  $('key-link').href = info.keyUrl;
  renderModelSelect();
  renderConnection();
}

function renderConnection() {
  const { status, message } = state.conn;
  const provider = loadProvider();
  const model = loadModel(provider);
  const label = `${ai.PROVIDERS[provider].label} · ${model}`;

  $('conn-label').textContent = status === 'nokey' ? 'Połącz model AI' : label;
  $('conn-dot').className = `status-dot ${status}`;
  $('conn-pill').title = `${label}\n${message}`;

  const badge = $('api-status');
  const map = {
    ok: ['Połączono', 'tag-ok'], error: ['Błąd', 'tag-bad'], checking: ['Sprawdzanie', 'tag-warn'], nokey: ['Brak klucza', 'tag-bad'], idle: ['', ''],
  };
  badge.textContent = map[status][0];
  badge.className = `tag ${map[status][1]}`;

  const box = $('conn-status');
  box.className = `conn-status ${status}`;
  box.textContent = message;

  $('ai-hint').hidden = !(status === 'nokey' || status === 'error');
  $('ai-hint').querySelector('strong').textContent = status === 'error' ? 'Brak połączenia z modelem AI' : 'Połącz model AI';
  $('ai-hint').querySelector('p').textContent = status === 'error'
    ? message
    : 'Do oceny dokumentu i układania pytań potrzebny jest klucz API Gemini (darmowy) lub Claude.';
}

let connSeq = 0;
async function testConnection({ fetchModels = false } = {}) {
  const cfg = aiConfig();
  const seq = ++connSeq;
  if (!cfg.apiKey) {
    state.conn = { status: 'nokey', message: `Wpisz klucz API ${ai.PROVIDERS[cfg.provider].label} i kliknij „Zapisz i sprawdź połączenie”.` };
    renderConnection();
    return false;
  }
  state.conn = { status: 'checking', message: `Sprawdzam połączenie z ${cfg.model}…` };
  renderConnection();
  try {
    const info = await ai.testConnection(cfg);
    if (seq !== connSeq) return false; // w międzyczasie zmieniono model
    state.conn = { status: 'ok', message: `Połączono z modelem ${info.name} (${cfg.model}). Test nie zużył tokenów.` };
    renderConnection();
    if (fetchModels || !state.liveModels[cfg.provider]) {
      ai.listModels(cfg).then((list) => {
        if (list.length) { state.liveModels[cfg.provider] = list; renderModelSelect(); }
      });
    }
    return true;
  } catch (e) {
    if (seq !== connSeq) return false;
    state.conn = { status: 'error', message: `Nie udało się połączyć z ${cfg.model}: ${e.message}` };
    renderConnection();
    return false;
  }
}

function initApiPanel() {
  document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener('change', () => {
    saveProvider(r.value);
    renderApiPanel();
    testConnection();
  }));
  $('api-model').addEventListener('change', () => {
    saveModel(loadProvider(), $('api-model').value);
    testConnection();
  });
  $('api-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const provider = loadProvider();
    saveApiKey(provider, $('api-key').value);
    saveModel(provider, $('api-model').value);
    const ok = await testConnection({ fetchModels: true });
    if (ok) {
      setTimeout(() => $('api-dialog').close(), 700);
      if (state.rec && !state.rec.assessment) runAssessment();
    }
  });
  $('conn-pill').addEventListener('click', openApiPanel);
  $('btn-open-ai').addEventListener('click', openApiPanel);
  $('btn-close-api').addEventListener('click', () => $('api-dialog').close());
  // Kliknięcie w tło zamyka okno.
  $('api-dialog').addEventListener('click', (e) => { if (e.target === $('api-dialog')) $('api-dialog').close(); });

  renderApiPanel();
  if (loadApiKey()) testConnection();
  else { state.conn = { status: 'nokey', message: 'Wpisz klucz API i kliknij „Zapisz i sprawdź połączenie”.' }; renderConnection(); }
}

// ---------- Zużycie tokenów ----------
function renderUsage() {
  const u = state.usage;
  const last = u.last;
  const bar = $('usage-bar');
  const parts = [];
  if (last) {
    parts.push(`Ostatnie zapytanie: ${escapeHtml(last.label)}, ${escapeHtml(last.model)} – ${fmt(last.input)} tokenów wejścia`
      + (last.cached ? ` (${fmt(last.cached)} z cache)` : '') + `, ${fmt(last.output)} wyjścia`);
  }
  if (u.calls) parts.push(`Sesja: ${u.calls} ${plural(u.calls, 'zapytanie', 'zapytania', 'zapytań')}, ${fmt(u.input + u.output)} tokenów`);
  if (u.saved) parts.push(`Pominięte dzięki zapisanym wynikom: ${u.saved} ${plural(u.saved, 'zapytanie', 'zapytania', 'zapytań')}`);
  bar.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
  bar.hidden = !parts.length;
}

function initUsage() {
  window.addEventListener('ai-usage', (e) => {
    const d = e.detail;
    state.usage.calls++;
    state.usage.input += d.input;
    state.usage.cached += d.cached;
    state.usage.output += d.output;
    state.usage.last = d;
    renderUsage();
  });
}

function countSaved(n = 1) {
  state.usage.saved += n;
  renderUsage();
}

// ---------- Upload materiału źródłowego ----------
function bindDropzone(zone, onFile) {
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

function initUpload() {
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
    e.target.value = '';
  });
  bindDropzone($('dropzone'), handleFile);
}

async function handleFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('To nie jest plik PDF.');
    return;
  }
  try {
    loading('Wczytuję PDF…');
    const hash = await sha256(await file.arrayBuffer());
    let rec = await getDoc(hash);

    if (rec) {
      rec.name = file.name;
    } else {
      const result = await pdfToMarkdown(file, (n, total) => loading(`Konwertuję PDF na Markdown… strona ${n}/${total}`));
      if (result.charCount < 200) {
        loading(false);
        toast('Nie znaleziono tekstu w PDF. To prawdopodobnie skan – potrzebny jest PDF z warstwą tekstową (OCR).');
        return;
      }
      rec = { hash, name: file.name, ...result, assessment: null, pool: [], banks: {}, activeBank: null };
    }
    loading(false);
    await openRecord(rec);
  } catch (e) {
    loading(false);
    console.error(e);
    toast(`Nie udało się odczytać PDF: ${e.message}`);
  }
}

/** Otwiera plik (nowo wgrany albo wybrany z listy wcześniej używanych). */
async function openRecord(rec) {
  state.rec = rec;
  state.forced = false;
  state.rawQuestions = [];
  await saveRecord();
  renderDocInfo();
  renderBank();
  showScreen('setup');
  runAssessment();
  renderRecent();
}

// ---------- Wcześniej używane pliki ----------
let recentList = [];

function recentLabel(d) {
  const date = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) : '';
  return `${d.name} · ${d.numPages} ${plural(d.numPages, 'strona', 'strony', 'stron')}${date ? ` · ${date}` : ''}`;
}

function renderRecentMeta() {
  const d = recentList.find((x) => x.hash === $('recent-select').value);
  if (!d) { $('recent-meta').textContent = ''; return; }
  const parts = [
    d.assessed ? 'ocena zapisana' : 'bez oceny',
    `${pytan(d.pool)} AI w puli`,
    d.banks ? `${d.banks} ${plural(d.banks, 'baza', 'bazy', 'baz')} pytań` : '',
  ].filter(Boolean);
  $('recent-meta').textContent = `Zapisane: ${parts.join(', ')}.`;
}

async function renderRecent() {
  recentList = await listDocs();
  $('recent').hidden = !recentList.length;
  if (!recentList.length) return;
  const prev = $('recent-select').value;
  $('recent-select').innerHTML = recentList
    .map((d) => `<option value="${escapeHtml(d.hash)}">${escapeHtml(recentLabel(d))}</option>`)
    .join('');
  if (recentList.some((d) => d.hash === prev)) $('recent-select').value = prev;
  renderRecentMeta();
}

function initRecent() {
  $('recent-select').addEventListener('change', renderRecentMeta);
  $('btn-recent-open').addEventListener('click', async () => {
    const rec = await getDoc($('recent-select').value);
    if (!rec) { toast('Nie znaleziono zapisanych danych tego pliku.'); renderRecent(); return; }
    countSaved(); // brak konwersji PDF i ponownej analizy
    await openRecord(rec);
  });
  $('btn-recent-delete').addEventListener('click', async () => {
    const d = recentList.find((x) => x.hash === $('recent-select').value);
    if (!d || !confirm(`Usunąć „${d.name}” i wszystkie zapisane dla niego dane (ocena, pula pytań, bazy)?`)) return;
    await deleteDoc(d.hash);
    if (state.rec?.hash === d.hash) state.rec = null;
    renderRecent();
  });
  renderRecent();
}

function renderDocInfo() {
  const d = state.rec;
  $('doc-name').textContent = d.name;
  $('doc-meta').textContent = `${d.numPages} ${plural(d.numPages, 'strona', 'strony', 'stron')} · ${fmt(d.charCount)} znaków`
    + (d.markdown.length > ai.MAX_DOC_CHARS ? ' · dokument zostanie skrócony dla AI' : '');
  $('md-output').textContent = d.markdown;

  const banks = Object.keys(d.banks || {}).length;
  const saved = [d.assessment ? 'ocena dokumentu' : '', d.pool.length ? pytan(d.pool.length) + ' AI' : '', banks ? `${banks} ${plural(banks, 'baza', 'bazy', 'baz')} pytań` : '']
    .filter(Boolean);
  $('cache-note').hidden = !saved.length;
  $('cache-note').textContent = saved.length
    ? `Ten plik był już używany. Zapisane: ${saved.join(', ')} – ponowne użycie nie zużywa tokenów.`
    : '';
}

function downloadMarkdown() {
  if (!state.rec) return;
  const blob = new Blob([state.rec.markdown], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.rec.name.replace(/\.pdf$/i, '') + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Ocena ----------
function renderAssessment(a, fromCache) {
  const body = $('assessment-body');
  const topics = (a.topics || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const meta = [
    `Szacunkowo ${pytan(a.maxQuestions)} bez powtórzeń`,
    a.truncated ? 'analizowano tylko początek dokumentu' : '',
    fromCache ? 'zapisana ocena, 0 tokenów' : '',
  ].filter(Boolean).join(' · ');
  body.innerHTML = `
    <div class="verdict">
      <span class="verdict-mark ${a.suitable ? 'ok' : 'bad'}"></span>
      <div>
        <strong>${a.suitable ? 'Dokument nadaje się na quiz' : 'Dokument raczej nie nadaje się na quiz'}</strong>
        <p>${escapeHtml(a.reason)}</p>
      </div>
    </div>
    <p class="assess-meta">${meta}</p>
    ${topics ? `<div class="topics">${topics}</div>` : ''}
    ${a.suitable || state.forced ? '' : '<button id="btn-force" class="btn btn-secondary btn-sm" type="button" style="margin-top:14px">Mimo to kontynuuj</button>'}`;

  updatePoolInfo(); // szacunek z oceny jest tylko podpowiedzią – nie ogranicza liczby pytań

  $('btn-force')?.addEventListener('click', () => {
    state.forced = true;
    $('btn-force').remove();
    updateGenerateButton();
  });
  $('btn-assess').hidden = false;
  $('btn-assess').textContent = 'Oceń ponownie';
}

async function runAssessment(force = false) {
  const body = $('assessment-body');
  $('btn-assess').hidden = true;
  const rec = state.rec;

  if (rec.assessment && !force) {
    renderAssessment(rec.assessment, true);
    countSaved();
    updateGenerateButton();
    return;
  }

  rec.assessment = null;
  updateGenerateButton();

  if (!loadApiKey()) {
    body.innerHTML = 'Aby ocenić dokument, połącz model AI (przycisk w prawym górnym rogu).';
    $('btn-assess').hidden = false;
    $('btn-assess').textContent = 'Oceń dokument';
    return;
  }

  const spinner = (t) => `<div class="inline-loading"><div class="spinner"></div>${escapeHtml(t)}</div>`;
  body.innerHTML = spinner(`${ai.PROVIDERS[loadProvider()].label} analizuje dokument…`);
  try {
    const a = await ai.assessDocument(aiConfig(), rec.markdown, { onStatus: (t) => { body.innerHTML = spinner(t); } });
    if (state.rec !== rec) return; // w międzyczasie wgrano inny plik
    rec.assessment = a;
    await saveRecord();
    renderAssessment(a, false);
  } catch (e) {
    console.error(e);
    body.innerHTML = `<p class="note note-bad" style="margin:0">${escapeHtml(e.message)}</p>`;
    $('btn-assess').hidden = false;
    $('btn-assess').textContent = 'Spróbuj ponownie';
  }
  updateGenerateButton();
}

// ---------- Własna baza pytań ----------
function activeBank() {
  return state.rec?.activeBank ? state.rec.banks[state.rec.activeBank] : null;
}

function initBank() {
  $('bank-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleBankFile(f);
    e.target.value = '';
  });
  bindDropzone(document.querySelector('label[for="bank-input"]'), handleBankFile);
  $('btn-bank-paste').addEventListener('click', () => {
    const text = $('bank-text').value.trim();
    if (!text) { toast('Wklej najpierw pytania.'); return; }
    processBank(text, 'wklejone pytania');
  });
  $('btn-bank-remove').addEventListener('click', async () => {
    state.rec.activeBank = null; // przetworzona baza zostaje zapisana – ponowne wgranie nie zużyje tokenów
    await saveRecord();
    renderBank();
  });
}

async function handleBankFile(file) {
  try {
    let text;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      loading('Odczytuję PDF z pytaniami…');
      const r = await pdfToMarkdown(file, (n, t) => loading(`Odczytuję PDF z pytaniami… strona ${n}/${t}`));
      text = r.markdown.replace(/<!-- strona: \d+ -->/g, '').replace(/^---$/gm, '');
    } else {
      text = await file.text();
    }
    loading(false);
    if (text.trim().length < 10) { toast('Plik z pytaniami jest pusty.'); return; }
    await processBank(text, file.name);
  } catch (e) {
    loading(false);
    console.error(e);
    toast(`Nie udało się odczytać pliku z pytaniami: ${e.message}`);
  }
}

/** Przetwarza bazę przez AI – albo bierze gotowy wynik z pamięci, jeśli ta sama baza była już przetworzona. */
async function processBank(text, name, openQuestions = readSettingsForm().openQuestions) {
  const rec = state.rec;
  if (!rec) return false;
  const key = await sha256(`${openQuestions ? 'open' : 'abcd'}|${text.trim()}`);

  if (rec.banks[key]) {
    rec.banks[key].name = name;
    rec.activeBank = key;
    await saveRecord();
    countSaved();
    renderBank();
    toast('Ta baza była już przetworzona – użyto zapisanego wyniku (0 tokenów).', 'info');
    $('bank-text').value = '';
    return true;
  }

  if (!requireApiKey()) return false;
  const label = ai.PROVIDERS[loadProvider()].label;
  try {
    loading(`${label} dopasowuje Twoje pytania do materiału…`);
    const questions = await ai.processOwnQuestions(aiConfig(), rec.markdown, text, {
      openQuestions,
      language: rec.assessment?.language || 'polski',
      onProgress: (done, total) => {
        if (total > 1) loading(`${label} dopasowuje Twoje pytania do materiału… część ${Math.min(done + 1, total)}/${total}`);
      },
      onStatus: (t) => loading(t),
    });
    loading(false);
    if (!questions.length) {
      toast('Nie znaleziono żadnych pytań w podanej bazie.');
      return false;
    }
    rec.banks[key] = { name, rawText: text, processedOpen: openQuestions, questions: questions.map((q) => ({ ...q, uid: uid(), shown: 0 })) };
    rec.activeBank = key;
    await saveRecord();
    renderBank();
    $('bank-text').value = '';
    return true;
  } catch (e) {
    loading(false);
    console.error(e);
    toast(e.message);
    return false;
  }
}

function renderBank() {
  const bank = activeBank();
  $('bank-empty').hidden = !!bank;
  $('bank-loaded').hidden = !bank;
  if (bank) {
    const qs = bank.questions;
    const notInDoc = qs.filter((q) => q.inDocument === false).length;
    const notes = qs.filter((q) => q.bankNote).length;
    const open = qs.filter((q) => q.type === 'open').length;
    $('bank-summary').textContent = `${pytan(qs.length)} · ${bank.name}`;
    $('bank-details').textContent = [
      `${qs.length - open} ABCD`,
      open ? `${open} ${plural(open, 'otwarte', 'otwarte', 'otwartych')}` : '',
      notInDoc ? `${notInDoc} bez pokrycia w materiale` : '',
      notes ? `${notes} z uwagami` : '',
    ].filter(Boolean).join(' · ');
    $('set-own-count').max = qs.length;
    $('set-own-count').value = qs.length;
  }
  updateSourceUI();
}

// ---------- Ustawienia ----------
function questionSource() {
  return activeBank() ? (document.querySelector('input[name="qsource"]:checked')?.value || 'mixed') : 'generated';
}

function readSettingsForm() {
  const count = Math.max(1, Math.min(MAX_QUESTIONS, Math.round(Number($('set-count').value) || 10)));
  return {
    shuffleQuestions: $('set-shuffle').checked,
    shuffleAnswers: $('set-shuffle-answers').checked,
    openQuestions: $('set-open').checked,
    saver: $('set-saver').checked,
    questionCount: count,
    questionSource: document.querySelector('input[name="qsource"]:checked')?.value || 'mixed',
  };
}

function updateSourceUI() {
  const mode = questionSource();
  $('source-group').hidden = !activeBank();
  $('count-field').hidden = mode === 'own';
  $('own-count-field').hidden = mode === 'generated';
  updateGenerateButton();
}

function updateGenerateButton() {
  const mode = questionSource();
  const docOk = !!state.rec?.assessment && (state.rec.assessment.suitable || state.forced);
  const ok = mode === 'own' ? !!activeBank()?.questions.length : docOk;
  $('btn-generate').disabled = !ok;
  $('btn-generate').textContent = mode === 'own' ? 'Rozpocznij quiz' : 'Generuj quiz';
  updatePoolInfo();
}

function initSettings() {
  const s = loadSettings();
  $('set-shuffle').checked = s.shuffleQuestions;
  $('set-shuffle-answers').checked = s.shuffleAnswers;
  $('set-open').checked = s.openQuestions;
  $('set-saver').checked = s.saver;
  $('set-count').value = s.questionCount;
  const radio = document.querySelector(`input[name="qsource"][value="${s.questionSource}"]`);
  if (radio) radio.checked = true;

  ['set-shuffle', 'set-shuffle-answers', 'set-open', 'set-saver', 'set-count', 'set-own-count'].forEach((id) =>
    $(id).addEventListener('change', () => { saveSettings(readSettingsForm()); updatePoolInfo(); }));
  document.querySelectorAll('input[name="qsource"]').forEach((r) =>
    r.addEventListener('change', () => { saveSettings(readSettingsForm()); updateSourceUI(); }));
  $('btn-clear-pool').addEventListener('click', clearRecord);
  updateSourceUI();
}

// ---------- Pula pytań (oszczędzanie tokenów) ----------
function aiNeeds(settings) {
  const n = settings.questionCount;
  const open = settings.openQuestions ? Math.max(1, Math.round(n * 0.3)) : 0;
  return { abcd: n - open, open };
}

/** Ile pytań trzeba dogenerować, żeby złożyć quiz z puli. */
function planGeneration(pool, need, settings, maxQuestions) {
  const short = {};
  for (const t of ['abcd', 'open']) {
    const have = pool.filter((q) => q.type === t);
    const fresh = have.filter((q) => !q.shown);
    short[t] = Math.max(0, need[t] - (settings.saver ? have.length : fresh.length));
  }
  const total = short.abcd + short.open;
  if (!total) return { abcd: 0, open: 0 };

  // Jedno zapytanie = cały dokument na wejściu, więc prosimy od razu o zapas pytań na kolejne quizy.
  const capacity = Math.max(0, (maxQuestions || MAX_BATCH) - pool.length);
  const extra = Math.max(0, Math.min(MIN_BATCH - total, capacity - total));
  const openExtra = need.open ? Math.round(extra * 0.3) : 0;
  return {
    abcd: short.abcd + extra - openExtra,
    open: short.open + openExtra,
  };
}

/** Wybiera pytania: najpierw najrzadziej pokazywane, w obrębie równych – losowo. */
function pickLeastShown(questions, n) {
  return shuffle(questions).sort((a, b) => (a.shown || 0) - (b.shown || 0)).slice(0, n);
}

function updatePoolInfo() {
  const rec = state.rec;
  const box = $('pool-box');
  if (!rec) { box.hidden = true; return; }
  box.hidden = false;

  const settings = readSettingsForm();
  const mode = questionSource();
  const pool = rec.pool.filter((q) => settings.openQuestions || q.type !== 'open');
  const fresh = pool.filter((q) => !q.shown).length;
  const bank = activeBank();

  let next;
  if (mode === 'own') {
    next = 'bez zapytania do AI';
  } else {
    const plan = planGeneration(pool, aiNeeds(settings), settings, rec.assessment?.maxQuestions);
    const gen = plan.abcd + plan.open;
    const calls = Math.ceil(gen / MAX_BATCH);
    const reserve = gen > settings.questionCount ? ', z zapasem na kolejne quizy' : '';
    next = gen
      ? `${calls} ${plural(calls, 'zapytanie', 'zapytania', 'zapytań')} do AI (ok. ${pytan(gen)}${reserve})`
      : 'bez zapytania do AI';
  }

  const est = rec.assessment?.maxQuestions;
  const over = mode !== 'own' && est && settings.questionCount > est;
  $('count-hint').hidden = !over;
  if (over) {
    $('count-hint').textContent = `Wybrano ${pytan(settings.questionCount)}, a szacunek dla tego materiału to ok. ${est} bez powtórzeń. `
      + 'AI ułoży tyle, ile zaznaczono, ale część pytań może dotyczyć tych samych informacji.';
  }
  $('pool-info').innerHTML = `Zapisane dla tego pliku: <b>${pytan(pool.length)} AI</b>, w tym ${fresh} niewidzianych`
    + (bank ? `; <b>${pytan(bank.questions.length)}</b> z Twojej bazy` : '')
    + `.<br>Następny quiz: <b>${next}</b>.`;
}

async function clearRecord() {
  const rec = state.rec;
  if (!rec || !confirm('Usunąć zapisaną ocenę, pulę pytań AI i przetworzone bazy pytań dla tego pliku? Kolejne użycie znów zużyje tokeny.')) return;
  await deleteDoc(rec.hash);
  rec.assessment = null;
  rec.pool = [];
  rec.banks = {};
  rec.activeBank = null;
  await saveRecord();
  renderDocInfo();
  renderBank();
  $('assessment-body').innerHTML = 'Zapisane dane usunięte. Kliknij „Oceń dokument”, aby ocenić go ponownie.';
  $('btn-assess').hidden = false;
  $('btn-assess').textContent = 'Oceń dokument';
  updateGenerateButton();
}

// ---------- Generowanie ----------
async function generate() {
  const settings = readSettingsForm();
  saveSettings(settings);
  const mode = questionSource();
  const rec = state.rec;

  try {
    // Baza była przetworzona z pytaniami otwartymi, a teraz są wyłączone – potrzebna wersja ABCD (też zapisywana).
    let bank = activeBank();
    if (bank && mode !== 'generated' && bank.processedOpen && !settings.openQuestions && bank.questions.some((q) => q.type === 'open')) {
      await processBank(bank.rawText, bank.name, false);
      bank = activeBank();
    }

    let own = [];
    if (mode !== 'generated' && bank) {
      const allowed = bank.questions.filter((q) => settings.openQuestions || q.type !== 'open');
      const n = Math.max(1, Math.min(allowed.length, Math.round(Number($('set-own-count').value) || allowed.length)));
      own = settings.shuffleQuestions ? pickLeastShown(allowed, n) : allowed.slice(0, n);
    }

    let generated = [];
    if (mode !== 'own') {
      const need = aiNeeds(settings);
      const plan = planGeneration(rec.pool.filter((q) => settings.openQuestions || q.type !== 'open'), need, settings, rec.assessment?.maxQuestions);

      const total = plan.abcd + plan.open;
      if (total > 0) {
        if (!requireApiKey()) return;
        // Większe liczby pytań generujemy porcjami (po MAX_BATCH), żeby odpowiedź AI nie została ucięta.
        const batches = Math.ceil(total / MAX_BATCH);
        const left = { ...plan };
        const label = ai.PROVIDERS[loadProvider()].label;
        for (let b = 0; b < batches; b++) {
          const size = Math.min(MAX_BATCH, left.abcd + left.open);
          const open = Math.min(left.open, Math.round((size * left.open) / (left.abcd + left.open)));
          const abcd = size - open;
          loading(`${label} układa ${pytan(total)}${batches > 1 ? ` – część ${b + 1} z ${batches}` : ''}… (może to potrwać do minuty)`);
          const fresh = await ai.generateQuestions(aiConfig(), rec.markdown, {
            abcdCount: abcd,
            openCount: open,
            language: rec.assessment?.language || 'polski',
            avoid: rec.pool.map((q) => q.question),
            onStatus: (t) => loading(t),
          });
          rec.pool.push(...fresh.map((q) => ({ ...q, origin: 'ai', bankNote: '', uid: uid(), shown: 0 })));
          await saveRecord(); // zapis po każdej porcji – przy błędzie nic nie przepada
          left.abcd -= abcd;
          left.open -= open;
        }
        loading(false);
      } else {
        countSaved();
      }

      for (const t of ['abcd', 'open']) {
        if (need[t]) generated.push(...pickLeastShown(rec.pool.filter((q) => q.type === t), need[t]));
      }
    }

    const all = [...own, ...generated];
    if (!all.length) {
      toast('Brak pytań do quizu. Spróbuj ponownie.');
      return;
    }
    state.rawQuestions = all;
    // Oznacz pytania jako pokazane – przy kolejnym quizie pierwszeństwo mają te jeszcze niewidziane.
    all.forEach((q) => { q.shown = (q.shown || 0) + 1; });
    await saveRecord();
    renderDocInfo();
    startQuiz();
  } catch (e) {
    loading(false);
    console.error(e);
    toast(e.message);
  }
}

// ---------- Quiz ----------
function startQuiz() {
  state.quiz = buildQuiz(state.rawQuestions, state.rec.pages, loadSettings());
  state.current = 0;
  state.answers = new Map();
  state.score = null;
  showScreen('quiz');
  renderQuestion();
}

function goTo(index) {
  state.current = index;
  renderQuestion();
  const top = $('screen-quiz').getBoundingClientRect().top;
  if (top < 0) window.scrollTo({ top: window.scrollY + top - 8, behavior: 'smooth' });
}

function renderQuestion() {
  const q = state.quiz[state.current];
  const total = state.quiz.length;
  $('q-counter').textContent = `Pytanie ${state.current + 1} z ${total}`;
  $('q-type').textContent = (q.type === 'open' ? 'Pytanie otwarte' : 'Jednokrotny wybór') + (q.origin === 'own' ? ' · Twoja baza' : '');
  $('q-text').textContent = q.question;

  const box = $('q-answers');
  const answer = state.answers.get(q.id);
  if (q.type === 'abcd') {
    box.innerHTML = q.options
      .map((opt, i) => `<button type="button" class="answer ${answer === i ? 'selected' : ''}" data-i="${i}" aria-pressed="${answer === i}">
          <span class="letter">${LETTERS[i]}</span><span class="break">${escapeHtml(opt)}</span></button>`)
      .join('');
    box.querySelectorAll('.answer').forEach((btn) =>
      btn.addEventListener('click', () => selectAnswer(Number(btn.dataset.i))));
  } else {
    box.innerHTML = `<textarea id="open-answer" placeholder="Wpisz swoją odpowiedź…">${escapeHtml(answer || '')}</textarea>`;
    $('open-answer').addEventListener('input', (e) => {
      if (e.target.value.trim()) state.answers.set(q.id, e.target.value); else state.answers.delete(q.id);
      renderDots();
    });
  }

  $('btn-prev').disabled = state.current === 0;
  const last = state.current === total - 1;
  $('btn-next').textContent = last ? 'Sprawdź wynik' : 'Dalej';
  $('btn-finish').hidden = last;
  renderDots();
}

function renderDots() {
  const total = state.quiz.length;
  $('progress-bar').style.width = `${(state.answers.size / total) * 100}%`;
  $('q-dots').innerHTML = state.quiz
    .map((q, i) => `<button type="button" class="qnav-item ${state.answers.has(q.id) ? 'answered' : ''} ${i === state.current ? 'current' : ''}" data-i="${i}" aria-label="Pytanie ${i + 1}">${i + 1}</button>`)
    .join('');
  $('q-dots').querySelectorAll('.qnav-item').forEach((d) =>
    d.addEventListener('click', () => goTo(Number(d.dataset.i))));
}

function selectAnswer(i) {
  const q = state.quiz[state.current];
  state.answers.set(q.id, i);
  renderQuestion();
}

function next() {
  if (state.current < state.quiz.length - 1) goTo(state.current + 1);
  else finish();
}

function prev() {
  if (state.current > 0) goTo(state.current - 1);
}

async function finish() {
  const unanswered = state.quiz.length - state.answers.size;
  if (unanswered > 0 && !confirm(`Bez odpowiedzi: ${unanswered}. Czy na pewno zakończyć?`)) return;

  const openGrades = new Map();
  const toGrade = state.quiz
    .filter((q) => q.type === 'open' && (state.answers.get(q.id) || '').trim())
    .map((q) => ({ id: q.id, question: q.question, modelAnswer: q.modelAnswer, sourceQuote: q.sourceQuote, userAnswer: state.answers.get(q.id) }));

  if (toGrade.length) {
    const fail = (msg) => toGrade.forEach((it) => openGrades.set(it.id, { correct: false, feedback: msg }));
    if (!loadApiKey()) {
      fail('Nie oceniono – brak klucza API. Porównaj odpowiedź z odpowiedzią wzorcową.');
    } else {
      try {
        loading('AI ocenia odpowiedzi otwarte…');
        const results = await ai.gradeOpenAnswers(aiConfig(), toGrade, { onStatus: (t) => loading(t) });
        results.forEach((r) => openGrades.set(r.id, r));
      } catch (e) {
        console.error(e);
        toast(`Nie udało się ocenić pytań otwartych: ${e.message}`);
        fail('Nie udało się ocenić odpowiedzi (błąd AI) – porównaj ją z odpowiedzią wzorcową.');
      } finally {
        loading(false);
      }
    }
  }

  state.score = scoreQuiz(state.quiz, state.answers, openGrades);
  showSummary(false);
  showScreen('summary');
}

function showSummary(onlyWrong) {
  renderSummary($('summary'), state.score, { onlyWrong, onFilter: showSummary });
}

// ---------- Klawiatura ----------
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!$('screen-quiz').classList.contains('active') || !$('loader').hidden) return;
    if (['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
    const q = state.quiz[state.current];
    const key = e.key.toLowerCase();
    const idx = ['1', '2', '3', '4'].includes(key) ? Number(key) - 1 : ['a', 'b', 'c', 'd'].indexOf(key);
    if (q.type === 'abcd' && idx >= 0) { selectAnswer(idx); return; }
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft') prev();
  });
}

// ---------- Start ----------
function init() {
  initTheme();
  initUsage();
  initApiPanel();
  initUpload();
  initBank();
  initSettings();
  initRecent();
  initKeyboard();

  $('btn-download-md').addEventListener('click', downloadMarkdown);
  $('btn-assess').addEventListener('click', () => runAssessment(true));
  $('btn-generate').addEventListener('click', generate);
  $('btn-back-upload').addEventListener('click', () => { renderRecent(); showScreen('upload'); });
  $('btn-prev').addEventListener('click', prev);
  $('btn-next').addEventListener('click', next);
  $('btn-finish').addEventListener('click', finish);
  $('btn-retry').addEventListener('click', startQuiz);
  $('btn-regenerate').addEventListener('click', () => { updatePoolInfo(); showScreen('setup'); });
  $('btn-new-pdf').addEventListener('click', () => { renderRecent(); showScreen('upload'); });
  showScreen('upload');
}

init();

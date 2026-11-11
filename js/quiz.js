// Przygotowanie quizu: tasowanie, weryfikacja cytatów, liczenie wyniku.

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalizacja tekstu z PDF: łączy przeniesienia wyrazów, ujednolica spacje i cudzysłowy.
function normalize(s) {
  return (s || '')
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function findIn(pageText, quote) {
  const hay = normalize(pageText);
  const lower = hay.toLowerCase();
  const needle = normalize(quote).toLowerCase().replace(/^["'.…\s]+|["'.…\s]+$/g, '');
  if (!needle) return null;

  let idx = lower.indexOf(needle);
  let len = needle.length;
  // Gdy model lekko zmienił cytat – próbujemy dopasować jego początek.
  if (idx === -1 && needle.length > 40) {
    const head = needle.slice(0, 40);
    idx = lower.indexOf(head);
    len = Math.min(needle.length, hay.length - idx);
    if (idx !== -1) return { hay, idx, len, exact: false };
  }
  return idx === -1 ? null : { hay, idx, len, exact: true };
}

/**
 * Szuka cytatu na podanej stronie, a jeśli go tam nie ma – na pozostałych.
 * Zwraca poprawiony numer strony i fragment z kontekstem do wyświetlenia.
 */
export function locateQuote(pages, quote, claimedPage) {
  if (!quote || !quote.trim()) return { page: null, verified: false, missing: true, before: '', match: '', after: '' };
  const order = [];
  const claimed = pages.find((p) => p.num === claimedPage);
  if (claimed) order.push(claimed);
  for (const p of pages) if (p !== claimed) order.push(p);

  for (const p of order) {
    const hit = findIn(p.text, quote);
    if (hit) {
      const CTX = 140;
      const start = Math.max(0, hit.idx - CTX);
      const end = Math.min(hit.hay.length, hit.idx + hit.len + CTX);
      return {
        page: p.num,
        verified: hit.exact,
        before: (start > 0 ? '…' : '') + hit.hay.slice(start, hit.idx),
        match: hit.hay.slice(hit.idx, hit.idx + hit.len),
        after: hit.hay.slice(hit.idx + hit.len, end) + (end < hit.hay.length ? '…' : ''),
      };
    }
  }
  return { page: claimedPage, verified: false, before: '', match: quote, after: '' };
}

/** Buduje gotowy quiz z pytań Gemini zgodnie z ustawieniami. */
export function buildQuiz(rawQuestions, pages, settings) {
  let questions = rawQuestions.map((q, i) => {
    const base = { ...q, id: i, source: locateQuote(pages, q.sourceQuote, q.page) };
    if (q.type !== 'abcd' || !settings.shuffleAnswers) return base;

    const perm = shuffle([0, 1, 2, 3]);
    return {
      ...base,
      options: perm.map((k) => q.options[k]),
      optionExplanations: perm.map((k) => q.optionExplanations?.[k] || ''),
      correctIndex: perm.indexOf(q.correctIndex),
    };
  });

  if (settings.shuffleQuestions) questions = shuffle(questions);
  return questions;
}

/** Liczy wynik. answers: Map id -> number (abcd) | string (open); openGrades: Map id -> {correct, feedback} */
export function scoreQuiz(questions, answers, openGrades) {
  const results = questions.map((q) => {
    const answer = answers.get(q.id);
    let correct;
    let feedback = '';
    if (q.type === 'abcd') {
      correct = answer === q.correctIndex;
    } else {
      const g = openGrades.get(q.id);
      correct = !!g?.correct;
      feedback = g?.feedback || '';
    }
    return { q, answer, correct, feedback, skipped: answer === undefined || answer === '' };
  });
  const correctCount = results.filter((r) => r.correct).length;
  return { results, correctCount, wrongCount: results.length - correctCount, total: results.length };
}

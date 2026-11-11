// Render ekranu podsumowania.
const LETTERS = ['A', 'B', 'C', 'D'];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sourceBlock(src) {
  if (src.missing) {
    return '<figure class="source source-missing"><figcaption>Materiał źródłowy nie zawiera odpowiedzi na to pytanie</figcaption></figure>';
  }
  const note = src.verified ? '' : '<span class="tag tag-warn" title="Nie znaleziono dokładnie tego fragmentu w PDF">cytat przybliżony</span>';
  return `
    <figure class="source">
      <blockquote>${escapeHtml(src.before)}<mark>${escapeHtml(src.match)}</mark>${escapeHtml(src.after)}</blockquote>
      <figcaption>Strona ${escapeHtml(src.page)} ${note}</figcaption>
    </figure>`;
}

function abcdDetails(r) {
  const { q, answer, correct } = r;
  const opts = q.options
    .map((opt, i) => {
      const isCorrect = i === q.correctIndex;
      const isWrongPick = i === answer && !correct;
      const cls = isCorrect ? 'opt opt-correct' : isWrongPick ? 'opt opt-wrong' : 'opt';
      const tag = isCorrect ? (i === answer ? 'Twoja odpowiedź · poprawna' : 'Poprawna') : isWrongPick ? 'Twoja odpowiedź' : '';
      return `<li class="${cls}"><span class="letter">${LETTERS[i]}</span><span class="opt-text">${escapeHtml(opt)}</span>${tag ? `<span class="opt-tag">${tag}</span>` : ''}</li>`;
    })
    .join('');

  let why;
  if (correct) {
    why = q.explanation ? `<p>${escapeHtml(q.explanation)}</p>` : '';
  } else {
    const wrongWhy = answer !== undefined ? q.optionExplanations?.[answer] : '';
    why = `
      ${r.skipped ? '<p><strong>Brak odpowiedzi.</strong></p>' : ''}
      ${wrongWhy ? `<p><strong>Dlaczego ${LETTERS[answer]} jest błędna.</strong> ${escapeHtml(wrongWhy)}</p>` : ''}
      <p><strong>Poprawna odpowiedź: ${LETTERS[q.correctIndex]}.</strong> ${escapeHtml(q.optionExplanations?.[q.correctIndex] || q.explanation)}</p>`;
  }
  return `<ol class="options-review">${opts}</ol>${why ? `<div class="explain">${why}</div>` : ''}`;
}

function openDetails(r) {
  const { q, answer, correct, feedback } = r;
  return `
    <div class="answer-compare">
      <div><span>Twoja odpowiedź</span>${answer ? escapeHtml(answer) : '<em class="muted">brak</em>'}</div>
      <div><span>Odpowiedź wzorcowa</span>${escapeHtml(q.modelAnswer)}</div>
    </div>
    <div class="explain">
      ${feedback ? `<p><strong>${correct ? 'Komentarz.' : 'Dlaczego błędna.'}</strong> ${escapeHtml(feedback)}</p>` : ''}
      ${q.explanation ? `<p>${escapeHtml(q.explanation)}</p>` : ''}
    </div>`;
}

export function renderSummary(container, score, { onlyWrong = false, onFilter } = {}) {
  const pct = score.total ? Math.round((score.correctCount / score.total) * 100) : 0;
  const okW = score.total ? (score.correctCount / score.total) * 100 : 0;

  const items = score.results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !onlyWrong || !r.correct)
    .map(({ r, i }) => `
      <article class="review">
        <div class="review-head">
          <span class="review-num">${i + 1}.</span>
          <h3>${escapeHtml(r.q.question)}</h3>
          <div class="review-tags">
            ${r.q.origin === 'own' ? '<span class="tag tag-accent">Twoja baza</span>' : ''}
            <span class="tag ${r.correct ? 'tag-ok' : 'tag-bad'}">${r.correct ? 'Poprawnie' : 'Błędnie'}</span>
          </div>
        </div>
        ${r.q.type === 'abcd' ? abcdDetails(r) : openDetails(r)}
        ${r.q.bankNote ? `<p class="note note-warn bank-note">${escapeHtml(r.q.bankNote)}</p>` : ''}
        ${sourceBlock(r.q.source)}
      </article>`)
    .join('');

  container.innerHTML = `
    <div class="card">
      <div class="result-head">
        <div>
          <div class="result-label">Wynik</div>
          <div class="result-score">${score.correctCount}<span> / ${score.total}</span></div>
        </div>
        <div class="result-stats">
          <span><i class="stat-dot ok"></i><b>${score.correctCount}</b> poprawnych</span>
          <span><i class="stat-dot bad"></i><b>${score.wrongCount}</b> błędnych</span>
          <span><b>${pct}%</b></span>
        </div>
      </div>
      <div class="result-bar" role="img" aria-label="${pct}% poprawnych odpowiedzi">
        <div class="ok" style="width:${okW}%"></div><div class="bad" style="width:${100 - okW}%"></div>
      </div>
    </div>
    <div class="result-filter">
      <h2>Odpowiedzi</h2>
      <div class="segmented" role="radiogroup" aria-label="Filtr">
        <label><input type="radio" name="summary-filter" value="all" ${onlyWrong ? '' : 'checked'}><span>Wszystkie</span></label>
        <label><input type="radio" name="summary-filter" value="wrong" ${onlyWrong ? 'checked' : ''}><span>Błędne</span></label>
      </div>
    </div>
    ${items || '<p class="empty">Wszystkie odpowiedzi są poprawne.</p>'}`;

  container.querySelectorAll('input[name="summary-filter"]').forEach((r) =>
    r.addEventListener('change', () => onFilter?.(r.value === 'wrong')));
}

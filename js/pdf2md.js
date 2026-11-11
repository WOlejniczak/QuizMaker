// Konwersja PDF -> Markdown w przeglądarce przy pomocy pdf.js.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const BULLET_RE = /^\s*[•●▪◦‣∙·\-–*]\s+/;
const NUMBERED_RE = /^\s*(\d{1,3}|[a-zA-Z])[.)]\s+/;

function fontSize(item) {
  const [, b, , d] = item.transform;
  return Math.hypot(b, d) || item.height || 0;
}

// Grupuje elementy tekstowe strony w linie po współrzędnej Y.
function itemsToLines(items) {
  const lines = [];
  const sorted = items
    .filter((it) => it.str !== undefined)
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], size: fontSize(it), width: it.width }))
    .sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));

  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, it.size * 0.4)) {
      last.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  return lines
    .map((line) => {
      line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const it of line.items) {
        if (prevEnd !== null && it.x - prevEnd > it.size * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) {
          text += ' ';
        }
        text += it.str;
        prevEnd = it.x + (it.width || 0);
      }
      const size = Math.max(...line.items.map((i) => i.size));
      return { y: line.y, text: text.replace(/\s+/g, ' ').trim(), size };
    })
    .filter((l) => l.text.length > 0);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Zamienia linie jednej strony na akapity Markdown.
function linesToMarkdown(lines, bodySize) {
  const out = [];
  let paragraph = [];
  let prevY = null;

  const flush = () => {
    if (paragraph.length) {
      out.push(paragraph.join(' ').replace(/(\p{L})- (\p{Ll})/gu, '$1$2'));
      paragraph = [];
    }
  };

  for (const line of lines) {
    const gap = prevY === null ? 0 : prevY - line.y;
    prevY = line.y;
    const isHeading = bodySize > 0 && line.size >= bodySize * 1.25 && line.text.length < 120;

    if (isHeading) {
      flush();
      out.push(`${line.size >= bodySize * 1.6 ? '##' : '###'} ${line.text}`);
      continue;
    }
    if (BULLET_RE.test(line.text)) {
      flush();
      out.push(`- ${line.text.replace(BULLET_RE, '')}`);
      continue;
    }
    if (NUMBERED_RE.test(line.text)) {
      flush();
      out.push(line.text);
      continue;
    }
    if (gap > line.size * 1.8) flush();
    paragraph.push(line.text);
  }
  flush();
  return out.join('\n\n');
}

/**
 * @param {File} file
 * @param {(done:number,total:number)=>void} onProgress
 * @returns {Promise<{markdown:string,pages:{num:number,text:string}[],numPages:number,charCount:number}>}
 */
export async function pdfToMarkdown(file, onProgress = () => {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const numPages = pdf.numPages;

  const pageLines = [];
  for (let n = 1; n <= numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pageLines.push(itemsToLines(content.items));
    onProgress(n, numPages);
  }

  const bodySize = median(pageLines.flat().map((l) => Math.round(l.size * 10) / 10));
  const pages = [];
  const parts = [`# ${file.name.replace(/\.pdf$/i, '')}`];

  pageLines.forEach((lines, i) => {
    const num = i + 1;
    const text = lines.map((l) => l.text).join('\n');
    pages.push({ num, text });
    parts.push(`<!-- strona: ${num} -->\n\n${linesToMarkdown(lines, bodySize)}`);
  });

  const markdown = parts.join('\n\n---\n\n');
  const charCount = pages.reduce((sum, p) => sum + p.text.length, 0);
  return { markdown, pages, numPages, charCount };
}

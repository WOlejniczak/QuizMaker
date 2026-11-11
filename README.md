# Quiz Maker z PDF

Statyczna strona (HTML/CSS/JS, bez builda). Robi z pliku PDF quiz ABCD przy pomocy AI – **Gemini** (darmowy klucz)
albo **Claude** (płatny klucz Anthropic).

## Jak działa
1. Wgrywasz PDF – w przeglądarce (pdf.js) zamienia się na Markdown z oznaczeniem stron (`<!-- strona: N -->`). Plik `.md` można pobrać.
2. AI ocenia, czy dokument nadaje się na quiz, i podaje szacowaną liczbę pytań.
3. *(opcjonalnie)* Wgrywasz **własną bazę pytań** – plik PDF/TXT/MD/CSV/JSON albo wklejony tekst.
   Pytania mogą mieć warianty i zaznaczone odpowiedzi, ale nie muszą. AI:
   - wyodrębnia każde pytanie, zachowując jego treść,
   - uzupełnia brakujące warianty / poprawną odpowiedź na podstawie materiału źródłowego,
   - sprawdza zaznaczoną odpowiedź z materiałem i zgłasza rozbieżność („W Twojej bazie zaznaczono…”),
   - znajduje cytat i stronę w materiale źródłowym (lub oznacza, że materiał nie obejmuje pytania).
   Duże bazy są dzielone na części (po ~20 tys. znaków) – każda część to osobne zapytanie.
   Do wyboru: **Moje + AI**, **Tylko moje**, **Tylko AI** oraz liczba pytań z każdego źródła.
4. Wybierasz ustawienia (zapisują się w `localStorage`):
   - **Mieszanie pytań** (domyślnie wł.)
   - **Mieszanie odpowiedzi** (domyślnie wł.)
   - **Pytania otwarte** (domyślnie **wył.**)
   - **Tryb oszczędny** (domyślnie wł., patrz niżej)
   - liczba pytań
5. Rozwiązujesz quiz (klawisze `1–4` / `A–D`, `Enter`, strzałki).
6. Podsumowanie: liczba poprawnych i błędnych odpowiedzi, wyjaśnienie, dlaczego odpowiedź była błędna,
   podświetlony fragment z PDF i numer strony. Cytat jest sprawdzany z tekstem PDF – jeśli AI podało
   złą stronę, numer jest poprawiany; jeśli fragmentu nie znaleziono, widnieje oznaczenie „cytat przybliżony”.

## Oszczędzanie tokenów
Najwięcej kosztuje wysłanie całego dokumentu do AI, więc strona robi to jak najrzadziej:

- **Pamięć wyników per plik** (IndexedDB, klucz = SHA-256 zawartości PDF). Zapisywane są: Markdown, ocena dokumentu,
  pula wygenerowanych pytań i przetworzone bazy pytań. Ponowne wgranie tego samego pliku (nawet po zamknięciu
  przeglądarki i pod inną nazwą) nie wysyła żadnego zapytania o rzeczy, które już są zapisane.
- **Pula pytań.** Jedno zapytanie generuje od razu zapas pytań (min. 15, nie więcej niż szacowana liczba sensownych pytań).
  Kolejne quizy biorą najpierw pytania jeszcze niewidziane, potem najrzadziej pokazywane.
- **Tryb oszczędny** (domyślnie wł.): gdy niewidziane pytania się skończą, quiz składa się z powtórek zamiast nowego
  zapytania. Po wyłączeniu – strona dogeneruje tylko brakujące pytania i poprosi AI, by nie powtarzało istniejących.
- **Cache po stronie dostawcy.** Dokument jest zawsze na początku zapytania w identycznej postaci – Gemini może użyć
  automatycznego cache, a dla Claude dokument ma znacznik `cache_control` (kolejne zapytania w ciągu ~5 min są tańsze).
- Gemini 2.5 Flash / Flash-Lite działają bez „myślenia” (thinking), które zużywa dodatkowe tokeny.
- Pod ustawieniami widać, czy następny quiz wyśle zapytanie do AI, a na dole strony – zużycie tokenów w sesji.
- Przycisk „Wyczyść zapisane dane tego pliku” usuwa pamięć dla bieżącego PDF.

## Model AI i klucze
Przycisk modelu w prawym górnym rogu otwiera okno „Model AI”: wybierasz dostawcę (Gemini / Claude) i model z listy
rozwijanej. Po zapisaniu klucza strona **sprawdza połączenie z wybranym modelem** (zapytanie o metadane modelu – nie zużywa
tokenów) i pokazuje wynik w oknie oraz kropką statusu w nagłówku (zielona – połączono, czerwona – błąd lub brak klucza).
Po udanym połączeniu lista uzupełnia się o wszystkie
modele dostępne dla Twojego klucza.

| Dostawca | Klucz | Uwagi |
|---|---|---|
| Gemini | darmowy: <https://aistudio.google.com/apikey> | limity zapytań na minutę/dzień; przy 429 strona odczekuje i ponawia |
| Claude | płatny: <https://console.anthropic.com/settings/keys> | rozliczenie za tokeny; Haiku 5.5 jest najtańszy |

Dla Claude Opus 5.5, Sonnet 5.5 i Fable 5.2 włączony jest serwerowy fallback (`fallbacks: "default"`): jeśli model odmówi
wykonania zadania, zapytanie przejmuje inny model w ramach tego samego wywołania.

**Bezpieczeństwo kluczy:** klucze są przechowywane tylko w przeglądarce (localStorage) i wysyłane bezpośrednio do
Google / Anthropic. **Nie umieszczaj kluczy w repozytorium ani w plikach strony** (także przez GitHub Secrets wstrzykiwane
przy deployu) – GitHub Pages serwuje pliki publicznie, więc każdy odwiedzający mógłby odczytać klucz i używać go na Twój koszt.
Klucze Anthropic znalezione w publicznym repozytorium są dodatkowo automatycznie unieważniane.

W darmowym planie Gemini Google może wykorzystywać przesłane treści do ulepszania modeli – nie wrzucaj poufnych dokumentów.

## Uruchomienie lokalne
Moduły ES nie działają z `file://`, więc potrzebny jest prosty serwer:

```bash
python -m http.server 8000
# lub
npx serve .
```
i otwórz <http://localhost:8000>.

## GitHub Pages
1. Utwórz repozytorium i wypchnij pliki (`index.html`, `css/`, `js/`, `.nojekyll`).
2. *Settings → Pages → Build and deployment → Deploy from a branch* → `main` / `(root)`.
3. Strona będzie dostępna pod `https://<użytkownik>.github.io/<repo>/`.

## Struktura
| Plik | Rola |
|---|---|
| `js/pdf2md.js` | PDF → Markdown (pdf.js) |
| `js/ai.js` | prompty, schematy odpowiedzi, lista dostawców i modeli |
| `js/providers/gemini.js` | wywołania Gemini API (REST) |
| `js/providers/claude.js` | wywołania Claude API (oficjalne SDK `@anthropic-ai/sdk` z CDN) |
| `js/providers/common.js` | wspólne błędy, konwersja schematu JSON dla Gemini |
| `js/db.js` | pamięć wyników per plik (IndexedDB) |
| `js/quiz.js` | tasowanie, weryfikacja cytatów, wynik |
| `js/summary.js` | widok podsumowania |
| `js/settings.js` | ustawienia, dostawca, modele i klucze (localStorage) |
| `js/app.js` | ekrany i obsługa UI |

## Ograniczenia
- PDF-y bez warstwy tekstowej (skany) nie są obsługiwane.

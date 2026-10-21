# SymulTube 🎬

Aplikacja webowa do **wspólnego, zsynchronizowanego oglądania YouTube**.

- **Host** wybiera film i steruje odtwarzaniem/pauzą — widzowie są synchronizowani automatycznie.
- **Jeden link** dla wszystkich — kto go kliknie, dołącza sam. **Zero kodów do przepisywania.**
- **Multi-user**: jeden host, wielu widzów (topologia gwiazdy).
- Wideo i sterowanie lecą **peer-to-peer** (WebRTC). Mały **relay** służy tylko do „przedstawienia" peerów przy łączeniu — nie przechodzą przez niego żadne dane wideo.

## Architektura

```
Przeglądarki (host + widzowie)  ──►  GitHub Pages (statyczne pliki)
        │
        │  tylko nawiązanie połączenia (offer/answer)
        ▼
   Twój relay na Deno Deploy  ("skrytka na klucz")
        │
        ▼
  Połączenie P2P (WebRTC) ── wideo/sterowanie lecą bezpośrednio między przeglądarkami
```

## Krok 1 — postaw relay (Twoją „skrytkę") na Deno Deploy

Relay to malutki program, który pozwala hostowi i widzom znaleźć się nawzajem. Jest darmowy i bezobsługowy.

1. Wejdź na **[dash.deno.com](https://dash.deno.com)** i zaloguj się przez GitHub.
2. Kliknij **New Playground** (albo **New Project → Playground**).
3. Usuń przykładowy kod i wklej całą zawartość pliku [`relay/main.ts`](relay/main.ts) z tego repo.
4. Kliknij **Save & Deploy**.
5. Skopiuj adres projektu, np. `https://twoj-projekt.deno.dev`.

Szybki test: wejdź na adres relaya w przeglądarce — powinno pokazać „SymulTube relay działa ✓".

### A co z bazą KV?

Relay działa **od razu, bez żadnej bazy** — jeśli KV nie jest podłączone, używa pamięci RAM. Dla oglądania we dwójkę / w małej grupie to w zupełności wystarcza (dane łączenia żyją tylko kilka sekund).

**Opcjonalnie, dla maksymalnej niezawodności** (gdy host i widz są w odległych regionach świata), podłącz darmowe Deno KV:
- W dashboardzie projektu: zakładka **KV** (lub **Databases**) → **Create / Attach database** → wybierz świeżo utworzoną → **Redeploy**.
- Relay sam wykryje KV i go użyje (zobaczysz w logach „używam Deno KV").

## Krok 2 — wpisz adres relaya w aplikacji

W pliku `app.js`, na górze, ustaw stałą:

```js
const RELAY_DEFAULT = "https://twoj-projekt.deno.dev";
```

(Na czas testów możesz też wpisać adres w aplikacji — na ekranie „Skonfiguruj relay" — zapamięta się w przeglądarce. Ale do publikacji wpisz go w `app.js`, żeby widzowie też go mieli.)

## Krok 3 — opublikuj frontend na GitHub Pages

```bash
git init
git add .
git commit -m "SymulTube"
git branch -M main
git remote add origin https://github.com/<twoj-login>/<repo>.git
git push -u origin main
```

Następnie w repo: **Settings → Pages → Source: Deploy from a branch → `main` / `root` → Save**.
Strona pojawi się pod `https://<twoj-login>.github.io/<repo>/`.

> ⚠️ GitHub Pages serwuje po HTTPS — ważne, bo WebRTC i YouTube wymagają bezpiecznego połączenia (lokalnie testuj przez `localhost`, nie `file://`).

## Jak się używa

Host: „Jestem hostem" → wkleja link do filmu → **Utwórz pokój**. Są **dwie metody** zapraszania (możesz ich używać jednocześnie):

**✅ Łatwy sposób (przez relay):** host kopiuje **jeden link** i rozsyła. Każdy, kto kliknie, dołącza automatycznie — bez kodów.

**🛟 Awaryjnie (przez kod, zawsze działa):** gdyby relay (Deno) zawodził, host klika **„+ Nowy link awaryjny"** — dostaje osobny link dla widza. Widz klika go, dostaje **krótki kod zwrotny**, odsyła go hostowi, host wkleja w kartę i **Połącz**. Działa bez relaya (ręczna wymiana, kompresja gzip). Gdy relay nie odpowiada, host zobaczy stosowną podpowiedź.

W obu przypadkach host steruje odtwarzaniem, a komendy lecą do wszystkich widzów (niezależnie od metody połączenia).

Co 2 s host wysyła sygnał synchronizujący pozycję (tolerancja ~1 s). Widz ma własny pasek postępu z czasem (natywny pasek YT jest u niego zablokowany). Są też: tryb kinowy (`t`), pełny ekran (`f`), a u hosta spacja = play/pauza.

## Blokowanie reklam

Nie da się wstrzyknąć własnego adblocka do `<iframe>` YouTube (polityka same-origin). Zamiast tego zainstaluj **[uBlock Origin](https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm)** lub inny adblock z Chrome Web Store — działa na poziomie przeglądarki i blokuje reklamy także w osadzonym playerze.

## Testowanie lokalne

`file://` nie zadziała (potrzebny `localhost`):

```bash
python -m http.server 8000
# otwórz http://localhost:8000
```

Relay możesz odpalić lokalnie (jeśli masz Deno): `deno run -A --unstable-kv relay/main.ts`, albo po prostu użyć wersji z Deno Deploy. Adres relaya ustaw na ekranie „Skonfiguruj relay". Testuj w dwóch oknach (jedno zwykłe = host, drugie incognito z linkiem = widz).

## Pliki

| Plik            | Rola                                        |
|-----------------|---------------------------------------------|
| `index.html`    | struktura strony                            |
| `style.css`     | wygląd                                       |
| `app.js`        | logika: WebRTC + relay + YouTube IFrame API |
| `relay/main.ts` | relay sygnalizacyjny (Deno Deploy)          |

## Ograniczenia

- Host musi mieć otwartą kartę przez cały seans (jest „centralą" P2P).
- Przy bardzo restrykcyjnym NAT (tzw. symmetric NAT) samo STUN może nie wystarczyć. Wtedy potrzebny byłby serwer TURN.
- Synchronizacja jest „na oko" dokładna (~1 s) — dla zwykłego oglądania w zupełności wystarcza.

# SymulTube 🎬

Prosta aplikacja webowa do **wspólnego, zsynchronizowanego oglądania YouTube** przez dwie (lub więcej) osoby.

- **Host** wkleja link do filmu → dostaje link do wysłania znajomym.
- **Host** steruje odtwarzaniem i pauzą — reszta widzów jest synchronizowana automatycznie.
- Działa **peer-to-peer** (PeerJS), więc **nie wymaga własnego backendu** i można to postawić na GitHub Pages.

## Jak to działa

1. Host otwiera stronę, wkleja link do filmu i klika **„Utwórz pokój"**.
2. Strona generuje link typu `.../index.html?room=XXXX`.
3. Widzowie otwierają ten link, klikają **„Dołącz i oglądaj"** i łączą się bezpośrednio z hostem.
4. Host steruje playerem (play/pause/przewijanie), a komendy lecą do widzów. Dodatkowo co 2 s wysyłany jest sygnał synchronizujący pozycję, żeby nikt nie „odjechał".

> Host musi mieć otwartą kartę przez cały seans — to on jest „serwerem" połączenia P2P.

## Blokowanie reklam

Nie da się wstrzyknąć własnego adblocka do `<iframe>` YouTube (polityka same-origin przeglądarki). Zamiast tego:

- Zainstaluj **[uBlock Origin](https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm)** lub inny adblock z Chrome Web Store — działa na poziomie przeglądarki i blokuje reklamy także w osadzonym playerze.
- Strona używa trybu prywatności **`youtube-nocookie.com`**.

## Publikacja na GitHub Pages

```bash
git init
git add .
git commit -m "SymulTube"
git branch -M main
git remote add origin https://github.com/<twoj-login>/<repo>.git
git push -u origin main
```

Następnie w repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `root` → Save**.

Po chwili strona będzie pod `https://<twoj-login>.github.io/<repo>/`.

> ⚠️ GitHub Pages serwuje po HTTPS — to ważne, bo zarówno PeerJS, jak i YouTube wymagają bezpiecznego połączenia (lokalnie testuj przez `localhost`, nie `file://`).

## Testowanie lokalne

`file://` nie zadziała (potrzebny `localhost`). Odpal mini-serwer:

```bash
python -m http.server 8000
# otwórz http://localhost:8000
```

Najwygodniej testować dwa „końce" w dwóch kartach/przeglądarkach albo na dwóch urządzeniach.

## Pliki

| Plik         | Rola                                   |
|--------------|----------------------------------------|
| `index.html` | struktura strony                       |
| `style.css`  | wygląd                                 |
| `app.js`     | logika: PeerJS + YouTube IFrame API    |

## Ograniczenia

- Publiczny serwer sygnalizacyjny PeerJS bywa czasem przeciążony. Dla produkcji warto postawić własny `PeerServer` (to ten „mały backend", jeśli kiedyś będzie potrzebny).
- Synchronizacja jest „na oko" dokładna (tolerancja ~1 s) — dla zwykłego oglądania w zupełności wystarcza.

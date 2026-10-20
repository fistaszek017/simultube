# SymulTube 🎬

Prosta aplikacja webowa do **wspólnego, zsynchronizowanego oglądania YouTube** przez dwie (lub więcej) osoby.

- **Host** wybiera film i steruje odtwarzaniem/pauzą — widz jest synchronizowany automatycznie.
- Działa **peer-to-peer** (czysty WebRTC) z **ręczną sygnalizacją** (wymiana dwóch kodów), więc **nie wymaga żadnego serwera, backendu ani kont**.
- Jedyna rzecz „z zewnątrz" to darmowe publiczne serwery **STUN** (potrzebne do wykrycia adresu w internecie) — nie przechodzą przez nie żadne dane wideo ani sterowania.

## Jak to działa

1. **Host** wybiera „Jestem hostem", wkleja link do filmu i klika **„Generuj kod zaproszenia"**.
2. Host kopiuje **kod zaproszenia** i wysyła go znajomemu (Discord, Messenger, cokolwiek).
3. **Widz** wybiera „Dołączam", wkleja kod zaproszenia i klika **„Generuj kod odpowiedzi"**.
4. Widz kopiuje swój **kod odpowiedzi** i odsyła go hostowi.
5. Host wkleja kod odpowiedzi i klika **„Połącz"** → gotowe, połączenie bezpośrednie P2P.

Od tej chwili host steruje playerem (play/pause/przewijanie), a komendy lecą prosto do widza. Dodatkowo co 2 s wysyłany jest sygnał synchronizujący pozycję (tolerancja ~1 s), żeby nikt nie „odjechał".

> Wymianę kodów robi się tylko raz, przy zestawianiu połączenia. To cena za brak jakiegokolwiek serwera.

## Blokowanie reklam

Nie da się wstrzyknąć własnego adblocka do `<iframe>` YouTube (polityka same-origin przeglądarki). Zamiast tego:

- Zainstaluj **[uBlock Origin](https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm)** lub inny adblock z Chrome Web Store — działa na poziomie przeglądarki i blokuje reklamy także w osadzonym playerze.

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

> ⚠️ GitHub Pages serwuje po HTTPS — to ważne, bo zarówno WebRTC, jak i YouTube wymagają bezpiecznego połączenia (lokalnie testuj przez `localhost`, nie `file://`).

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

- Połączenie jest **1:1** (host ↔ jeden widz) — dokładnie „dwie osoby". Więcej widzów wymagałoby powtórzenia wymiany kodów z każdym z osobna.
- Przy bardzo restrykcyjnym NAT (tzw. symmetric NAT) samo STUN może nie wystarczyć do zestawienia bezpośredniego połączenia. Wtedy potrzebny byłby serwer TURN (jedyny przypadek, gdy przydałby się „ktoś z zewnątrz").
- Synchronizacja jest „na oko" dokładna (tolerancja ~1 s) — dla zwykłego oglądania w zupełności wystarcza.

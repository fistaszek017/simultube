# SymulTube 🎬

Prosta aplikacja webowa do **wspólnego, zsynchronizowanego oglądania YouTube** przez dwie (lub więcej) osoby.

- **Host** wybiera film i steruje odtwarzaniem/pauzą — widzowie są synchronizowani automatycznie.
- Działa **peer-to-peer** (czysty WebRTC) z **ręczną sygnalizacją**, więc **nie wymaga żadnego serwera, backendu ani kont**.
- **Multi-user**: jeden host, wielu widzów (topologia gwiazdy — host trzyma osobne połączenie z każdym).
- Jedyna rzecz „z zewnątrz" to darmowe publiczne serwery **STUN** (do wykrycia adresu w internecie) — nie przechodzą przez nie żadne dane wideo ani sterowania.

## Jak to działa

1. **Host** wybiera „Jestem hostem", wkleja link do filmu i klika **„Utwórz pokój"**.
2. Dla każdego widza host dostaje **spersonalizowany link zaproszenia** (`...#join=...`) — kopiuje go i wysyła (przycisk „+ Nowy link zaproszenia" dodaje kolejnych widzów).
3. **Widz** klika link → strona sama otwiera tryb dołączania → klika **„Generuj kod zwrotny"**.
4. Widz kopiuje swój **krótki kod zwrotny** (skompresowany gzip) i odsyła go hostowi.
5. Host wkleja kod zwrotny w kartę danego widza i klika **„Połącz"** → gotowe, połączenie bezpośrednie P2P.

Od tej chwili host steruje playerem (play/pause/przewijanie), a komendy lecą prosto do wszystkich widzów. Dodatkowo co 2 s idzie sygnał synchronizujący pozycję (tolerancja ~1 s). Widz ma własny pasek postępu z czasem (natywny pasek YT jest u niego zablokowany).

### Dlaczego jest kod zwrotny, a nie np. 6 cyfr?

WebRTC wymaga dwustronnej wymiany opisów połączenia (offer ↔ answer). Kod zwrotny niesie realne dane (odcisk DTLS, ice-ufrag/pwd, kandydatów ICE) — kilkaset bajtów, nie da się ich upchnąć w 6 cyfr bez „skrzynki" w chmurze (czyli serwera). Dlatego kod jest skompresowany, ale musi zostać. Jedyny sposób, by zniknął całkowicie, to dodanie lekkiego serwera sygnalizacyjnego.

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

- Każdy widz to osobny handshake (link + kod zwrotny). Dla kilku osób jest OK, ale im więcej widzów, tym więcej ręcznej wymiany po stronie hosta.
- Przy bardzo restrykcyjnym NAT (tzw. symmetric NAT) samo STUN może nie wystarczyć do zestawienia bezpośredniego połączenia. Wtedy potrzebny byłby serwer TURN (jedyny przypadek, gdy przydałby się „ktoś z zewnątrz").
- Synchronizacja jest „na oko" dokładna (tolerancja ~1 s) — dla zwykłego oglądania w zupełności wystarcza.

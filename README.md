# 🎬 SymulTube

**SymulTube** to lekka aplikacja webowa typu *watch-party*, umożliwiająca zsynchronizowane oglądanie filmów z serwisu YouTube ze znajomymi w czasie rzeczywistym.

🔗 **Aplikacja dostępna na żywo:** [fistaszek017.github.io/simultube](https://fistaszek017.github.io/simultube/)

## 🌐 Dlaczego Peer-to-Peer (WebRTC)?

W przeciwieństwie do klasycznych platform do wspólnego oglądania, **SymulTube** nie przepuszcza ruchu przez centralny serwer. Cała komunikacja między uczestnikami seansu odbywa się bezpośrednio w modelu **Peer-to-Peer (P2P)** w topologii gwiazdy (jeden host połączony bezpośrednio z wieloma widzami):

* **Minimalne opóźnienia:** Sygnały sterujące (`play`, `pause`, pozycja czasowa) trafiają prosto z przeglądarki hosta do przeglądarek widzów przez **WebRTC DataChannels**.
* **Pełna prywatność:** Żadne dane o tym, co i z kim oglądasz, nie są logowane ani przechowywane na zewnętrznych serwerach.
* **Niezależność i odporność:** Po nawiązaniu połączenia sesja działa całkowicie autonomicznie między uczestnikami. Nawet gdyby serwer ułatwiający łączenie przestał odpowiadać, trwający seans nie zostanie przerwany.

## 🔀 Dwa tryby nawiązywania połączenia

Aby połączyć dwie przeglądarki w sieci P2P, muszą one na samym początku wymienić się swoimi adresami sieciowymi (tzw. sygnalizacja WebRTC). SymulTube oferuje na to **dwa sposoby** (można ich używać jednocześnie w ramach jednego pokoju):

1. **⚡ Tryb automatyczny (z lekkim backendem sygnalizacyjnym):**
   * Host generuje **jeden wspólny link** dla wszystkich.
   * Gdy widz go otwiera, jego przeglądarka automatycznie zostawia „wizytówkę” (WebRTC Offer) w lekkim pośredniku sygnalizacyjnym (kod w folderze `relay/`), a przeglądarka hosta sama ją odbiera i odsyła odpowiedź.
   * Połączenie P2P zestawia się w tle w 1–2 sekundy – bez żadnej ingerencji użytkownika i bez przepisywania kodów. Po zestawieniu połączenia backend nie bierze już udziału w transmisji.
2. **🛟 Tryb awaryjny / bezserwerowy (przez wymianę tokenów):**
   * Całkowicie niezależny od jakiegokolwiek serwera – działa nawet wtedy, gdy backend jest offline.
   * Host generuje indywidualny link zawierający skompresowany token połączenia (`Gzip + Base64URL`). Widz po jego otwarciu otrzymuje krótki **token zwrotny**, który odsyła hostowi (np. na Discordzie czy Messengerze), a host wkleja go w aplikacji, zamykając uścisk dłoni WebRTC.

## ✨ Główne funkcje

* **Jeden link dla wszystkich:** Host tworzy pokój i wysyła jeden prosty adres URL – widzowie dołączają automatycznie jednym kliknięciem.
* **Pełna synchronizacja:** Każda akcja hosta (start, pauza, przewinięcie) jest natychmiast odwzorowywana u widzów, a cykliczny sygnał kontrolny pilnuje, aby nikt nie rozjechał się w czasie (tolerancja ~1 s).
* **Dedykowany tryb widza:** Widzowie mają zablokowaną możliwość przypadkowego zatrzymania lub przewinięcia filmu, ale zachowują pełną swobodę w kwestii głośności, trybu kinowego oraz pełnego ekranu.
* **Zero instalacji i brak zależności:** Czysty HTML, CSS i Vanilla JS oparty na oficjalnym YouTube IFrame Player API.

## 🎮 Jak korzystać?

### 1. Jako Host (organizator seansu)

1. Wejdź na [fistaszek017.github.io/simultube](https://fistaszek017.github.io/simultube/) i wybierz **Jestem hostem**.
2. Wklej link do filmu z YouTube (obsługiwane są zwykłe linki, `youtu.be`, `shorts` oraz samo 11-znakowe ID filmu) i kliknij **Utwórz pokój**.
3. Skopiuj główny link z sekcji **Łatwy sposób — jeden link** i wyślij go znajomym.
4. *(Opcjonalnie)* Jeśli chcesz zaprosić kogoś w trybie bezserwerowym, rozwiń sekcję **Awaryjnie — przez kod dwukierunkowy**, wygeneruj link dla widza i wklej odesłany przez niego token zwrotny.

### 2. Jako Widz

1. Kliknij link otrzymany od hosta (jeśli to link awaryjny z tokenem, skopiuj wygenerowany kod zwrotny i odeślij go hostowi).
2. Po nawiązaniu połączenia kliknij **🔊 Włącz dźwięk** (przeglądarki ze względów bezpieczeństwa wyciszają autoodtwarzane wideo).

### Skróty klawiszowe

| Klawisz | Akcja | Dostępność |
| :--- | :--- | :--- |
| `Spacja` | Odtwarzanie / Pauza | Tylko Host |
| `T` | Tryb kinowy (Theater Mode) | Host i Widz |
| `F` | Pełny ekran | Host i Widz |

## 📁 Struktura projektu

```text
├── index.html      # Struktura interfejsu (ekrany ról, odtwarzacz, pasek postępu widza)
├── style.css       # Stylowanie (Dark Mode, responsywność, tryb kinowy i pełnoekranowy)
├── app.js          # Logika P2P (WebRTC, kompresja tokenów Gzip, YouTube IFrame API)
├── relay/          # Kod lekkiego pośrednika sygnalizacyjnego (Deno) do trybu automatycznego
└── README.md       # Dokumentacja projektu
```

## 💻 Uruchomienie lokalne

Jeśli chcesz przetestować zmiany w kodzie lokalnie, uruchom prosty serwer HTTP w katalogu głównym (protokół `file://` jest blokowany przez WebRTC i YouTube API):

```bash
python -m http.server 8000
# Następnie otwórz http://localhost:8000 w dwóch oknach (np. zwykłym i Incognito)
```

## 💡 Warto wiedzieć

* **Karta hosta:** Host pełni rolę centrali P2P, dlatego jego karta z aplikacją musi pozostać otwarta przez cały czas trwania seansu.
* **Restrykcyjne sieci:** Połączenia P2P wykorzystują publiczne serwery STUN do odnajdywania adresów sieciowych. W rzadkich przypadkach bardzo restrykcyjnych zapór (np. niektóre sieci korporacyjne lub podwójny NAT w sieciach komórkowych) bezpośrednie połączenie może być blokowane przez sieć.
* **Reklamy na YouTube:** Ze względu na zabezpieczenia przeglądarek (*Same-Origin Policy*), aplikacja nie może ingerować w zawartość odtwarzacza YouTube. Aby oglądać bez przerw, warto zainstalować rozszerzenie blokujące reklamy (np. uBlock Origin).
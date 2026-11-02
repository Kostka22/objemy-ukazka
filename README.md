# Databáza objemov – statická ukážka

Statická verzia webovej aplikácie **Objemy**: beží celá v prehliadači nad kópiou dát (`data.json`),
bez servera a databázy. Funguje mapa, legenda a zapínanie, klik do mapy, hľadanie, detail s kolíziami,
**výrez** (posun, otočenie, zmena veľkosti, náhľad, export DXF / GeoJSON / CSV), **nahratie DXF**
s kontrolou kolízií a **bilancia**. Neukladá sa nič (ukladanie a import sú v plnej verzii).

> Dáta sú **vymyslené skúšobné dáta**. Skutočné projektové dáta na verejnú stránku nedávajte.

## Zverejnenie na GitHub Pages

1. Prihláste sa na <https://github.com> (alebo si vytvorte účet).
2. **New repository** → názov napr. `objemy-ukazka` → *Public* → **Create repository**.
3. **uploading an existing file** → pretiahnite **obsah** tohto priečinka (index.html, style.css, app.js,
   demo-api.js, data.json, priečinok samples) → **Commit changes**.
4. **Settings → Pages** → *Source: Deploy from a branch* → *Branch: main*, priečinok */ (root)* → **Save**.
5. O 1–2 minúty je stránka na `https://<vas-ucet>.github.io/objemy-ukazka/`.

## Aktualizácia dát

V priečinku projektu spustite `.venv\Scripts\python scripts\build_static_demo.py` a na GitHub
nahrajte nový `data.json` (Add file → Upload files, prepíše starý).

`page.html` je tá istá stránka vo forme pre zverejnenie na claude.ai (na GitHub ju nahrávať netreba).

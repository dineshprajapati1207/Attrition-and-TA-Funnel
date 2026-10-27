# Attrition + TA Dashboard

Live HR dashboard for attrition and talent-acquisition (TA) funnel, read straight from two Google Sheets through a Google service account.

- **Attrition tabs:** Overview, Function / Sub-Function, BU, Grade & Zone, Exit Reasons, Tenure & Recruiter
- **TA Funnel tab:** sourced → screened → shortlisted → interview rounds → offered → joined, by recruiter, department, month, source and more
- Click any number to see the employee list behind it; export any view to Excel
- Light / dark theme (light by default)

## How it works

```
Google Sheets ──(service account, every 30 s)──▶ server.js (cache in memory) ──▶ public/index.html (checks every 30 s)
```

`server.js` is a small Node server with **no npm dependencies**. It signs in as the service account, reads every visible tab of both sheets in the background and keeps them in memory, so the page always loads instantly. The page redraws only when the sheet data has actually changed.

| Sheet | ID | Used for |
|---|---|---|
| Attrition (employee master) | `1jT8Lo0SAdCnkhbg6oeqi-bVOIhEAIO1wrt2P1nakhwI` | all attrition tabs (tab with a "Date Of Joining" column) |
| TA Funnel | `1JELHBP1rJym7rxwgDGLzN45GzgULmrHZ15JhijXWtu8` | TA Funnel tab (one tab per recruiter, with "TA Name" and "Candidate Name" columns) |

Hidden tabs are skipped. New recruiter tabs are picked up automatically.

## Run locally

Requires Node.js 18 or newer.

1. **Service account:** in Google Cloud, enable the **Google Sheets API** for the service account's project and download its JSON key.
2. **Share** both sheets with the service account's `client_email` as **Viewer**.
3. Save the key in this folder as `service-account.json` (it is git-ignored).
4. Optional: `cp .env.example .env` and adjust settings.
5. Start:
   ```bash
   npm start
   ```
6. Open http://localhost:3000

## Settings

Set as environment variables or in `.env` (see `.env.example`).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | use `0.0.0.0` when hosting |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./service-account.json` | path to the key file |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | – | the key's full JSON as one string; preferred on hosting platforms |
| `ATTRITION_SHEET_ID` / `TA_SHEET_ID` | IDs above | |
| `CACHE_SECONDS` | `30` | how often the sheets are re-read |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/sheet/attrition` | all visible tabs of the attrition sheet as JSON (`?fresh=1` re-reads if older than 10 s) |
| `GET /api/sheet/ta` | same for the TA Funnel sheet |
| `GET /api/health` | `{ ok: true }` |

Only the two configured sheets can be read through the API.

## Project structure

```
├── server.js            # Google auth, background sync, API, static files
├── public/
│   ├── index.html       # the dashboard (HTML, CSS, JS in one file)
│   ├── favicon-32.png
│   ├── favicon-256.png
│   └── apple-touch-icon.png
├── .env.example         # settings template
├── package.json
└── README.md
```

## Security

- Never commit `service-account.json` or `.env`; both are in `.gitignore`.
- The service account only needs **Viewer** access to the two sheets.
- If a key is ever exposed, delete it in Google Cloud (IAM → Service accounts → Keys) and create a new one.

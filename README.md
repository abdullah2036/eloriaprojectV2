# Eloria Story v2 — full-stack edition

The second version of [Eloria Story](https://github.com/abdullah2036/eloriaproject), a self-publishing site for an Arabic novelist. v1 kept everything in a JSON file committed through the GitHub API. **v2 keeps the same reading experience but moves it onto a real backend:** Postgres, authentication, file storage and row-level security on Supabase, plus email notifications for readers.

**Live:** https://abdullah2036.github.io/eloriaprojectV2/

![Library](docs/screenshots/library.jpg)

## What changed from v1

| | v1 (static) | v2 (this repo) |
|---|---|---|
| Content | `data.json` in the repo | Postgres tables on Supabase |
| Author login | password in the page | Supabase Auth (email + password, password reset) |
| Who can write | anyone holding a GitHub token | **Row-Level Security**: only users listed in `admins` |
| Covers | base64 inside the JSON | Supabase Storage bucket |
| Publishing | commit → GitHub Pages rebuild | writes go live instantly |
| Reader sign-up | a `mailto:` request to the author | subscribe in-page, author approves, readers get emailed about new chapters |

No secret lives in the front end. The Supabase URL and publishable (anon) key are public by design, and the database's RLS policies decide who can write.

## Features

**Readers**
- Library with tags, novel pages (synopsis, status, chapters, characters), quotes and an about page
- Reader with font-size controls, a reading-progress bar and chapter navigation
- **Subscribe** with name and email to get notified when a new chapter or novel is published

**Author**
- Sign in, edit everything in place, and sync to the database. Edits are debounced, rows removed in the editor are deleted server-side, and covers are uploaded to Storage
- **Subscriber inbox:** approve, deactivate or delete subscription requests
- **📢 Notify readers:** pick new chapters/novels and send an announcement email through a Google Apps Script endpoint. Already-announced items are remembered, so nothing is sent twice
- Export / import a full JSON backup

## Screenshots

| Home | Subscribe to new chapters |
|---|---|
| ![Home](docs/screenshots/home.jpg) | ![Subscribe](docs/screenshots/subscribe.jpg) |

## Architecture

```
 Browser (index.html · app.js · style.css)
    │  supabase-js
    ├──▶ Supabase Auth      author sign-in, password reset
    ├──▶ Postgres + RLS     novels · chapters · quotes · site · admins · subscribers
    ├──▶ Storage            covers/
    └──▶ Google Apps Script (/exec)  sends notification emails to subscribers
```

## Run your own copy

1. Create a project on [Supabase](https://supabase.com) with the tables above, a public `covers` storage bucket, and RLS policies that allow public reads and restrict writes to rows in `admins`. Add your auth user's id to `admins`.
2. Put your project URL and publishable key at the top of `app.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
3. (Optional) Deploy a Google Apps Script web app for emails and paste its `/exec` URL into `NOTIFY_ENDPOINT` in `app.js`.
4. Serve the folder:
   ```bash
   python -m http.server 8000     # then open http://localhost:8000
   ```

## Project structure

```
eloriaprojectV2/
├── index.html    views (home, library, novel, reader, quotes, about) and dialogs
│                 (login, editors, subscribers, notify)
├── style.css     theme, typography, reader, responsive layout
└── app.js        Supabase client, load + local cache, sync (upsert / delete-missing),
                  storage uploads, auth + admin check, subscribers, notifications, router
```

## Tech stack

HTML, CSS, vanilla JavaScript · Supabase (Postgres, Auth, Storage, RLS) · Google Apps Script · GitHub Pages

---

Built by **Abdullah Bokhary** · [Portfolio](https://abdullah.pageui.workers.dev/) · [LinkedIn](https://www.linkedin.com/in/abdullah-bokhary-840315326/) · [GitHub](https://github.com/abdullah2036)

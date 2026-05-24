# Interview Question Generator

A small Next.js App Router application that takes a job title (e.g. "Customer Success Manager") and returns configurable interview questions generated via **Groq** using an OpenAI-compatible Chat Completions API.

Live demo: https://interview-question-generator-38e9.vercel.app/

## Architecture

- **Frontend** — a Next.js App Router page with a client form component (`app/ui/interview-form.js`).
- **Backend** — a Next.js route handler at `app/api/questions/route.js` that holds the API key as an env var and calls Groq.

The API key is never sent to the browser.

## Provider + model

- **Provider:** Groq
- **Model:** `llama-3.3-70b-versatile` by default (override with `GROQ_MODEL`).

## Local development

You need Node.js 20+ and a Groq API key.

```bash
npm install

# required
echo "GROQ_API_KEY=your_key_here" > .env.local

# optional (defaults to llama-3.3-70b-versatile)
# echo "GROQ_MODEL=llama-3.3-70b-versatile" >> .env.local

npm run dev
```

The app will be available at `http://localhost:3000`.

## File layout

```text
.
├── app/
│   ├── api/questions/route.js
│   ├── globals.css
│   ├── layout.js
│   ├── page.js
│   └── ui/interview-form.js
├── package.json
└── package-lock.json
```

## Notes

- Job titles are capped at 120 characters on the server.
- The form supports seniority, focus, and question count controls (count defaults to 3 in the UI).
- The API includes basic in-memory rate limiting, upstream timeout handling, and retry/backoff for Groq requests.
- The model is asked to return **JSON-only** (`response_format: { type: "json_object" }`) to make parsing more reliable.

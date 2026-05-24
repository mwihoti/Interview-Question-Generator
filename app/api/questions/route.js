import { NextResponse } from "next/server";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_TITLE_LENGTH = 120;
const MIN_COUNT = 1;
const MAX_COUNT = 10;

const ALLOWED_LEVELS = new Set(["junior", "mid", "senior"]);
const ALLOWED_FOCUSES = new Set(["mixed", "behavioral", "technical"]);

const GEMINI_TIMEOUT_MS = 12000;
const GEMINI_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const rateLimitStore = new Map();

function buildPrompt({ jobTitle, seniority, focus, count }) {
  const focusInstruction =
    focus === "behavioral"
      ? "All questions must be behavioral."
      : focus === "technical"
        ? "All questions must be technical."
        : "Mix behavioral, technical, and situational questions when appropriate.";

  return [
    "You are an experienced hiring manager.",
    `Generate exactly ${count} thoughtful, role-specific interview questions for the job title below.`,
    "",
    `Job title: ${jobTitle}`,
    `Seniority: ${seniority}`,
    `Focus: ${focus}`,
    "",
    "Guidelines:",
    `- Tailor the difficulty and expectations to a ${seniority}-level candidate.`,
    `- ${focusInstruction}`,
    "- Prefer open-ended questions that elicit detailed answers, not yes/no.",
    "- Avoid duplicate or near-duplicate questions.",
    "- Do not number the questions or add commentary. Return only the JSON.",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now >= entry.resetAt) {
    const next = {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    rateLimitStore.set(key, next);
    return {
      limited: false,
      remaining: RATE_LIMIT_MAX_REQUESTS - next.count,
      resetAt: next.resetAt,
    };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      limited: true,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  entry.count += 1;
  return {
    limited: false,
    remaining: RATE_LIMIT_MAX_REQUESTS - entry.count,
    resetAt: entry.resetAt,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function shouldRetry(response, error) {
  if (error?.name === "AbortError") {
    return true;
  }
  if (error) {
    return true;
  }
  if (!response) {
    return false;
  }
  return response.status === 429 || response.status >= 500;
}

async function callGemini(apiKey, options) {
  const body = {
    contents: [{ parts: [{ text: buildPrompt(options) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          questions: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: ["questions"],
      },
      temperature: 0.7,
    },
  };

  let lastError;

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    let response;

    try {
      response = await fetchWithTimeout(
        `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        GEMINI_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(
          `Gemini API error (${response.status}): ${errorText.slice(0, 300) || "no body"}`,
        );

        if (!shouldRetry(response)) {
          throw error;
        }

        lastError = error;
      } else {
        const payload = await response.json();
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error("Gemini response did not contain any text.");
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("Gemini returned a non-JSON response.");
        }

        const questions = Array.isArray(parsed.questions)
          ? parsed.questions
          : [];

        return questions
          .map((question) => String(question).trim())
          .filter(Boolean)
          .slice(0, options.count);
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetry(response, error) || attempt === GEMINI_MAX_ATTEMPTS) {
        break;
      }
    }

    const backoffMs = 300 * 2 ** (attempt - 1);
    const jitterMs = Math.floor(Math.random() * 150);
    await sleep(backoffMs + jitterMs);
  }

  throw lastError || new Error("Gemini request failed.");
}

function parseCount(value) {
  const count = Number.parseInt(String(value), 10);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return null;
  }
  return count;
}

function parseOptions(body) {
  const jobTitle =
    typeof body?.jobTitle === "string" ? body.jobTitle.trim() : "";
  const seniority =
    typeof body?.seniority === "string"
      ? body.seniority.trim().toLowerCase()
      : "";
  const focus =
    typeof body?.focus === "string" ? body.focus.trim().toLowerCase() : "";
  const count = parseCount(body?.count);

  if (!jobTitle) {
    return { error: "Please provide a job title." };
  }
  if (jobTitle.length > MAX_TITLE_LENGTH) {
    return {
      error: `Job title must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    };
  }
  if (!ALLOWED_LEVELS.has(seniority)) {
    return {
      error: "Please provide a valid seniority: junior, mid, or senior.",
    };
  }
  if (!ALLOWED_FOCUSES.has(focus)) {
    return {
      error: "Please provide a valid focus: mixed, behavioral, or technical.",
    };
  }
  if (count === null) {
    return {
      error: `Question count must be between ${MIN_COUNT} and ${MAX_COUNT}.`,
    };
  }

  return {
    jobTitle,
    seniority,
    focus,
    count,
  };
}

function jsonResponse(body, init) {
  return NextResponse.json(body, init);
}

export async function POST(request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "Server is missing the GEMINI_API_KEY environment variable." },
      { status: 500 },
    );
  }

  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(clientIp);

  if (rateLimit.limited) {
    const response = jsonResponse(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 },
    );
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
    response.headers.set("X-RateLimit-Remaining", "0");
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimit.resetAt / 1000)),
    );
    response.headers.set(
      "Retry-After",
      String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
    );
    return response;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseOptions(body);
  if (parsed.error) {
    const response = jsonResponse({ error: parsed.error }, { status: 400 });
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
    response.headers.set(
      "X-RateLimit-Remaining",
      String(rateLimit.remaining),
    );
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimit.resetAt / 1000)),
    );
    return response;
  }

  try {
    const questions = await callGemini(apiKey, parsed);
    if (questions.length < parsed.count) {
      const response = jsonResponse(
        {
          error: `The model did not return ${parsed.count} questions. Please try again.`,
        },
        { status: 502 },
      );
      response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
      response.headers.set(
        "X-RateLimit-Remaining",
        String(rateLimit.remaining),
      );
      response.headers.set(
        "X-RateLimit-Reset",
        String(Math.ceil(rateLimit.resetAt / 1000)),
      );
      return response;
    }

    const response = jsonResponse({ questions }, { status: 200 });
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
    response.headers.set("X-RateLimit-Remaining", String(rateLimit.remaining));
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimit.resetAt / 1000)),
    );
    return response;
  } catch (error) {
    console.error("Failed to generate questions:", error);
    const response = jsonResponse(
      { error: "Failed to generate questions. Please try again." },
      { status: 502 },
    );
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
    response.headers.set("X-RateLimit-Remaining", String(rateLimit.remaining));
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(rateLimit.resetAt / 1000)),
    );
    return response;
  }
}

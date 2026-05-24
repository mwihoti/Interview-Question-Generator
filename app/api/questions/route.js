import { NextResponse } from "next/server";

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const MAX_TITLE_LENGTH = 120;
const MIN_COUNT = 1;
const MAX_COUNT = 10;

const ALLOWED_LEVELS = new Set(["junior", "mid", "senior"]);
const ALLOWED_FOCUSES = new Set(["mixed", "behavioral", "technical"]);

const GROQ_TIMEOUT_MS = 12000;
const GROQ_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const rateLimitStore = new Map();

// Builds the prompt sent to the model from the validated request options.
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

// Pauses execution between retry attempts to apply exponential backoff.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extracts the best available client IP for in-memory rate limiting.
function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

// Tracks request counts per client and returns the current rate-limit state.
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

// Wraps fetch with an abort timeout so upstream calls do not hang indefinitely.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Runs the fetch with an attached abort signal and always clears the timeout after completion.
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Decides whether an upstream failure should be retried.
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

// Converts a model-returned question value into displayable text when possible.
function normalizeQuestion(question) {
  if (typeof question === "string") {
    return question.trim();
  }

  if (question && typeof question === "object") {
    const candidates = [
      question.question,
      question.text,
      question.content,
      question.prompt,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return "";
}

// Sends the prompt to Groq, retries transient failures, and returns parsed questions.
async function callGroq(apiKey, options) {
  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You generate structured interview questions and must return valid JSON only.",
      },
      {
        role: "user",
        content: buildPrompt(options),
      },
    ],
    response_format: {
      type: "json_object",
    },
    temperature: 0.7,
  };

  let lastError;

  for (let attempt = 1; attempt <= GROQ_MAX_ATTEMPTS; attempt += 1) {
    let response;

    // Attempts the upstream Groq call and captures retryable transport or API failures.
    try {
      response = await fetchWithTimeout(
        GROQ_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        GROQ_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(
          `Groq API error (${response.status}): ${errorText.slice(0, 300) || "no body"}`,
        );

        if (!shouldRetry(response)) {
          throw error;
        }

        lastError = error;
      } else {
        const payload = await response.json();
        const text = payload?.choices?.[0]?.message?.content;
        if (!text) {
          throw new Error("Groq response did not contain any text.");
        }

        let parsed;
        // Parses the model's JSON string response into a JavaScript object.
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("Groq returned a non-JSON response.");
        }

        const questions = Array.isArray(parsed.questions)
          ? parsed.questions
          : [];

        return questions
          .map(normalizeQuestion)
          .filter(Boolean)
          .slice(0, options.count);
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetry(response, error) || attempt === GROQ_MAX_ATTEMPTS) {
        break;
      }
    }

    const backoffMs = 300 * 2 ** (attempt - 1);
    const jitterMs = Math.floor(Math.random() * 150);
    await sleep(backoffMs + jitterMs);
  }

  throw lastError || new Error("Groq request failed.");
}

// Validates and normalizes the requested question count.
function parseCount(value) {
  const count = Number.parseInt(String(value), 10);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return null;
  }
  return count;
}

// Validates the request body and returns normalized options or an error message.
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

// Creates a consistent JSON response object for the API route.
function jsonResponse(body, init) {
  return NextResponse.json(body, init);
}

// Handles POST requests end-to-end: auth, rate limiting, validation, model call, and response shaping.
export async function POST(request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "Server is missing the GROQ_API_KEY environment variable." },
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
  // Parses the incoming request body and rejects malformed JSON payloads early.
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

  // Calls the model after validation and converts upstream failures into a stable API error.
  try {
    const questions = await callGroq(apiKey, parsed);
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

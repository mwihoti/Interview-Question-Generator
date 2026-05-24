"use client";

import { useState } from "react";

const INITIAL_FORM = {
  jobTitle: "Customer Success Manager",
  seniority: "mid",
  focus: "mixed",
};

export default function InterviewForm() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [status, setStatus] = useState("");
  const [questions, setQuestions] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  function updateField(event) {
    const { name, value } = event.target;
    setError("");
    setStatus("");
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const jobTitle = form.jobTitle.trim();
    const count = 3;

    if (!jobTitle) {
      return;
    }

    setError("");
    setQuestions([]);
    setStatus("Generating questions...");
    setIsLoading(true);

    try {
      const response = await fetch("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle,
          seniority: form.seniority,
          focus: form.focus,
          count,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      if (!Array.isArray(data.questions) || data.questions.length === 0) {
        throw new Error("The model returned no questions. Please try again.");
      }

      setQuestions(data.questions);
      setStatus("");
    } catch (submissionError) {
      setError(
        submissionError.message || "Something went wrong. Please try again.",
      );
      setStatus("");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit}>
        <label htmlFor="jobTitle">Job title</label>
        <input
          id="jobTitle"
          name="jobTitle"
          type="text"
          value={form.jobTitle}
          onChange={updateField}
          autoComplete="off"
          required
          maxLength={120}
          disabled={isLoading}
        />

        <div className="grid">
          <div>
            <label htmlFor="seniority">Seniority</label>
            <select
              id="seniority"
              name="seniority"
              value={form.seniority}
              onChange={updateField}
              disabled={isLoading}
            >
              <option value="junior">Junior</option>
              <option value="mid">Mid</option>
              <option value="senior">Senior</option>
            </select>
          </div>

          <div>
            <label htmlFor="focus">Focus</label>
            <select
              id="focus"
              name="focus"
              value={form.focus}
              onChange={updateField}
              disabled={isLoading}
            >
              <option value="mixed">Mixed</option>
              <option value="behavioral">Behavioral</option>
              <option value="technical">Technical</option>
            </select>
          </div>
        </div>

        <button type="submit" disabled={isLoading}>
          {isLoading ? "Generating..." : "Generate questions"}
        </button>
      </form>

      <div
        className={status ? "loading status" : "status"}
        role="status"
        aria-live="polite"
      >
        {status}
      </div>

      <ol className="results" aria-live="polite">
        {questions.map((question) => (
          <li key={question}>{question}</li>
        ))}
      </ol>

      <div className="error" role="alert">
        {error}
      </div>
    </>
  );
}

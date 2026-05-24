import InterviewForm from "./ui/interview-form";

export default function HomePage() {
  return (
    <main>
      <h1>Interview Question Generator</h1>
      <p className="subtitle">Enter a job title and tune the interview style.</p>
      <InterviewForm />
    </main>
  );
}

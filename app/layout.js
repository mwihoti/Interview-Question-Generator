export const metadata = {
  title: "Interview Question Generator",
  description:
    "Generate role-specific interview questions with configurable seniority, focus.",
};

import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

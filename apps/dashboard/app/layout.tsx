import type { Metadata, Viewport } from "next";
import Rail from "./rail";
import "./globals.css";

export const metadata: Metadata = {
  title: "SREctl console",
  description: "Autonomous code review and reliability agent",
};

/** Stops mobile browsers painting a light chrome above a black page. */
export const viewport: Viewport = {
  themeColor: "#07090d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Inter for UI, JetBrains Mono for anything that is a value: an
            identifier, a duration or a count must line up in a column, and a
            proportional font makes a table of numbers unreadable. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <div className="app">
          <Rail />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

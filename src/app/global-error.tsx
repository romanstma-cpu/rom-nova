"use client";

// The root layout itself failed: the chrome is gone and so is the
// stylesheet, so this one page dresses itself in the same palette, inline.
// It replaces the whole document while active, which is why it carries its
// own <html> and <body>.

const PANEL: React.CSSProperties = {
  maxWidth: 560,
  padding: "26px 28px",
  border: "1px solid #1b2333",
  borderRadius: 10,
  background: "#0d121c",
  boxShadow: "0 14px 34px -20px rgba(0,0,0,0.95)",
};

const BUTTON: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid #33415c",
  background: "rgba(28,38,58,0.6)",
  color: "#dbe4f2",
  fontSize: 12,
  cursor: "pointer",
};

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#04060a",
          color: "#dbe4f2",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          display: "grid",
          placeItems: "center",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <title>Something broke · ROM Nova</title>
        <div style={PANEL}>
          <div style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#8593ab", fontWeight: 600 }}>
            ROM Nova
          </div>
          <h1 style={{ fontSize: 18, margin: "8px 0 6px", fontWeight: 600 }}>The app could not draw its first screen</h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#8593ab", margin: 0 }}>
            Something failed before the frame around the pages could be built. Reloading fixes this more often than not; if
            it keeps happening, the message below is what to report. Nothing kept in this browser has been touched.
          </p>
          <pre
            style={{
              margin: "14px 0 0",
              padding: 10,
              fontSize: 11,
              lineHeight: 1.5,
              color: "#ff4d6d",
              background: "rgba(255,77,109,0.06)",
              border: "1px solid rgba(255,77,109,0.25)",
              borderRadius: 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 160,
              overflow: "auto",
              fontFamily: "ui-monospace, Consolas, monospace",
            }}
          >
            {error.message || String(error)}
            {error.digest ? `\n${error.digest}` : ""}
          </pre>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button type="button" style={BUTTON} onClick={() => location.reload()}>
              Reload
            </button>
            <button type="button" style={BUTTON} onClick={() => retry()}>
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

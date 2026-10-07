import { Spinner } from "@/components/Spinner";

// Instant fallback streamed while the page's server component fetches league data.
// Matches the app's near-black background + lime spinner so the load feels immediate
// instead of a blank screen. Server component (no client JS needed).
export default function Loading() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#0C0E10",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
      }}
    >
      <Spinner />
      <div style={{ fontSize: 13, fontWeight: 600, color: "#5A6168", letterSpacing: ".04em" }}>
        Loading the ladder…
      </div>
    </div>
  );
}

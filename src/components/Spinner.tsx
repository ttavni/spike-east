// Shared loading spinner — the lime ring used by both the route-level loading
// fallback (app/loading.tsx) and the "Updating ratings…" overlay in SpikeApp.
// One source of truth so the two can't silently drift. Pure markup: works as a
// server component (loading.tsx) and inside the client SpikeApp alike.
// Animation keyframes (`spkSpin`) live in globals.css.
export function Spinner({ size = 46 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "3px solid rgba(255,255,255,.12)",
        borderTopColor: "#CBFB4F",
        animation: "spkSpin .8s linear infinite",
      }}
    />
  );
}

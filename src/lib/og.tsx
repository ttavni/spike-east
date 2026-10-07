import { ImageResponse } from "next/og";

// Shared social-card renderer for East London Roundnet.
// Clean and minimal: the ball-and-net mark, the group name, nothing else.

export const ogSize = { width: 1200, height: 630 };
export const ogAlt = "East London Roundnet";
export const ogContentType = "image/png";

// The app mark (matches icon.svg) embedded as a data URI so the card needs no assets.
const MARK = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="ball" cx="38%" cy="34%" r="75%"><stop offset="0%" stop-color="#eaffb0"/><stop offset="55%" stop-color="#CBFB4F"/><stop offset="100%" stop-color="#a9d72f"/></radialGradient>
    <linearGradient id="streak" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#CBFB4F" stop-opacity="0"/><stop offset="100%" stop-color="#CBFB4F"/></linearGradient>
    <clipPath id="ring"><circle cx="256" cy="262" r="150"/></clipPath>
  </defs>
  <circle cx="256" cy="262" r="150" fill="none" stroke="#CBFB4F" stroke-width="10"/>
  <g clip-path="url(#ring)" stroke="#CBFB4F" stroke-width="7" opacity="0.30">
    <line x1="256" y1="100" x2="256" y2="424"/><line x1="94" y1="262" x2="418" y2="262"/>
    <line x1="150" y1="156" x2="362" y2="368"/><line x1="362" y1="156" x2="150" y2="368"/>
    <circle cx="256" cy="262" r="86" fill="none"/>
  </g>
  <line x1="372" y1="150" x2="300" y2="222" stroke="url(#streak)" stroke-width="46" stroke-linecap="round"/>
  <circle cx="290" cy="232" r="64" fill="#0C0E10"/>
  <circle cx="290" cy="232" r="50" fill="url(#ball)"/>
</svg>`;

const markSrc = `data:image/svg+xml;utf8,${encodeURIComponent(MARK)}`;

export function renderOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0C0E10",
          backgroundImage: "radial-gradient(120% 75% at 50% 8%, #16201A 0%, #0C0E10 55%)",
          gap: 40,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={markSrc} width={210} height={210} alt="" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 76, letterSpacing: -2, color: "#F4F5F6" }}>
            East London Roundnet
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 24,
              letterSpacing: 8,
              color: "#CBFB4F",
            }}
          >
            ROUNDNET LADDER
          </div>
        </div>
      </div>
    ),
    { ...ogSize },
  );
}

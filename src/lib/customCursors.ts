// Custom Cursor Packs & Trail FX Manager
export type CursorPackId = "default" | "gaming" | "retro_crosshair" | "neon_pointer" | "particle_trail";

export const CURSOR_PACKS: { id: CursorPackId; label: string; css: string }[] = [
  { id: "default", label: "Default Pointer", css: "auto" },
  { id: "gaming", label: "Gaming Sword", css: "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"%2300f0ff\" stroke-width=\"2\"><polygon points=\"12 2 15 8 22 9 17 14 18 21 12 17 6 21 7 14 2 9 9 8 12 2\"/></svg>') 12 12, auto" },
  { id: "retro_crosshair", label: "Retro Crosshair", css: "crosshair" },
  { id: "neon_pointer", label: "Neon Pointer", css: "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"%23ff0055\" stroke=\"%23ffffff\" stroke-width=\"1.5\"><path d=\"M3 3l7 18 3-7 7-3L3 3z\"/></svg>') 0 0, auto" },
  { id: "particle_trail", label: "Particle Trail Cursor", css: "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"%23a855f7\"><circle cx=\"12\" cy=\"12\" r=\"8\"/></svg>') 8 8, auto" },
];

export function applyCustomCursor(packId: CursorPackId) {
  const pack = CURSOR_PACKS.find((p) => p.id === packId) || CURSOR_PACKS[0];
  document.body.style.cursor = pack.css;
  localStorage.setItem("nitro_custom_cursor", packId);
}

export function initCursorTrail() {
  let dots: HTMLDivElement[] = [];
  const mouse = { x: 0, y: 0 };
  let active = false;

  const checkTrail = () => {
    const saved = localStorage.getItem("nitro_custom_cursor");
    if (saved === "particle_trail" && !active) {
      active = true;
      for (let i = 0; i < 12; i++) {
        const dot = document.createElement("div");
        dot.className = "cursor-trail-dot";
        dot.style.cssText = `
          position: fixed;
          top: 0; left: 0;
          width: ${10 - i * 0.7}px;
          height: ${10 - i * 0.7}px;
          background: hsl(${i * 25 + 200}, 90%, 65%);
          border-radius: 50%;
          pointer-events: none;
          z-index: 99999;
          transition: transform 0.08s ease-out, opacity 0.2s ease;
          opacity: ${1 - i * 0.08};
        `;
        document.body.appendChild(dot);
        dots.push(dot);
      }
    } else if (saved !== "particle_trail" && active) {
      active = false;
      dots.forEach((d) => d.remove());
      dots = [];
    }
  };

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (active && dots.length > 0) {
      dots.forEach((dot, idx) => {
        setTimeout(() => {
          if (dot) {
            dot.style.transform = `translate3d(${mouse.x - 4}px, ${mouse.y - 4}px, 0)`;
          }
        }, idx * 18);
      });
    }
  });

  setInterval(checkTrail, 1000);
}

import React, { useEffect, useRef } from "react";

export type ParticleEffectType = "matrix" | "snow" | "orbs" | "starfield" | "dust" | "none";

interface CanvasParticleEngineProps {
  effect: ParticleEffectType;
  opacity?: number;
}

export default function CanvasParticleEngine({ effect, opacity = 0.8 }: CanvasParticleEngineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!effect || effect === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", handleResize);

    // Matrix Rain setup
    const katakana = "アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレヱゲゼデベペオォコソトノホモヨョロヲゴゾドボポヴッン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const fontSize = 14;
    const columns = Math.floor(width / fontSize);
    const rainDrops: number[] = Array(columns).fill(1);

    // Snow / Dust / Orbs setup
    const particlesCount = effect === "starfield" ? 250 : effect === "snow" ? 120 : effect === "orbs" ? 35 : 80;
    const particles = Array.from({ length: particlesCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: effect === "orbs" ? Math.random() * 40 + 10 : Math.random() * 3 + 1,
      speedX: (Math.random() - 0.5) * (effect === "starfield" ? 0.2 : 0.5),
      speedY: effect === "snow" ? Math.random() * 1.5 + 0.5 : (Math.random() - 0.5) * 0.8,
      alpha: Math.random() * 0.7 + 0.3,
      color: effect === "snow" ? "#ffffff" : effect === "dust" ? "#00f0ff" : effect === "orbs" ? `hsla(${Math.random() * 360}, 80%, 60%, 0.15)` : "#ffffff",
    }));

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      if (effect === "matrix") {
        ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#0F0";
        ctx.font = `${fontSize}px monospace`;

        for (let i = 0; i < rainDrops.length; i++) {
          const text = katakana.charAt(Math.floor(Math.random() * katakana.length));
          ctx.fillText(text, i * fontSize, rainDrops[i] * fontSize);

          if (rainDrops[i] * fontSize > height && Math.random() > 0.975) {
            rainDrops[i] = 0;
          }
          rainDrops[i]++;
        }
      } else if (effect === "snow" || effect === "dust" || effect === "orbs" || effect === "starfield") {
        particles.forEach((p) => {
          ctx.beginPath();
          if (effect === "orbs") {
            const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
            grad.addColorStop(0, p.color);
            grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grad;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.alpha;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }

          p.x += p.speedX;
          p.y += p.speedY;

          if (p.y > height) p.y = 0;
          if (p.y < 0) p.y = height;
          if (p.x > width) p.x = 0;
          if (p.x < 0) p.x = width;
        });
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animId);
    };
  }, [effect]);

  if (!effect || effect === "none") return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
        opacity,
      }}
    />
  );
}

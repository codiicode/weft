"use client";
import { useEffect, useRef } from "react";

/**
 * Procedural "weft" backdrop: horizontal threads that undulate, bend around
 * the cursor, and carry small beads of signal along a few of them.
 * Canvas 2D, DPR-capped, paused offscreen, static under reduced motion.
 */
export function ThreadField({ className = "", density = 30, accentEvery = 6 }: { className?: string; density?: number; accentEvery?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0,
      h = 0,
      dpr = 1,
      raf = 0,
      visible = true,
      t = Math.random() * 100;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
    let colors = { ink: "rgba(11,12,15,.075)", accent: "rgba(47,107,255,.32)", volt: "rgba(143,191,0,.55)", bead: "#2f6bff" };

    const readColors = () => {
      const dark = document.documentElement.dataset.theme === "dark" || canvas.closest(".night") != null;
      colors = dark
        ? { ink: "rgba(255,255,255,.06)", accent: "rgba(106,149,255,.32)", volt: "rgba(205,255,63,.45)", bead: "#cdff3f" }
        : { ink: "rgba(11,12,15,.075)", accent: "rgba(47,107,255,.28)", volt: "rgba(110,150,0,.5)", bead: "#2f6bff" };
    };
    readColors();
    const mo = new MutationObserver(() => {
      readColors();
      if (reduce) draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduce) draw();
    };

    const lineY = (i: number, x: number) => {
      const n = density;
      const base = (h / (n + 1)) * (i + 1);
      const a = Math.sin(x * 0.0032 + t * 0.35 + i * 0.42) * 14;
      const b = Math.sin(x * 0.0071 - t * 0.22 + i * 1.31) * 7;
      const c = Math.sin(x * 0.0013 + t * 0.12 + i * 0.07) * 22;
      let y = base + a + b + c;
      // cursor bends threads away
      const dx = x - mouse.x;
      const dy = y - mouse.y;
      const d2 = dx * dx + dy * dy;
      const R = 180;
      if (d2 < R * R * 4) {
        const f = Math.exp(-d2 / (R * R));
        y += (dy >= 0 ? 1 : -1) * f * 38;
      }
      return y;
    };

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const step = w < 700 ? 24 : 16;
      for (let i = 0; i < density; i++) {
        const accent = i % accentEvery === 3;
        const volt = i === Math.floor(density * 0.62);
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += step) {
          const y = lineY(i, x);
          x === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = volt ? colors.volt : accent ? colors.accent : colors.ink;
        ctx.lineWidth = volt ? 1.4 : accent ? 1.1 : 1;
        ctx.stroke();

        if ((accent || volt) && !reduce) {
          // beads travelling along accent threads
          for (let k = 0; k < 2; k++) {
            const speed = 60 + ((i * 37) % 40);
            const x = ((t * speed + k * w * 0.5 + i * 211) % (w + 200)) - 100;
            const y = lineY(i, x);
            ctx.beginPath();
            ctx.arc(x, y, volt ? 2.6 : 2.1, 0, Math.PI * 2);
            ctx.fillStyle = volt ? colors.volt.replace(/[\d.]+\)$/, "1)") : colors.bead;
            ctx.globalAlpha = 0.85;
            ctx.fill();
            ctx.globalAlpha = 0.16;
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    const loop = () => {
      t += 0.016;
      mouse.x += (mouse.tx - mouse.x) * 0.08;
      mouse.y += (mouse.ty - mouse.y) * 0.08;
      draw();
      raf = visible ? requestAnimationFrame(loop) : 0;
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse.tx = e.clientX - r.left;
      mouse.ty = e.clientY - r.top;
      if (mouse.x < -999) {
        mouse.x = mouse.tx;
        mouse.y = mouse.ty;
      }
    };
    const onLeave = () => {
      mouse.tx = -9999;
      mouse.ty = -9999;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf && !reduce) raf = requestAnimationFrame(loop);
    });
    io.observe(canvas);
    if (reduce) draw();
    else {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerleave", onLeave);
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [density, accentEvery]);

  return <canvas ref={ref} className={`pointer-events-none ${className}`} aria-hidden />;
}

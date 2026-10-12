"use client";
import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "../graph/icons";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") || "light");
  }, []);
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };
  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      className="grid h-9 w-9 place-items-center rounded-[10px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
    >
      {theme === "light" ? <IconMoon size={15} /> : <IconSun size={15} />}
    </button>
  );
}

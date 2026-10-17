"use client";
import { useEffect } from "react";

/** Sets the browser tab title to "<title> · Weft" once the page knows its subject. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Weft`;
  }, [title]);
}

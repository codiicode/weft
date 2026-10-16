"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Runs was renamed Portfolio; old links still land in the right place. */
export default function RunsRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/app/portfolio"), [router]);
  return null;
}

import type { MetadataRoute } from "next";
import { brand } from "@/config/brand";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/home", "/strategies", "/markets", "/leaderboard"].map((p) => ({ url: `${brand.url}${p}`, changeFrequency: p ? "daily" : "weekly", priority: p ? 0.6 : 1 }));
}

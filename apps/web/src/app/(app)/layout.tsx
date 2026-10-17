import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = { title: "Weft" };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}

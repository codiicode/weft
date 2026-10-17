import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { Workflows } from "@/components/landing/Workflows";
import { AgentDemo } from "@/components/landing/AgentDemo";
import { Statement } from "@/components/landing/Statement";
import { Markets } from "@/components/landing/Markets";
import { Watches } from "@/components/landing/Watches";
import { Safety } from "@/components/landing/Safety";
import { Strategies } from "@/components/landing/Strategies";
import { Token } from "@/components/landing/Token";
import { FAQ } from "@/components/landing/FAQ";
import { Closing } from "@/components/landing/Closing";
import { Footer } from "@/components/landing/Footer";
import { SmoothScroll } from "@/components/ui/SmoothScroll";

export default function Page() {
  return (
    <>
      <SmoothScroll />
      <Nav />
      <main>
        <Hero />
        <AgentDemo />
        <Statement />
        <Workflows />
        <Markets />
        <Watches />
        <Safety />
        <Strategies />
        <Token />
        <FAQ />
        <Closing />
      </main>
      <Footer />
    </>
  );
}

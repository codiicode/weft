import { Nav } from "@/components/sections/Nav";
import { Hero } from "@/components/sections/Hero";
import { Tape } from "@/components/sections/Tape";
import { Manifesto } from "@/components/sections/Manifesto";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Gallery } from "@/components/sections/Gallery";
import { Signals } from "@/components/sections/Signals";
import { Leaderboard } from "@/components/sections/Leaderboard";
import { Token } from "@/components/sections/Token";
import { Safety } from "@/components/sections/Safety";
import { Compare } from "@/components/sections/Compare";
import { FAQ } from "@/components/sections/FAQ";
import { CTA } from "@/components/sections/CTA";
import { Footer } from "@/components/sections/Footer";
import { SmoothScroll } from "@/components/ui/SmoothScroll";

export default function Page() {
  return (
    <>
      <SmoothScroll />
      <Nav />
      <main>
        <Hero />
        <Tape />
        <Manifesto />
        <HowItWorks />
        <Gallery />
        <Signals />
        <Safety />
        <Leaderboard />
        <Token />
        <Compare />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </>
  );
}

import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Markets } from "@/components/landing/Markets";
import { Safety } from "@/components/landing/Safety";
import { Strategies } from "@/components/landing/Strategies";
import { Token } from "@/components/landing/Token";
import { FAQ } from "@/components/landing/FAQ";
import { Closing } from "@/components/landing/Closing";
import { Footer } from "@/components/landing/Footer";

export default function Page() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Markets />
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

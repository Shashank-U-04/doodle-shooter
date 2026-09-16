import { motion } from "framer-motion";
import {
  ArrowRight,
  Crosshair,
  Eraser,
  PenTool,
  Swords,
  Waves,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
};

const EXHIBITS = [
  {
    icon: Waves,
    no: "No. 01",
    title: "Wave Survival",
    body: "The district redraws itself against you. Each wave crawls off the page with a fresh modifier — caffeinated ink, heavy strokes, or a full swarm.",
    meta: "endless · modifiers",
  },
  {
    icon: Swords,
    no: "No. 02",
    title: "Five Arms, One Blade",
    body: "Rifle, shotgun, bolt-action sniper, hand cannon — and a katana. Three clean kills without a miss charges a focus slash that freezes the page.",
    meta: "focus meter",
  },
  {
    icon: Eraser,
    no: "No. 03",
    title: "Bosses Every Fifth",
    body: "THE DOODLER, THE ERASER, THE INKBLOT. Towering sketches with a health bar and a taste for erasing you off the paper.",
    meta: "checkpoints · waves 5-10-15",
  },
  {
    icon: Crosshair,
    no: "No. 04",
    title: "Movement Is Armor",
    body: "Double jump, dash, and grapple to the rooftops. Airborne kills are worth more — stay off the floor.",
    meta: "grapple · stamina",
  },
];

const ROSTER = [
  { name: "GRUNT", note: "cap · rifle bursts", ink: "#1a2fc2" },
  { name: "RUSHER", note: "band · blade lunges", ink: "#c22f2f" },
  { name: "INK BOMB", note: "black · fuses fast", ink: "#2e2e2e" },
  { name: "SNIPER", note: "hood · one heavy shot", ink: "#1f7a4d" },
  { name: "PAPER WASP", note: "airborne · dives", ink: "#e066a8" },
  { name: "HEAVY", note: "helmet · scattergun", ink: "#e08c14" },
  { name: "SHIELDBEARER", note: "plate · deflects lead", ink: "#1a2fc2" },
];

function SketchDoodle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" fill="none" className={className} aria-hidden>
      <path
        d="M6 96c14-6 22-28 20-44-2-14 10-22 22-18s12 20 26 20 20-16 34-14 12 18 26 16 18-14 32-10 16 18 30 16 24-8 32-2"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M28 98c10-2 14-12 13-21M52 97c8-3 10-9 10-16M118 96c9-1 13-8 12-15M176 97c9-2 12-9 11-16"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.4"
      />
      <circle cx="196" cy="30" r="12" stroke="currentColor" strokeWidth="2" opacity="0.7" />
      <path d="M186 26c3-2 6-2 9 0M194 33c2 2 5 2 7 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground studio-grain">
      {/* top rule */}
      <div className="border-b border-border/80">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <PenTool className="size-4 text-ink" strokeWidth={1.75} />
            <span className="font-studio-display text-sm font-medium tracking-[0.22em] uppercase">
              The Doodle Gallery
            </span>
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" className="text-muted-foreground hover:text-foreground">
              <a href="#exhibits">Exhibits</a>
            </Button>
            <Button asChild variant="ghost" className="text-muted-foreground hover:text-foreground">
              <a href="#roster">The Cast</a>
            </Button>
            <Button asChild className="rounded-none font-studio-display tracking-[0.18em] uppercase">
              <a href="#play">Enter</a>
            </Button>
          </nav>
        </header>
      </div>

      {/* hero */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-14 sm:pt-24">
        <motion.div {...fadeUp} transition={{ duration: 0.6, ease: "easeOut" }} className="max-w-3xl">
          <p className="text-xs tracking-[0.3em] uppercase text-muted-foreground">
            Gallery 01 — Interactive Works on Paper
          </p>
          <h1 className="mt-6 font-studio-display text-5xl leading-[1.02] font-semibold tracking-tight sm:text-7xl">
            DOODLE
            <span className="text-ink"> DISTRICT</span>
          </h1>
          <p className="font-sketch-hand mt-4 text-2xl text-ink-soft sm:text-3xl">
            a scribbled survival shooter
          </p>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
            A first-person wave shooter drawn entirely in ink on paper. Blue biro
            streets, boxed-out buildings, enemies that scribble themselves into
            existence — and a katana that erases them. Survival, hung salon-style.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="h-12 rounded-none px-8 font-studio-display text-sm tracking-[0.2em] uppercase">
              <a href="#play">
                Play the exhibition
                <ArrowRight className="ml-2 size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 rounded-none px-8 font-studio-display text-sm tracking-[0.2em] uppercase">
              <a href="#exhibits">View the exhibits</a>
            </Button>
          </div>
        </motion.div>

        {/* framed preview */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
          className="studio-frame mt-14 bg-card p-3 shadow-[0_30px_60px_-30px_rgba(38,33,24,0.25)] sm:p-5"
        >
          <div className="paper relative flex aspect-[16/8] items-center justify-center overflow-hidden">
            {/* hand-drawn skyline */}
            <svg viewBox="0 0 800 260" fill="none" className="absolute inset-0 h-full w-full text-ink/80" aria-hidden>
              <g stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <rect x="60" y="90" width="120" height="150" />
                <rect x="74" y="106" width="18" height="16" />
                <rect x="102" y="106" width="18" height="16" />
                <rect x="130" y="106" width="18" height="16" />
                <rect x="74" y="136" width="18" height="16" />
                <rect x="102" y="136" width="18" height="16" />
                <rect x="180" y="140" width="90" height="100" />
                <rect x="194" y="154" width="14" height="12" />
                <rect x="220" y="154" width="14" height="12" />
                <rect x="300" y="60" width="140" height="180" />
                <rect x="318" y="80" width="20" height="18" />
                <rect x="350" y="80" width="20" height="18" />
                <rect x="382" y="80" width="20" height="18" />
                <rect x="318" y="116" width="20" height="18" />
                <rect x="350" y="116" width="20" height="18" />
                <rect x="382" y="116" width="20" height="18" />
                <rect x="470" y="120" width="100" height="120" />
                <rect x="486" y="138" width="16" height="12" />
                <rect x="514" y="138" width="16" height="12" />
                <rect x="600" y="80" width="120" height="160" />
                <rect x="618" y="100" width="18" height="16" />
                <rect x="648" y="100" width="18" height="16" />
                <rect x="678" y="100" width="18" height="16" />
                <rect x="618" y="132" width="18" height="16" />
                <rect x="648" y="132" width="18" height="16" />
                <path d="M20 242h760" strokeWidth="2.5" />
              </g>
              <g stroke="#c22f2f" strokeWidth="2">
                <circle cx="330" cy="24" r="14" />
                <path d="M330 40v26M330 50l-10 10M330 50l10 10M330 66l-8 16M330 66l8 16" />
              </g>
            </svg>
            <div className="relative z-10 pb-8 text-center">
              <p className="font-sketch text-4xl text-ink sm:text-5xl">wave 5 — THE DOODLER</p>
              <p className="font-sketch-hand mt-1 text-lg text-ink-soft">draw your own hero</p>
            </div>
          </div>
          <div className="flex items-center justify-between px-1 pt-3">
            <p className="text-[11px] tracking-[0.24em] uppercase text-muted-foreground">
              Fig. 1 — The District, blue biro on paper
            </p>
            <p className="text-[11px] tracking-[0.24em] uppercase text-muted-foreground">2026</p>
          </div>
        </motion.div>
      </section>

      {/* exhibits */}
      <section id="exhibits" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-16">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs tracking-[0.3em] uppercase text-muted-foreground">Exhibits</p>
            <h2 className="mt-3 font-studio-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Four rooms, one sketchbook
            </h2>
          </div>
          <SketchDoodle className="hidden h-16 w-40 text-ink/50 md:block" />
        </div>
        <Separator className="mt-6" />
        <div className="mt-10 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
          {EXHIBITS.map((ex) => (
            <motion.article
              key={ex.no}
              {...fadeUp}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="group bg-card p-8 transition-colors hover:bg-accent/60"
            >
              <div className="flex items-center justify-between">
                <ex.icon className="size-5 text-ink" strokeWidth={1.6} />
                <span className="text-[11px] tracking-[0.26em] uppercase text-muted-foreground">{ex.no}</span>
              </div>
              <h3 className="mt-6 font-studio-display text-xl font-semibold tracking-tight">{ex.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{ex.body}</p>
              <p className="font-sketch-hand mt-5 text-lg text-ink/70">{ex.meta}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* roster */}
      <section id="roster" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-16">
        <p className="text-xs tracking-[0.3em] uppercase text-muted-foreground">The Cast</p>
        <h2 className="mt-3 font-studio-display text-3xl font-semibold tracking-tight sm:text-4xl">
          They are crawling off the page
        </h2>
        <Separator className="mt-6" />
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {ROSTER.map((r) => (
            <motion.figure key={r.name} {...fadeUp} transition={{ duration: 0.45, ease: "easeOut" }}>
              <svg viewBox="0 0 120 120" fill="none" className="h-28 w-28">
                <g stroke={r.ink} strokeWidth="2.4" strokeLinejoin="round" opacity="0.9">
                  <rect x="44" y="34" width="32" height="40" />
                  <rect x="52" y="16" width="16" height="16" />
                  <path d="M50 74v26M70 74v26M44 44l-12 18M76 44l12 18" strokeLinecap="round" />
                </g>
              </svg>
              <figcaption className="mt-3">
                <p className="font-studio-display text-sm font-semibold tracking-[0.14em]">{r.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{r.note}</p>
              </figcaption>
            </motion.figure>
          ))}
        </div>
      </section>

      {/* play CTA */}
      <section id="play" className="mx-auto max-w-6xl scroll-mt-8 px-6 pb-24">
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.55, ease: "easeOut" }}
          className="studio-frame bg-card px-6 py-14 text-center sm:px-14"
        >
          <Badge variant="outline" className="rounded-none border-ink/30 text-ink">
            Free entry · bring a mouse
          </Badge>
          <h2 className="mx-auto mt-6 max-w-xl font-studio-display text-3xl font-semibold tracking-tight sm:text-5xl">
            The ink is already moving
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-muted-foreground">
            Survive the waves, swing for the fences, and keep an eye on wave five.
            Your best score is saved to the sketchbook.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="h-12 rounded-none px-9 font-studio-display text-sm tracking-[0.2em] uppercase">
              <a href="/game">Enter Doodle District</a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 rounded-none px-9 font-studio-display text-sm tracking-[0.2em] uppercase">
              <a href="/dashboard">Your gallery wall</a>
            </Button>
          </div>
          <p className="mt-6 text-xs tracking-[0.2em] uppercase text-muted-foreground">
            click to capture mouse · esc to release
          </p>
        </motion.div>
      </section>

      {/* footer */}
      <footer className="border-t border-border/80">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs tracking-[0.18em] uppercase text-muted-foreground sm:flex-row">
          <span>The Doodle Gallery — works on paper</span>
          <span>ink · paper · reflexes</span>
        </div>
      </footer>
    </div>
  );
}

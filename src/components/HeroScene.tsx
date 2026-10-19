// The title screen's hero drawing.
//
// Built as one layered SVG rather than a bitmap so the line work stays crisp
// on every display, and so the parallax layers (sky, dunes, props, character)
// can drift independently. Everything is drawn in the game's own ink colours.

import { useRef } from "react";

const INK = "#2B2A27";

export function HeroScene() {
  const ref = useRef<SVGSVGElement>(null);

  // Gentle pointer parallax. Written straight to CSS custom properties so a
  // mouse move never re-renders React; skipped entirely when the player asked
  // for reduced motion.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--px", String((e.clientX - r.left) / r.width - 0.5));
    el.style.setProperty("--py", String((e.clientY - r.top) / r.height - 0.5));
  };
  const onLeave = () => {
    ref.current?.style.setProperty("--px", "0");
    ref.current?.style.setProperty("--py", "0");
  };

  return (
    <svg
      ref={ref}
      className="dd-hero-art"
      viewBox="0 0 720 620"
      role="img"
      aria-label="A doodle survivor firing a marker rifle in the Pharaoh's Valley, with three pyramids, a mummy and the doodle district skyline."
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <defs>
        <pattern id="dd-sand-speck" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="6" r="1.1" fill={INK} opacity="0.16" />
          <circle cx="17" cy="18" r="0.9" fill={INK} opacity="0.12" />
        </pattern>
        <pattern id="dd-ink-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-40)">
          <line x1="0" y1="0" x2="0" y2="9" stroke={INK} strokeWidth="1.4" opacity="0.22" />
        </pattern>
      </defs>

      {/* ---------------- sky layer ---------------- */}
      <g className="dd-art-sky" style={{ translate: "calc(var(--px, 0) * 10px) calc(var(--py, 0) * 8px)" }}>
        <g className="dd-art-sun">
          <circle cx="565" cy="120" r="54" fill="var(--dd-yellow)" stroke={INK} strokeWidth="6" />
          <circle cx="565" cy="120" r="38" fill="none" stroke={INK} strokeWidth="2" opacity="0.45" strokeDasharray="5 9" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
            const rad = (a * Math.PI) / 180;
            return (
              <line
                key={a}
                x1={565 + Math.cos(rad) * 62}
                y1={120 + Math.sin(rad) * 62}
                x2={565 + Math.cos(rad) * 76}
                y2={120 + Math.sin(rad) * 76}
                stroke={INK}
                strokeWidth="5"
                strokeLinecap="round"
              />
            );
          })}
        </g>

        <g fill="var(--dd-cream)" stroke={INK} strokeWidth="5" strokeLinejoin="round">
          <path d="M92 128c-14 0-25-11-25-24 0-16 13-27 29-24 4-17 20-27 37-22 13 4 20 14 22 25 17-2 30 9 30 23 0 14-12 24-27 24z" />
          <path d="M300 84c-10 0-18-8-18-17 0-11 9-19 20-17 3-12 14-19 26-15 9 3 14 10 15 18 12-1 21 6 21 16 0 10-9 15-19 15z" opacity="0.9" />
        </g>
        <g stroke={INK} strokeWidth="3" strokeLinecap="round" opacity="0.5" fill="none">
          <path d="M60 168c14-7 26-7 40 0" />
          <path d="M648 236c-12-6-23-6-34 0" />
        </g>
      </g>

      {/* ---------------- distant district + pyramids ---------------- */}
      <g className="dd-art-far" style={{ translate: "calc(var(--px, 0) * 16px) calc(var(--py, 0) * 10px)" }}>
        {/* district skyline, the original map, tucked behind the desert */}
        <g fill="var(--dd-cream)" stroke={INK} strokeWidth="5" strokeLinejoin="round">
          <path d="M34 424V310h62v114z" />
          <path d="M96 424V264h54v160z" />
          <path d="M150 424V338h48v86z" />
          <path d="M198 424V296h36v128z" opacity="0.95" />
        </g>
        <g fill="var(--dd-blue)" opacity="0.75">
          <rect x="48" y="330" width="12" height="16" />
          <rect x="70" y="330" width="12" height="16" />
          <rect x="48" y="360" width="12" height="16" />
          <rect x="70" y="360" width="12" height="16" />
          <rect x="112" y="286" width="13" height="17" />
          <rect x="136" y="286" width="13" height="17" />
          <rect x="112" y="318" width="13" height="17" />
          <rect x="136" y="318" width="13" height="17" />
        </g>
        <path d="M96 264h54l-8-18H104z" fill="var(--dd-orange)" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
        <path d="M40 304c8-14 22-14 30 0" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />

        {/* the great pyramid */}
        <path d="M300 432 405 168 510 432z" fill="var(--dd-sandstone)" stroke={INK} strokeWidth="8" strokeLinejoin="round" />
        <path d="M405 168 510 432H420z" fill={INK} opacity="0.1" />
        <g stroke={INK} strokeWidth="2.4" opacity="0.32" strokeLinecap="round">
          <path d="M330 380h150" />
          <path d="M350 328h108" />
          <path d="M370 280h66" />
          <path d="M389 232h34" />
          <path d="M405 168v264" />
        </g>
        <path d="M398 432v-52h22v52z" fill={INK} />
        <path d="M394 380h30" stroke="var(--dd-yellow)" strokeWidth="4" />

        {/* smaller pyramids */}
        <path d="M536 432 590 296 644 432z" fill="var(--dd-sandstone)" stroke={INK} strokeWidth="6" strokeLinejoin="round" />
        <path d="M590 296 644 432h-28z" fill={INK} opacity="0.12" />
        <path d="M586 432v-32h14v32z" fill={INK} />
        <path d="M176 432 218 330 260 432z" fill="var(--dd-sandstone)" stroke={INK} strokeWidth="6" strokeLinejoin="round" />
      </g>

      {/* ---------------- dunes ---------------- */}
      <g className="dd-art-mid" style={{ translate: "calc(var(--px, 0) * 22px) calc(var(--py, 0) * 12px)" }}>
        <path
          d="M-20 452c68-54 132-64 210-30 52 22 88 20 128-4 64-38 132-34 202 10 62 40 118 42 220 8v190H-20z"
          fill="var(--dd-sand)"
          stroke={INK}
          strokeWidth="6"
          strokeLinejoin="round"
        />
        <path
          d="M-20 452c68-54 132-64 210-30 52 22 88 20 128-4 64-38 132-34 202 10 62 40 118 42 220 8v190H-20z"
          fill="url(#dd-sand-speck)"
        />
        <path d="M70 470c46-18 92-14 132 8" fill="none" stroke={INK} strokeWidth="3" opacity="0.3" strokeLinecap="round" />
        <path d="M452 484c54-20 104-14 150 8" fill="none" stroke={INK} strokeWidth="3" opacity="0.3" strokeLinecap="round" />
        {/* canyon slab on the right */}
        <path d="M584 470 626 360 690 360 710 470z" fill="var(--dd-sandstone)" stroke={INK} strokeWidth="6" strokeLinejoin="round" />
        <path d="M612 470 644 392h26l18 78z" fill={INK} opacity="0.18" />
      </g>

      {/* ---------------- foreground props ---------------- */}
      <g className="dd-art-fore" style={{ translate: "calc(var(--px, 0) * 30px) calc(var(--py, 0) * 16px)" }}>
        {/* palm */}
        <g stroke={INK} strokeLinejoin="round" strokeLinecap="round">
          <path d="M72 560c-6-44 0-82 8-120" fill="none" strokeWidth="10" stroke="var(--dd-sandstone)" />
          <path d="M72 560c-6-44 0-82 8-120" fill="none" strokeWidth="4" />
          <g fill="var(--dd-green)" strokeWidth="5">
            <path d="M82 438c-24-14-44-8-58 8 20 6 38 4 58-8z" />
            <path d="M82 438c24-18 46-14 62 2 -22 8-42 8-62-2z" />
            <path d="M82 440c-8-22-2-38 12-50 2 20-2 36-12 50z" />
            <path d="M82 440c14 14 18 30 12 46-12-12-16-28-12-46z" />
          </g>
          <circle cx="86" cy="446" r="5" fill="var(--dd-orange)" strokeWidth="3" />
        </g>

        {/* mummy peeking out of the dune */}
        <g className="dd-art-mummy">
          <path d="M256 500c-10-34 12-58 42-58s52 24 42 58z" fill="var(--dd-bone)" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
          <path d="M267 466c8-6 16-9 24-9s18 3 26 9" fill="none" stroke={INK} strokeWidth="3" opacity="0.4" />
          <path d="M275 483h8M293 483h8" stroke={INK} strokeWidth="5" strokeLinecap="round" />
          <circle cx="279" cy="481" r="4.6" fill="var(--dd-turquoise)" />
          <circle cx="297" cy="481" r="4.6" fill="var(--dd-turquoise)" />
          <path d="M282 497c6 4 12 4 18 0" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <path d="M252 490c-14 2-22 12-24 26M340 490c14 2 22 12 24 26" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          <path d="M242 508l-10 6M350 508l10 6" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          <path d="M310 452c10-16 26-16 34-2" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        </g>

        {/* signpost */}
        <g>
          <path d="M636 540V470" stroke={INK} strokeWidth="7" strokeLinecap="round" />
          <path d="M584 456h84l18 14-18 14h-84z" fill="var(--dd-yellow)" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
          <text x="636" y="475" textAnchor="middle" fontFamily="Patrick Hand, cursive" fontSize="17" fill={INK}>
            VALLEY
          </text>
        </g>

        {/* tumbling bullets */}
        <g stroke={INK} strokeWidth="3">
          <g className="dd-art-bullet">
            <rect x="612" y="352" width="26" height="8" rx="4" fill="var(--dd-orange)" transform="rotate(-24 612 352)" />
          </g>
          <g className="dd-art-bullet dd-art-bullet--b">
            <rect x="660" y="326" width="20" height="7" rx="3.5" fill="var(--dd-red)" transform="rotate(-18 660 326)" />
          </g>
          <g className="dd-art-bullet dd-art-bullet--c">
            <rect x="684" y="292" width="14" height="6" rx="3" fill="var(--dd-yellow)" transform="rotate(-12 684 292)" />
          </g>
        </g>

        {/* dust puffs at the boots */}
        <g fill="var(--dd-cream)" stroke={INK} strokeWidth="3" opacity="0.9">
          <circle cx="382" cy="566" r="10" />
          <circle cx="402" cy="574" r="7" />
          <circle cx="486" cy="570" r="9" />
          <circle cx="468" cy="578" r="6" />
        </g>
      </g>

      {/* ---------------- the doodler ---------------- */}
      <g className="dd-art-hero" style={{ translate: "calc(var(--px, 0) * 40px) calc(var(--py, 0) * 18px)" }}>
        {/* scarf */}
        <path d="M398 412c-34 4-52 18-62 40 20-4 34-2 48 8" fill="var(--dd-red)" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
        {/* legs + boots */}
        <path d="M414 500v48M462 500v46" stroke={INK} strokeWidth="14" strokeLinecap="round" />
        <path d="M406 552c-8 8-10 16-8 22h34v-14z" fill={INK} strokeLinejoin="round" strokeWidth="3" />
        <path d="M456 550c-6 10-6 18-2 24h36l-2-14z" fill={INK} strokeLinejoin="round" strokeWidth="3" />
        {/* torso */}
        <path
          d="M400 420c8-12 24-18 40-18 20 0 36 10 42 26l6 44c2 12-6 20-16 20h-56c-12 0-20-8-18-20z"
          fill="var(--dd-red)"
          stroke={INK}
          strokeWidth="6"
          strokeLinejoin="round"
        />
        <path d="M420 430h42" stroke="var(--dd-yellow)" strokeWidth="7" strokeLinecap="round" />
        <path d="M404 470c10 8 22 12 36 12" fill="none" stroke={INK} strokeWidth="3" opacity="0.4" />
        {/* back arm + hand */}
        <path d="M478 438c18 4 26 16 28 30" fill="none" stroke={INK} strokeWidth="11" strokeLinecap="round" />
        <circle cx="508" cy="472" r="8" fill="var(--dd-cream)" stroke={INK} strokeWidth="4" />
        {/* marker rifle, angled up and left */}
        <g transform="rotate(-22 490 452)">
          <rect x="438" y="440" width="118" height="24" rx="9" fill="var(--dd-blue)" stroke={INK} strokeWidth="5" />
          <rect x="518" y="436" width="42" height="12" rx="5" fill="var(--dd-orange)" stroke={INK} strokeWidth="4" />
          <rect x="548" y="446" width="12" height="22" rx="3" fill={INK} />
          <rect x="468" y="462" width="20" height="18" rx="4" fill={INK} />
          <path d="M444 452h-20" stroke={INK} strokeWidth="6" strokeLinecap="round" />
        </g>
        {/* front arm */}
        <path d="M402 438c-14 6-20 18-20 32" fill="none" stroke={INK} strokeWidth="11" strokeLinecap="round" />
        <circle cx="382" cy="472" r="8" fill="var(--dd-cream)" stroke={INK} strokeWidth="4" />
        {/* head */}
        <circle cx="442" cy="382" r="44" fill="var(--dd-cream)" stroke={INK} strokeWidth="6" />
        <path d="M400 374c6-28 24-42 46-42 22 0 40 14 44 38-26-10-56-8-90 4z" fill="var(--dd-orange)" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
        <path d="M400 374c-10 2-16 10-16 20" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
        <g fill={INK}>
          <circle cx="426" cy="388" r="5.4" />
          <circle cx="456" cy="388" r="5.4" />
        </g>
        <path d="M424 404c10 8 22 8 30 0" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <path d="M466 376l8 2" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        {/* muzzle flash */}
        <g transform="translate(586 382)" className="dd-art-flash">
          <path d="M0-26 8-8 28-10 13 3 22 22 2 12-10 28-12 8-32 6-14-4-22-22-2-14z" fill="var(--dd-yellow)" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
          <text x="2" y="-34" textAnchor="middle" fontFamily="Patrick Hand, cursive" fontSize="22" fill={INK} transform="rotate(-10)">
            BANG!
          </text>
        </g>
      </g>

      {/* ---------------- decorative doodles ---------------- */}
      <g className="dd-art-doodles" style={{ translate: "calc(var(--px, 0) * 48px) calc(var(--py, 0) * 24px)" }} fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round">
        <g className="dd-art-spin" transform="translate(660 120)">
          <path d="M0 0c14-18 30-8 22 8s-28 8-22-8 32-6 30 10" />
        </g>
        <g className="dd-art-float" transform="translate(124 236)">
          <path d="M0 0l7 18 20 2-15 13 5 20-17-11-18 11 5-20-14-13 20-2z" />
        </g>
        <g className="dd-art-drift" transform="translate(548 232)">
          <path d="M0 14c14-18 34-18 48 0M4 22c12-12 28-12 40 0" />
        </g>
        <g className="dd-art-float dd-art-float--slow" transform="translate(500 86)">
          <circle cx="0" cy="0" r="15" />
          <path d="M-8 0h16M0-8v16" />
        </g>
      </g>

      <text
        x="368"
        y="600"
        textAnchor="middle"
        fontFamily="Patrick Hand, cursive"
        fontSize="24"
        fill={INK}
        opacity="0.6"
        transform="rotate(-1.2 368 600)"
      >
        bring a marker. leave a mess.
      </text>
    </svg>
  );
}

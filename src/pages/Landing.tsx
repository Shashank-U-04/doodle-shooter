// SCREEN ONE — the title screen.
//
// Two unmistakable doors into the game: solo survival, or an online room with
// friends. Everything else on this page is either an entry point to a real
// setting or an honest description of what the game contains.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Cpu,
  Gamepad2,
  Info,
  Keyboard,
  Settings2,
  Sparkles,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { HeroScene } from "@/components/HeroScene";
import { MAPS, readSetup, writeSetup } from "@/game/maps";

type Panel = "settings" | "controls" | "about" | null;

const CONTROL_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "MOVE",
    rows: [
      ["W A S D", "walk"],
      ["SHIFT", "sprint"],
      ["SPACE", "jump · twice for a double jump"],
      ["C / CTRL", "crouch"],
      ["X", "dash"],
    ],
  },
  {
    title: "FIGHT",
    rows: [
      ["LEFT CLICK", "fire · katana slash"],
      ["RIGHT CLICK", "aim · block with the katana"],
      ["R", "reload"],
      ["G", "grenade"],
      ["1 – 5 / WHEEL", "rifle · shotgun · sniper · katana · revolver"],
      ["F", "focus dash (katana, meter full)"],
    ],
  },
  {
    title: "THE REST",
    rows: [
      ["MOUSE", "look"],
      ["Q / E", "grapple — when the match allows it"],
      ["H", "doors, chests, sarcophagi, levers"],
      ["M", "mute all audio"],
      ["P / ESC", "pause"],
    ],
  },
];

function readNum(key: string, fallback: number) {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function Landing() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [panel, setPanel] = useState<Panel>(null);
  const [sens, setSens] = useState(() => readNum("dd_sens", 100));
  const [invert, setInvert] = useState(() => localStorage.getItem("dd_invert") === "1");
  const [sound, setSound] = useState(() => localStorage.getItem("dd_music") !== "0");
  const [best] = useState(() => Number(localStorage.getItem("dd_best") || 0));
  const closeRef = useRef<HTMLButtonElement>(null);

  // Back returns to the mode picker with the last setup choices intact.
  const setup = readSetup();

  const toggleSound = useCallback(() => {
    setSound((on) => {
      localStorage.setItem("dd_music", on ? "0" : "1");
      return !on;
    });
  }, []);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  const go = (mode: "solo" | "friends") => {
    writeSetup({ mode });
    navigate(`/setup?mode=${mode}`);
  };

  const entrance = (delay: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 22 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] as const },
        };

  return (
    <div className={`dd-home ${reduce ? "dd-reduce" : ""}`}>
      <div className="dd-home-grain" aria-hidden="true" />
      <div className="dd-home-sunwash" aria-hidden="true" />

      <header className="dd-home-nav">
        <a
          className="dd-brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
          aria-label="Doodle Shooter home"
        >
          <span className="dd-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 48" role="presentation">
              <path d="M8 34 18 12l8 10 5-16 9 28" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 38h38" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              <circle cx="33" cy="15" r="3" fill="var(--dd-red)" />
            </svg>
          </span>
          <span className="dd-brand-type">
            <b>DOODLE SHOOTER</b>
            <i>SURVIVAL, SCRIBBLED</i>
          </span>
        </a>

        <nav className="dd-home-links" aria-label="Game information">
          <button type="button" onClick={() => setPanel("settings")}>
            <Settings2 className="size-4" /> GAME SETTINGS
          </button>
          <button type="button" onClick={() => setPanel("controls")}>
            <Keyboard className="size-4" /> CONTROLS
          </button>
          <button type="button" onClick={() => setPanel("about")}>
            <Info className="size-4" /> ABOUT
          </button>
          <button
            type="button"
            className="dd-sound"
            aria-pressed={sound}
            aria-label={sound ? "Mute game audio" : "Unmute game audio"}
            onClick={toggleSound}
          >
            {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            <span>{sound ? "SOUND ON" : "SOUND OFF"}</span>
          </button>
        </nav>
      </header>

      <main className="dd-home-main">
        <section className="dd-hero">
          <motion.div className="dd-hero-copy" {...entrance(0.05)}>
            <div className="dd-eyebrow">
              <span className="dd-eyebrow-line" />
              A HAND-DRAWN SURVIVAL SHOOTER
              <Sparkles className="size-4" />
            </div>
            <h1 className="dd-hero-title">
              <span>LOCK.</span>
              <span>LOAD.</span>
              <em>DOODLE.</em>
            </h1>
            <p className="dd-hero-sub">
              Choose your battlefield. Grab your gear. Make your mark.
            </p>

            <div className="dd-modes">
              <motion.button
                type="button"
                className="dd-mode dd-mode--solo"
                onClick={() => go("solo")}
                whileHover={reduce ? undefined : { y: -5, rotate: -0.6 }}
                whileTap={reduce ? undefined : { y: 1, scale: 0.99 }}
                {...entrance(0.16)}
              >
                <span className="dd-mode-top">
                  <span className="dd-mode-icon">
                    <Cpu className="size-5" />
                  </span>
                  <span className="dd-mode-tag">SINGLE PLAYER</span>
                  <ArrowRight className="dd-mode-arrow size-5" />
                </span>
                <strong>PLAY VS COMPUTER</strong>
                <span className="dd-mode-note">Survive the waves. No one to blame but the ink.</span>
                <span className="dd-mode-foot">
                  {MAPS.length} maps · waves · bosses
                </span>
              </motion.button>

              <motion.button
                type="button"
                className="dd-mode dd-mode--friends"
                onClick={() => go("friends")}
                whileHover={reduce ? undefined : { y: -5, rotate: 0.6 }}
                whileTap={reduce ? undefined : { y: 1, scale: 0.99 }}
                {...entrance(0.24)}
              >
                <span className="dd-mode-top">
                  <span className="dd-mode-icon">
                    <Users className="size-5" />
                  </span>
                  <span className="dd-mode-tag">ONLINE · 1–4 PLAYERS</span>
                  <ArrowRight className="dd-mode-arrow size-5" />
                </span>
                <strong>PLAY WITH FRIENDS</strong>
                <span className="dd-mode-note">Share a room code. Settle it in ink.</span>
                <span className="dd-mode-foot">peer-to-peer · host sets the rules</span>
              </motion.button>
            </div>

            <div className="dd-hero-meta">
              <span>
                <b>{MAPS.length}</b> battlefields
              </span>
              <span>
                <b>5</b> weapons
              </span>
              <span>
                <b>3</b> egypt zones
              </span>
              {best > 0 && (
                <span className="dd-best">
                  <Trophy className="size-4" /> BEST {best.toLocaleString()}
                </span>
              )}
              <span className="dd-last">
                <Check className="size-4" /> last pick · {MAPS.find((m) => m.id === setup.map)?.name}
              </span>
            </div>
          </motion.div>

          <motion.div className="dd-hero-stage" {...entrance(0.12)}>
            <div className="dd-hero-frame">
              <HeroScene />
              <div className="dd-hero-sticker dd-hero-sticker--one">
                <span>NOW LOADING</span>
                <b>100% INK</b>
              </div>
              <div className="dd-hero-sticker dd-hero-sticker--two">
                <Gamepad2 className="size-5" />
                <span>KEYBOARD + MOUSE</span>
              </div>
              <div className="dd-hero-tape" aria-hidden="true" />
            </div>
            <div className="dd-hero-underline" aria-hidden="true">
              <svg viewBox="0 0 620 26" preserveAspectRatio="none">
                <path d="M4 15c110-10 226-12 306-6 96 7 202 3 306-4" fill="none" stroke="var(--dd-ink)" strokeWidth="5" strokeLinecap="round" />
                <path d="M40 22c150-6 300-6 470-2" fill="none" stroke="var(--dd-red)" strokeWidth="4" strokeLinecap="round" opacity="0.8" />
              </svg>
            </div>
          </motion.div>
        </section>

        <section className="dd-mapstrip" aria-labelledby="mapstrip-title">
          <div className="dd-mapstrip-head">
            <div>
              <span className="dd-kicker">THE BATTLEFIELDS</span>
              <h2 id="mapstrip-title">Four ways to get erased.</h2>
            </div>
            <button type="button" className="dd-textlink" onClick={() => go("solo")}>
              PICK A BATTLEFIELD <ArrowRight className="size-4" />
            </button>
          </div>
          <div className="dd-mapstrip-grid">
            {MAPS.map((m, i) => (
              <motion.button
                key={m.id}
                type="button"
                className="dd-stamp"
                style={{ ["--stamp-accent" as string]: m.accent }}
                onClick={() => {
                  writeSetup({ map: m.id, mode: "solo" });
                  navigate(`/setup?mode=solo&map=${m.id}`);
                }}
                initial={reduce ? false : { opacity: 0, y: 18 }}
                animate={reduce ? undefined : { opacity: 1, y: 0 }}
                transition={reduce ? undefined : { delay: 0.05 * i, duration: 0.4 }}
                whileHover={reduce ? undefined : { rotate: i % 2 ? 1 : -1, y: -4 }}
              >
                <span className="dd-stamp-img">
                  <img src={m.preview} alt="" loading="lazy" />
                  <span className="dd-stamp-num">0{i + 1}</span>
                </span>
                <span className="dd-stamp-body">
                  <b>{m.name}</b>
                  <i>{m.tagline}</i>
                  <span className="dd-stamp-tags">
                    {m.tags.map((t) => (
                      <em key={t}>{t}</em>
                    ))}
                  </span>
                </span>
              </motion.button>
            ))}
          </div>
        </section>

        <section className="dd-features" aria-label="What is in the game">
          <div className="dd-feature">
            <span className="dd-feature-n">01</span>
            <h3>Draw first.</h3>
            <p>Five weapons, one katana that returns bullets, and a grapple you can switch off per match.</p>
          </div>
          <div className="dd-feature">
            <span className="dd-feature-n">02</span>
            <h3>Waves that escalate.</h3>
            <p>Every fifth wave brings a named boss. The arena does not get bigger — your aim has to.</p>
          </div>
          <div className="dd-feature">
            <span className="dd-feature-n">03</span>
            <h3>Three buried rooms.</h3>
            <p>Walk from the valley into the sanctuary and down into the tomb, or start in any of them.</p>
          </div>
          <div className="dd-feature">
            <span className="dd-feature-n">04</span>
            <h3>Friends, no server.</h3>
            <p>A four-letter code opens a direct WebRTC room. The host picks the map and the rules.</p>
          </div>
        </section>

        <footer className="dd-home-foot">
          <span>DOODLE SHOOTER · an original hand-drawn arena</span>
          <span className="dd-foot-links">
            <button type="button" onClick={() => setPanel("controls")}>CONTROLS</button>
            <button type="button" onClick={() => setPanel("about")}>CREDITS</button>
            <button type="button" onClick={() => setPanel("settings")}>SETTINGS</button>
          </span>
        </footer>
      </main>

      {panel && (
        <div className="dd-modal-wrap" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setPanel(null)}>
          <div className="dd-modal" role="dialog" aria-modal="true" aria-labelledby="dd-modal-title">
            <div className="dd-modal-head">
              <span className="dd-modal-tab">{panel === "settings" ? "SETTINGS" : panel === "controls" ? "CONTROLS" : "ABOUT"}</span>
              <button ref={closeRef} type="button" className="dd-modal-close" onClick={() => setPanel(null)} aria-label="Close dialog">
                <X className="size-5" />
              </button>
            </div>

            {panel === "settings" && (
              <>
                <h2 id="dd-modal-title">Tune the pencil.</h2>
                <p className="dd-modal-lede">Saved on this device. Match rules like the grappling hook are chosen on the next screen.</p>
                <div className="dd-setting-row">
                  <div>
                    <b>Look sensitivity</b>
                    <span>How far the view turns per mouse count.</span>
                  </div>
                  <input
                    type="range"
                    min={25}
                    max={250}
                    step={5}
                    value={sens}
                    aria-label="Look sensitivity"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSens(v);
                      localStorage.setItem("dd_sens", String(v));
                    }}
                  />
                  <em>{sens}%</em>
                </div>
                <div className="dd-setting-row">
                  <div>
                    <b>Invert vertical look</b>
                    <span>Push up to look down.</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={invert}
                    className={`dd-switch ${invert ? "on" : ""}`}
                    onClick={() => {
                      setInvert((v) => {
                        localStorage.setItem("dd_invert", v ? "0" : "1");
                        return !v;
                      });
                    }}
                  >
                    <span />
                  </button>
                </div>
                <div className="dd-setting-row">
                  <div>
                    <b>Audio</b>
                    <span>Procedural gunfire, doors and mummies.</span>
                  </div>
                  <button type="button" role="switch" aria-checked={sound} className={`dd-switch ${sound ? "on" : ""}`} onClick={toggleSound}>
                    <span />
                  </button>
                </div>
              </>
            )}

            {panel === "controls" && (
              <>
                <h2 id="dd-modal-title">Mouse + keyboard.</h2>
                <p className="dd-modal-lede">The game captures the mouse during play. Esc always hands it back.</p>
                <div className="dd-controls">
                  {CONTROL_GROUPS.map((g) => (
                    <div key={g.title} className="dd-controls-col">
                      <h3>{g.title}</h3>
                      {g.rows.map(([key, what]) => (
                        <div className="dd-control-row" key={key}>
                          <kbd>{key}</kbd>
                          <span>{what}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}

            {panel === "about" && (
              <>
                <h2 id="dd-modal-title">Ink, paper, and poor decisions.</h2>
                <p className="dd-modal-lede">
                  Doodle Shooter is an original hand-drawn survival shooter. The district, the three Egyptian
                  zones, the enemies and the weapons are all built from ink geometry in a custom Three.js
                  renderer — no imported art packs, no voxels.
                </p>
                <div className="dd-about-grid">
                  <div>
                    <b>THE VALLEY</b>
                    <span>Open desert, three pyramids, temple, sphinx, dry canyon. No coast, no sea.</span>
                  </div>
                  <div>
                    <b>THE SANCTUARY</b>
                    <span>Carved halls inside the great pyramid, with a concealed stair down.</span>
                  </div>
                  <div>
                    <b>THE TOMB</b>
                    <span>Sealed gates, pressure plates, spike pits and guardians that get up.</span>
                  </div>
                  <div>
                    <b>THE DISTRICT</b>
                    <span>The original street arena, kept exactly as it was.</span>
                  </div>
                </div>
                <p className="dd-credits">
                  Built with React, TypeScript, Three.js and WebRTC. Music and sound are synthesised live in the
                  browser. Best scores are stored locally.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

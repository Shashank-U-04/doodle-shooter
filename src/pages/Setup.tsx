// SCREEN TWO — battlefield and match configuration.
//
// The same screen feeds both flows: solo survival and the online lobby. The
// choice is written to sessionStorage as a *match* configuration (never to the
// permanent settings keys), so Back, a refresh or a shared URL all agree about
// which level and which grapple rule the next match uses.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Link2, Loader2, Radio, ShieldCheck, Zap } from "lucide-react";
import { MAPS, gameHref, mapInfo, normalizeMapId, readSetup, writeSetup, type GameMode, type MapId } from "@/game/maps";

const MAX_NAME = 16;

export default function Setup() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const initial = useMemo(() => readSetup(), []);

  const mode: GameMode = params.get("mode") === "friends" ? "friends" : params.get("mode") === "solo" ? "solo" : initial.mode;
  const map = normalizeMapId(params.get("map") ?? initial.map);
  const grappleParam = params.get("grapple");
  const grapple = grappleParam === "0" ? false : grappleParam === "1" ? true : initial.grapple;

  const [name, setName] = useState(() => initial.name || localStorage.getItem("dd_name") || "");
  const [code, setCode] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const info = mapInfo(map);

  // Every visible choice is mirrored into the URL and the match store. Only the
  // map/grapple/mode change here — the screen never starts a run by itself.
  useEffect(() => {
    writeSetup({ mode, map, grapple, name });
    const next = new URLSearchParams(params);
    next.set("mode", mode);
    next.set("map", map);
    next.set("grapple", grapple ? "1" : "0");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, map, grapple]);

  useEffect(() => {
    document.title = "Doodle Shooter — Choose your battlefield";
    return () => {
      document.title = "Doodle Shooter — A Scribbled Survival Shooter";
    };
  }, []);

  const pickMap = useCallback(
    (id: MapId) => {
      writeSetup({ map: id });
      const next = new URLSearchParams(params);
      next.set("map", id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const setGrapple = useCallback(
    (on: boolean) => {
      writeSetup({ grapple: on });
      const next = new URLSearchParams(params);
      next.set("grapple", on ? "1" : "0");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const setMode = useCallback(
    (nextMode: GameMode) => {
      writeSetup({ mode: nextMode });
      const next = new URLSearchParams(params);
      next.set("mode", nextMode);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const cleanName = name.trim().slice(0, MAX_NAME);

  const startSolo = () => {
    writeSetup({ mode: "solo", map, grapple });
    navigate(gameHref({ map, grapple }));
  };

  const createRoom = () => {
    setNameError(null);
    if (!cleanName) {
      setNameError("Pick a name first — your friends have to know who to blame.");
      return;
    }
    setCreating(true);
    localStorage.setItem("dd_name", cleanName);
    writeSetup({ mode: "friends", map, grapple, name: cleanName });
    navigate(`/online?create=1&map=${map}&grapple=${grapple ? 1 : 0}`);
  };

  const joinRoom = () => {
    setJoinError(null);
    const room = code.trim().toUpperCase();
    if (room.length < 3) {
      setJoinError("Enter the room code your friend sent you.");
      return;
    }
    if (!/^[A-Z0-9]+$/.test(room)) {
      setJoinError("Room codes use letters and numbers only.");
      return;
    }
    if (!cleanName) {
      setNameError("Pick a name before joining.");
      return;
    }
    localStorage.setItem("dd_name", cleanName);
    writeSetup({ mode: "friends", map, grapple, name: cleanName });
    navigate(`/online?code=${room}&map=${map}&grapple=${grapple ? 1 : 0}`);
  };

  return (
    <div className="dd-home dd-setup">
      <div className="dd-home-grain" aria-hidden="true" />

      <header className="dd-setup-nav">
        <button type="button" className="dd-back" onClick={() => navigate("/")}>
          <ArrowLeft className="size-4" /> TITLE SCREEN
        </button>
        <ol className="dd-steps" aria-label="Setup progress">
          <li className="done">
            <b>01</b> MODE
          </li>
          <li className="active">
            <b>02</b> BATTLEFIELD
          </li>
          <li>
            <b>03</b> MATCH
          </li>
        </ol>
        <div className="dd-mode-switch" role="group" aria-label="Game mode">
          <button type="button" aria-pressed={mode === "solo"} onClick={() => setMode("solo")}>
            VS COMPUTER
          </button>
          <button type="button" aria-pressed={mode === "friends"} onClick={() => setMode("friends")}>
            WITH FRIENDS
          </button>
        </div>
      </header>

      <main className="dd-setup-main">
        <motion.section
          className="dd-setup-head"
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div>
            <span className="dd-kicker dd-kicker--ink">STEP 02 · BATTLEFIELD</span>
            <h1>{mode === "solo" ? "Pick your battlefield." : "Set up the room."}</h1>
            <p>
              {mode === "solo"
                ? "Four real levels, all built from the same ink engine. The Ancient Egypt campaign is split into three maps — each one loads on its own."
                : "Choose the map and the rule, then open a room. The host's choice is the room's choice, and every player gets the same level and hook."}
            </p>
          </div>
          <div className={`dd-mode-badge dd-mode-badge--${mode}`}>
            {mode === "solo" ? <Zap className="size-4" /> : <Radio className="size-4" />}
            <span>{mode === "solo" ? "SINGLE PLAYER · VS COMPUTER" : "ONLINE · 1–4 PLAYERS"}</span>
          </div>
        </motion.section>

        <div className="dd-setup-grid">
          {/* ---------------- live preview ---------------- */}
          <section className="dd-preview" style={{ "--map-accent": info.accent } as React.CSSProperties} aria-live="polite">
            <div className="dd-preview-frame" key={info.id}>
              <img src={info.preview} alt={`${info.name} in-game preview`} />
              <div className="dd-preview-wash" />
              <span className="dd-preview-index">
                MAP {String(MAPS.findIndex((m) => m.id === info.id) + 1).padStart(2, "0")} / {String(MAPS.length).padStart(2, "0")}
              </span>
              <span className="dd-preview-load">
                <ShieldCheck className="size-3.5" /> DIRECT LOAD
              </span>
              <div className="dd-preview-caption">
                <span className="dd-kicker">{info.zone ? "ANCIENT EGYPT" : "DOODLE DISTRICT"}</span>
                <h2>{info.name}</h2>
                <i>{info.tagline}</i>
              </div>
            </div>
            <div className="dd-preview-info">
              <div className="dd-preview-tags">
                {info.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <p>{info.description}</p>
              <dl className="dd-preview-facts">
                <div>
                  <dt>LOADING</dt>
                  <dd>{info.zone ? `Starts in the ${info.zone === "surface" ? "valley" : info.zone}` : "Street level"}</dd>
                </div>
                <div>
                  <dt>ON THE MAP</dt>
                  <dd>{info.hostility}</dd>
                </div>
                <div>
                  <dt>MODE</dt>
                  <dd>{mode === "solo" ? "Wave survival + bosses" : "Free-for-all · host rules"}</dd>
                </div>
              </dl>
            </div>
          </section>

          {/* ---------------- map cards ---------------- */}
          <section className="dd-map-list" role="radiogroup" aria-label="Battlefield">
            <div className="dd-map-list-head">
              <h2>BATTLEFIELDS</h2>
              <span>{MAPS.length} SELECTABLE</span>
            </div>
            {MAPS.map((m, i) => {
              const selected = m.id === map;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`dd-map-card ${selected ? "on" : ""}`}
                  style={{ "--map-accent": m.accent } as React.CSSProperties}
                  onClick={() => pickMap(m.id)}
                >
                  <span className="dd-map-thumb">
                    <img src={m.preview} alt="" loading="lazy" />
                  </span>
                  <span className="dd-map-copy">
                    <span className="dd-map-num">{String(i + 1).padStart(2, "0")}</span>
                    <b>{m.name}</b>
                    <i>{m.tagline}</i>
                    <span className="dd-map-tags">{m.tags.join(" · ")}</span>
                  </span>
                  <span className={`dd-map-check ${selected ? "on" : ""}`} aria-hidden="true">
                    {selected ? <Check className="size-4" /> : <ArrowRight className="size-4" />}
                  </span>
                </button>
              );
            })}
          </section>
        </div>

        {/* ---------------- match settings + CTA ---------------- */}
        <section className="dd-matchbar">
          <div className="dd-matchsettings">
            <div className="dd-matchsettings-head">
              <span className="dd-kicker dd-kicker--ink">MATCH RULES</span>
              <span className={`dd-rule-chip ${grapple ? "on" : ""}`}>
                <Link2 className="size-3.5" /> GRAPPLE {grapple ? "ON" : "OFF"}
              </span>
            </div>

            <div className="dd-grapple">
              <div className="dd-grapple-copy">
                <b>GRAPPLING HOOK</b>
                <span>
                  A 34 m ink hook, bound to <kbd>Q</kbd>/<kbd>E</kbd> (or middle click). Reel in, swing, let go.
                  Turn it off for a pure movement match.
                </span>
              </div>
              <div className="dd-segment" role="group" aria-label="Grappling hook">
                <button type="button" aria-pressed={grapple} onClick={() => setGrapple(true)}>
                  ENABLED
                </button>
                <button type="button" aria-pressed={!grapple} onClick={() => setGrapple(false)}>
                  DISABLED
                </button>
              </div>
            </div>

            <p className="dd-rule-note">
              {mode === "friends"
                ? "The host's rule is authoritative: it is broadcast to the room and enforced by every client's movement code, not just hidden in the UI."
                : "This is a match setting, not a permanent preference. Your next run can choose differently — and no pickup can grant a disabled hook."}
            </p>
          </div>

          <div className="dd-setup-cta">
            {mode === "solo" ? (
              <>
                <span className="dd-cta-label">READY WHEN YOU ARE</span>
                <div className="dd-cta-summary">
                  <b>{info.name}</b>
                  <span>
                    {grapple ? "Grapple enabled" : "Grapple disabled"} · survival
                  </span>
                </div>
                <button type="button" className="dd-primary" onClick={startSolo}>
                  START MATCH <ArrowRight className="size-5" />
                </button>
                <p className="dd-cta-foot">Esc pauses · P hands the mouse back</p>
              </>
            ) : (
              <>
                <label className="dd-name-field">
                  <span>YOUR DOODLE NAME</span>
                  <input
                    value={name}
                    maxLength={MAX_NAME}
                    placeholder="doodler"
                    onChange={(e) => {
                      setName(e.target.value);
                      writeSetup({ name: e.target.value });
                      setNameError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && createRoom()}
                  />
                </label>
                {nameError && <p className="dd-form-error">{nameError}</p>}
                <button type="button" className="dd-primary" onClick={createRoom} disabled={creating}>
                  {creating ? <Loader2 className="size-5 animate-spin" /> : <Radio className="size-5" />} CREATE ROOM
                </button>

                <div className="dd-or">
                  <span /> OR JOIN A ROOM <span />
                </div>
                <div className="dd-join-row">
                  <input
                    className="dd-code-input"
                    value={code}
                    maxLength={6}
                    placeholder="CODE"
                    aria-label="Room code"
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                      setJoinError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                  />
                  <button type="button" className="dd-secondary" onClick={joinRoom}>
                    JOIN
                  </button>
                </div>
                {joinError && <p className="dd-form-error">{joinError}</p>}
                <p className="dd-cta-foot">
                  You set the map and rule now; the lobby confirms them with everyone before the host starts.
                </p>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="dd-setup-foot">
        <span>
          <Check className="size-3.5" /> No download · runs in your browser
        </span>
        <span>Need an invite link? The lobby can copy one for you.</span>
      </footer>
    </div>
  );
}

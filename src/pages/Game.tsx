import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createGame } from "@/game/engine";
import type { GameHandle } from "@/game/types";
import type { GameOverStats, HudState } from "@/game/types";

const EMPTY_HUD: HudState = {
  score: 0,
  combo: "",
  wave: 0,
  left: 0,
  modifier: "",
  hp: 120,
  maxHp: 120,
  mag: -1,
  reserve: -1,
  reloading: false,
  nades: 0,
  weapon: "RIFLE",
  hint: "",
  slots: [],
  slot: 0,
  focus: 0,
  focusOn: false,
  blips: [],
};

type Overlay =
  | { kind: "menu" }
  | { kind: "paused"; wave: number; score: number }
  | { kind: "over"; stats: GameOverStats };

const CONTROLS: [string, string][] = [
  ["WASD", "move"],
  ["Mouse", "look"],
  ["LMB", "fire / slash"],
  ["RMB", "aim · block (katana)"],
  ["Space", "jump · double jump"],
  ["Shift", "sprint"],
  ["C / Ctrl", "crouch"],
  ["R", "reload"],
  ["1–5 / wheel", "weapons"],
  ["Q / E", "grapple (hold to reel)"],
  ["F", "focus dash · slash"],
  ["G", "grenade"],
  ["X", "dash"],
  ["P / Esc", "pause"],
  ["M", "sound"],
];

export default function Game() {
  const navigate = useNavigate();
  const stageRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "menu" });
  const [message, setMessage] = useState<{ t: string; s: string | null } | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [feed, setFeed] = useState<{ id: number; text: string; hot: boolean }[]>([]);
  const [hitmarker, setHitmarker] = useState(0);
  const [boss, setBoss] = useState<{ name: string; frac: number } | null>(null);
  const [ads, setAds] = useState(false);
  const [sens, setSens] = useState(() => Number(localStorage.getItem("dd_sens") || 100));
  const [invert, setInvert] = useState(() => localStorage.getItem("dd_invert") === "1");
  const [sound, setSound] = useState(() => localStorage.getItem("dd_music") !== "0");
  const [best, setBest] = useState(() => Number(localStorage.getItem("dd_best") || 0));
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockBlocked, setLockBlocked] = useState(false);

  // track pointer lock so we can prompt when the browser refused to recapture it
  useEffect(() => {
    const onPlc = () => setLocked(document.pointerLockElement !== null);
    document.addEventListener("pointerlockchange", onPlc);
    onPlc();
    return () => document.removeEventListener("pointerlockchange", onPlc);
  }, []);

  const msgTimer = useRef<number | null>(null);
  const tipTimer = useRef<number | null>(null);
  const feedId = useRef(0);

  useEffect(() => {
    if (!stageRef.current) return;
    const host = stageRef.current;
    let disposed = false;
    let lastFeed = 0;

    const handle = createGame(host, {
      onHud: (h) => setHud(h),
      onMessage: (t, s) => {
        setMessage({ t, s });
        if (msgTimer.current) window.clearTimeout(msgTimer.current);
        msgTimer.current = window.setTimeout(() => setMessage(null), 2600);
      },
      onTip: (text, dur) => {
        setTip(text);
        if (tipTimer.current) window.clearTimeout(tipTimer.current);
        tipTimer.current = window.setTimeout(() => setTip(null), Math.min(dur, 8) * 1000);
      },
      onKillFeed: (text, hot) => {
        const id = ++feedId.current;
        setFeed((f) => [...f.slice(-5), { id, text, hot }]);
        lastFeed = id;
        window.setTimeout(() => {
          setFeed((f) => f.filter((x) => x.id !== lastFeed));
        }, 3800);
      },
      onHitmarker: (kill) => {
        setHitmarker((n) => n + 1);
        void kill;
      },
      onBoss: (name, frac) => setBoss(name ? { name, frac } : null),
      onGameOver: (stats) => {
        setOverlay({ kind: "over", stats });
        if (stats.best) setBest(stats.score);
      },
      onPause: (s) => setOverlay({ kind: "paused", wave: s.wave, score: s.score }),
      onResume: () => setOverlay({ kind: "menu" }),
      onLockChange: (l, blocked) => {
        setLocked(l);
        setLockBlocked(blocked);
      },
      onAim: (a) => setAds(a),
    });

    if (disposed) {
      handle.dispose();
      return;
    }
    gameRef.current = handle;
    handle.setSensitivity(sens);
    handle.setInvert(invert);
    handle.setMusic(sound);
    setReady(true);
    // arriving from the title screen's START: begin the run straight away
    handle.start();

    return () => {
      disposed = true;
      handle.dispose();
      gameRef.current = null;
      if (msgTimer.current) window.clearTimeout(msgTimer.current);
      if (tipTimer.current) window.clearTimeout(tipTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pause on tab-away handled by engine; Escape opens pause overlay through onPause
  const start = useCallback(() => {
    setOverlay({ kind: "menu" });
    gameRef.current?.start();
  }, []);
  // resume() hands control back immediately (and asks for the mouse; if the
  // browser refuses, the hint appears and the next click retries).
  const resume = useCallback(() => {
    gameRef.current?.resume();
  }, []);
  const restart = useCallback(() => {
    setOverlay({ kind: "menu" });
    gameRef.current?.restart();
  }, []);
  // MAIN MENU goes back to the title screen (the same menu the reference shows).
  const toMenu = useCallback(() => {
    gameRef.current?.toMenu();
    navigate("/");
  }, [navigate]);

  // Live play only: a tip, the wave banner or the "grab the mouse" prompt is
  // never drawn while a panel is up, so no stale line can sit over a menu.
  const live = overlay.kind === "menu" && hud.wave > 0;
  const hpFrac = Math.max(0, hud.hp / hud.maxHp);

  return (
    <div className="dd-root">
      <div ref={stageRef} className="dd-stage absolute inset-0" />

      {/* HUD */}
      <div className="dd-hud" style={{ visibility: overlay.kind === "menu" && hud.wave === 0 ? "hidden" : "visible" }}>
        <div className={`dd-crosshair ${hud.weapon === "KATANA" ? "katana" : ""} ${ads ? "ads" : ""}`} style={{ display: overlay.kind === "menu" && hud.wave > 0 ? undefined : "none" }}>
          <i className="ch-t" />
          <i className="ch-b" />
          <i className="ch-l" />
          <i className="ch-r" />
          <i className="ch-dot" />
        </div>

        {/* aiming down sights: every weapon shows a reticle while scoped */}
        {ads && overlay.kind === "menu" && hud.wave > 0 && (
          <div className={`dd-aim ${hud.weapon === "KATANA" ? "katana" : ""} ${hud.weapon === "SNIPER" ? "scope" : ""}`}>
            <i className="a-ring" />
            <i className="a-t" />
            <i className="a-b" />
            <i className="a-l" />
            <i className="a-r" />
            <i className="a-dot" />
          </div>
        )}

        <div className={`dd-hitmarker ${hitmarker > 0 ? "show" : ""}`} key={hitmarker}>
          <i />
          <i />
          <i />
          <i />
        </div>

        <div className="dd-hud-tl">
          <div className="score">
            SCORE <b>{hud.score}</b>
          </div>
          <div className="combo">{hud.combo}</div>
        </div>

        <div className="dd-hud-tr">
          <div className="wave">WAVE <b>{hud.wave}</b></div>
          <div className="modifier">{hud.modifier}</div>
          <div className="left">
            <b>{hud.left}</b> enemies left
          </div>

          {/* minimap: up is where you are looking */}
          <div className="minimap">
            <div className="mm-cross" />
            <div className="mm-me" />
            {hud.blips.map((b, i) => (
              <span
                key={i}
                className={`mm-blip${b.boss ? " boss" : ""}`}
                style={{ left: `${50 + b.x * 45}%`, top: `${50 + b.z * 45}%` }}
              />
            ))}
          </div>
        </div>

        <div className={`dd-bossbar ${boss ? "" : "hidden"}`}>
          <div className="bossname">{boss ? boss.name : ""}</div>
          <div className="bar big">
            <div className="fill red" style={{ width: `${boss ? Math.max(0, boss.frac * 100) : 0}%` }} />
          </div>
        </div>

        <div className="dd-killfeed">
          {feed.map((f) => (
            <div key={f.id} className={`kf ${f.hot ? "hot" : ""}`}>
              {f.text}
            </div>
          ))}
        </div>

        {message && live && (
          <div className="dd-msg">
            <div className="t">{message.t}</div>
            {message.s && <div className="sub">{message.s}</div>}
          </div>
        )}

        {tip && live && (
          <div className="dd-tip" dangerouslySetInnerHTML={{ __html: tip }} />
        )}

        <div className="dd-hud-bl">
          <div className="health">
            <span>HP</span>
            <div className="bar">
              <div className="fill" style={{ width: `${hpFrac * 100}%`, background: hpFrac < 0.3 ? "#b32b3a" : "#3947b8" }} />
            </div>
            <span className="hpnum">{hud.hp}</span>
          </div>
          {hud.weapon === "KATANA" && (
            <div className="dd-focusmeter">
              <span>KATANA</span>
              <div className="bar">
                <div className={`fill ${hud.focusOn ? "ready" : ""}`} style={{ width: `${hud.focusOn ? 100 : hud.focus * 100}%` }} />
              </div>
            </div>
          )}
          <div className="ammo">
            <b>{hud.mag < 0 ? "∞" : hud.mag}</b>
            {hud.reserve >= 0 && <span className="reserve">/ {hud.reserve}</span>}
            {hud.reloading && <span className="reloading">reloading…</span>}
            <span className="nades">✳ {hud.nades}</span>
          </div>
        </div>

        <div className="dd-hud-br">
          <div className="slots">
            {hud.slots.map((name, i) => (
              <span key={name} className={`slot ${i === hud.slot ? "on" : ""}`}>
                <span className="num">{i + 1}</span>
                {name}
              </span>
            ))}
          </div>
          <div className="weapon">{hud.weapon}</div>
          <div className="hint">{hud.hint}</div>
        </div>
      </div>

      {/* Overlays */}
      {overlay.kind === "menu" && hud.wave === 0 && (
        <div className="dd-screen">
          <div className="panel">
            <h1>DOODLE DISTRICT</h1>
            <h2>a scribbled survival shooter</h2>
            <div className="mainbtns">
              <button type="button" className="start" onClick={start} disabled={!ready}>
                START<i>solo · survive the waves</i>
              </button>
            </div>
            <div className="cols">
              <div>
                <div className="colhead">MOUSE + KEYBOARD</div>
                {CONTROLS.map(([k, v]) => (
                  <div key={k}>
                    <b>{k}</b> {v}
                  </div>
                ))}
              </div>
            </div>

            <div className="settings">
              <label>
                look sensitivity
                <input
                  type="range"
                  min={25}
                  max={250}
                  step={5}
                  value={sens}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSens(v);
                    localStorage.setItem("dd_sens", String(v));
                    gameRef.current?.setSensitivity(v);
                  }}
                />
                <b>{sens}%</b>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={invert}
                  onChange={(e) => {
                    setInvert(e.target.checked);
                    localStorage.setItem("dd_invert", e.target.checked ? "1" : "0");
                    gameRef.current?.setInvert(e.target.checked);
                  }}
                />
                invert vertical look
              </label>
              <label>
                music
                <input
                  type="checkbox"
                  checked={sound}
                  onChange={(e) => {
                    setSound(e.target.checked);
                    localStorage.setItem("dd_music", e.target.checked ? "1" : "0");
                    gameRef.current?.setMusic(e.target.checked);
                  }}
                />
                <span className="k">(M)</span>
              </label>
            </div>
            {best > 0 && <div className="beststat">best score: {best}</div>}
            <div className="go">CLICK START — the mouse will be captured</div>
          </div>
        </div>
      )}

      {/* The mouse can only be granted on a real click, so while it is loose a
          line of text asks for one — the same centred tip the original uses. It
          never covers the view or takes a click, and it disappears the moment
          the mouse is captured. */}
      {live && !locked && (
        <div className="dd-tip show">
          {lockBlocked ? (
            <>
              <b>click</b>, or hold a mouse button and <b>drag to look</b>
            </>
          ) : (
            <>
              <b>click</b> or <b>press any key</b> to grab the mouse
            </>
          )}
        </div>
      )}

      {overlay.kind === "paused" && (
        <div className="dd-screen">
          <div className="panel">
            <h1>PAUSED</h1>
            <h2>wave {overlay.wave} · score {overlay.score}</h2>
            <div className="mainbtns">
              <button type="button" className="start" onClick={resume}>
                RESUME<i>click to recapture the mouse</i>
              </button>
              <button type="button" onClick={restart}>
                RESTART RUN
              </button>
              <button type="button" className="alt" onClick={toMenu}>
                MAIN MENU
              </button>
            </div>
          </div>
        </div>
      )}

      {overlay.kind === "over" && (
        <div className="dd-screen">
          <div className="panel">
            <h1>ERASED</h1>
            <div className="stats">
              you survived <b>{overlay.stats.wave}</b> wave{overlay.stats.wave === 1 ? "" : "s"} · <b>{overlay.stats.kills}</b> kills · score{" "}
              <b>{overlay.stats.score}</b>
              {overlay.stats.best ? " · NEW BEST" : ` · best ${best}`}
            </div>
            <div className="mainbtns">
              <button type="button" className="start" onClick={restart}>
                DRAW AGAIN
              </button>
              <button type="button" className="alt" onClick={toMenu}>
                MAIN MENU
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

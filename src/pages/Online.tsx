// PLAY WITH FRIENDS — the room, the rules, and the free-for-all.
//
// The map and grapple rule are chosen on /setup and travel here in the URL and
// the match store. The host owns both: changing them in the lobby broadcasts a
// config packet, guests mirror it, and the start packet repeats it so a late
// joiner still builds the same level. The engine is constructed with exactly
// that config, which is what makes the toggle more than decoration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Link2,
  Loader2,
  LogOut,
  Radio,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { createGame } from "@/game/engine";
import { EMPTY_HUD, type GameHandle, type HudState, type NetPlayerState } from "@/game/types";
import { INK_HEX } from "@/game/world";
import {
  MAPS,
  mapInfo,
  normalizeMapId,
  normalizeMatchConfig,
  readSetup,
  writeSetup,
  type MapId,
  type MatchConfig,
} from "@/game/maps";
import { NetSession, makeRoomCode, type NetPlayer } from "@/game/net";

const KILLS_TO_WIN = 15;
const INK_LIST = Object.values(INK_HEX).filter((v): v is string => typeof v === "string");
const MAX_NAME = 16;

type Phase = "lobby" | "playing";

export default function Online() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [params] = useSearchParams();
  const setup = useMemo(() => readSetup(), []);

  const [session, setSession] = useState<NetSession | null>(null);
  const [config, setConfig] = useState<MatchConfig>(() =>
    normalizeMatchConfig({
      map: normalizeMapId(params.get("map") ?? setup.map),
      grapple: params.get("grapple") === null ? setup.grapple : params.get("grapple") === "1",
    }),
  );
  const [name, setName] = useState(() => setup.name || localStorage.getItem("dd_name") || "");
  const [codeInput, setCodeInput] = useState("");
  const [players, setPlayers] = useState<NetPlayer[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [created, setCreated] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const ref = useRef<NetSession | null>(null);
  const copyTimer = useRef<number | null>(null);

  const remember = useCallback((v: string) => {
    setName(v);
    writeSetup({ name: v });
  }, []);

  const wire = useCallback((s: NetSession) => {
    s.setHandlers({
      onStatus: (t) => setStatus(t),
      onError: (t) => setError(t),
      onFeed: (t) => setStatus(t),
      onChange: () => setPlayers(s.getPlayers()),
      onConfig: (cfg) => setConfig(cfg),
    });
  }, []);

  const openRoom = useCallback(
    (nick: string, cfg: MatchConfig) => {
      const s = new NetSession(makeRoomCode(), nick, true, cfg);
      wire(s);
      s.connect();
      ref.current = s;
      setSession(s);
      setPlayers(s.getPlayers());
      setConfig(cfg);
      setError(null);
      setStatus("Opening your room…");
      setCreated(true);
      window.setTimeout(() => setCreated(false), 2600);
    },
    [wire],
  );

  const connectTo = useCallback(
    (rawCode: string, nick: string, cfg: MatchConfig) => {
      const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length < 3) {
        setError("Enter the code your friend sent you.");
        return;
      }
      if (!nick.trim()) {
        setError("Pick a name before joining.");
        return;
      }
      const s = new NetSession(code, nick, false, cfg);
      wire(s);
      s.connect();
      ref.current = s;
      setSession(s);
      setPlayers(s.getPlayers());
      setError(null);
      setStatus("Finding the room…");
    },
    [wire],
  );

  // Arriving from /setup: create or join automatically, once per mount. The
  // timer keeps React StrictMode's mount → cleanup → mount cycle from opening
  // a room that the cleanup has already torn down.
  useEffect(() => {
    const wantsCreate = params.get("create") === "1";
    const wantsCode = params.get("code");
    if (!wantsCreate && !wantsCode) return;
    const t = window.setTimeout(() => {
      const nick = (name.trim() || localStorage.getItem("dd_name") || "").slice(0, MAX_NAME);
      if (!nick) {
        setError("Pick a name on the setup screen first.");
        return;
      }
      if (wantsCreate) openRoom(nick, config);
      else connectTo(wantsCode!, nick, config);
    }, 0);
    return () => window.clearTimeout(t);
    // Intentionally mount-only: these are the initial URL choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A session must never outlive the page that owns it.
  useEffect(() => () => ref.current?.close(), []);

  // Lobby-level handlers. PvpMatch replaces onStart when it mounts, which is
  // exactly when a rematch should restart the engine instead of the page.
  useEffect(() => {
    if (!session) return;
    session.setHandlers({
      onChange: () => setPlayers(session.getPlayers()),
      onConfig: (cfg) => {
        setConfig(cfg);
        writeSetup(cfg);
      },
      onStart: (cfg) => {
        if (cfg) setConfig(cfg);
        setPhase("playing");
      },
    });
  }, [session]);

  const leaveRoom = useCallback(
    (toSetup = true) => {
      ref.current?.close();
      ref.current = null;
      setSession(null);
      setPlayers([]);
      setStatus("");
      setError(null);
      setPhase("lobby");
      if (toSetup) navigate(`/setup?mode=friends&map=${config.map}`);
    },
    [config.map, navigate],
  );

  const createFromGate = () => {
    const nick = name.trim().slice(0, MAX_NAME);
    if (!nick) {
      setError("Pick a name first — your friends have to know who to blame.");
      return;
    }
    localStorage.setItem("dd_name", nick);
    openRoom(nick, config);
  };

  const joinFromGate = () => {
    const nick = name.trim().slice(0, MAX_NAME);
    if (!nick) {
      setError("Pick a name before joining.");
      return;
    }
    if (codeInput.trim().length < 3) {
      setJoinError("Enter the room code your friend sent you.");
      return;
    }
    localStorage.setItem("dd_name", nick);
    connectTo(codeInput, nick, config);
  };

  const chooseMap = (id: MapId) => {
    if (!session?.isHost) return;
    const next = { ...config, map: id };
    setConfig(next);
    writeSetup(next);
    session.setConfig(next);
  };

  const chooseGrapple = (on: boolean) => {
    if (!session?.isHost) return;
    const next = { ...config, grapple: on };
    setConfig(next);
    writeSetup(next);
    session.setConfig(next);
  };

  const copy = (what: "code" | "link") => {
    const text = what === "code" ? session?.code ?? "" : `${window.location.origin}/online?code=${session?.code ?? ""}`;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(what);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1700);
  };

  const me = players.find((p) => p.isMe);
  const guests = players.filter((p) => !p.isHost);
  const allReady = guests.every((p) => p.ready);
  const info = mapInfo(config.map);

  if (phase === "playing" && session) {
    return <PvpMatch session={session} onLeave={() => leaveRoom(true)} />;
  }

  return (
    <div className="dd-home dd-lobby">
      <div className="dd-home-grain" aria-hidden="true" />

      <header className="dd-setup-nav">
        <button type="button" className="dd-back" onClick={() => leaveRoom(true)}>
          <ArrowLeft className="size-4" /> SETUP
        </button>
        <ol className="dd-steps" aria-label="Setup progress">
          <li className="done">
            <b>01</b> MODE
          </li>
          <li className="done">
            <b>02</b> BATTLEFIELD
          </li>
          <li className="active">
            <b>03</b> LOBBY
          </li>
        </ol>
        <div className="dd-lobby-state">
          <span className={`dd-live-dot ${session ? "on" : ""}`} />
          {session ? (session.isHost ? "HOSTING" : "CONNECTED") : "NOT IN A ROOM"}
        </div>
      </header>

      <main className="dd-lobby-main">
        {!session && (
          <motion.section
            className="dd-gate"
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
          >
            <div className="dd-gate-art">
              <img src={info.preview} alt={`${info.name} preview`} />
              <div className="dd-gate-wash" />
              <span className="dd-preview-index">YOUR ROOM'S MAP</span>
              <div className="dd-gate-mapname">
                <span className="dd-kicker">{info.zone ? "ANCIENT EGYPT" : "DOODLE DISTRICT"}</span>
                <h2>{info.name}</h2>
                <i>{grappleLabel(config.grapple)}</i>
              </div>
            </div>
            <div className="dd-gate-form">
              <span className="dd-kicker dd-kicker--ink">OPEN A ROOM</span>
              <h1>Who's holding the marker?</h1>
              <p>Pick a name, then open a room or type the code your friend gave you. Up to four players.</p>
              <label className="dd-name-field">
                <span>YOUR DOODLE NAME</span>
                <input
                  value={name}
                  maxLength={MAX_NAME}
                  placeholder="doodler"
                  onChange={(e) => {
                    remember(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && createFromGate()}
                />
              </label>
              <button type="button" className="dd-primary" onClick={createFromGate}>
                <Radio className="size-5" /> CREATE ROOM
              </button>
              <div className="dd-or">
                <span /> OR JOIN A ROOM <span />
              </div>
              <div className="dd-join-row">
                <input
                  className="dd-code-input"
                  value={codeInput}
                  maxLength={6}
                  placeholder="CODE"
                  aria-label="Room code"
                  onChange={(e) => {
                    setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                    setJoinError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && joinFromGate()}
                />
                <button type="button" className="dd-secondary" onClick={joinFromGate}>
                  JOIN
                </button>
              </div>
              {joinError && <p className="dd-form-error">{joinError}</p>}
              {error && <p className="dd-form-error">{error}</p>}
              <p className="dd-cta-foot">
                Rooms are peer-to-peer. Both players need a modern browser and a network that lets WebRTC through —
                a TURN relay may be needed across two mobile networks.
              </p>
            </div>
          </motion.section>
        )}

        {session && (
          <div className="dd-lobby-grid">
            <section className="dd-lobby-left">
              <AnimatePresence>
                {created && (
                  <motion.div
                    className="dd-celebrate"
                    initial={reduce ? false : { opacity: 0, scale: 0.7, rotate: -8 }}
                    animate={reduce ? undefined : { opacity: 1, scale: 1, rotate: -2 }}
                    exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                  >
                    <Sparkles className="size-5" /> ROOM OPEN
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="dd-roomcode-card">
                <span className="dd-kicker">ROOM CODE</span>
                <div className="dd-netcode" aria-label={`Room code ${session.code}`}>
                  {session.code}
                </div>
                <div className="dd-room-actions">
                  <button type="button" className="dd-secondary" onClick={() => copy("code")}>
                    {copied === "code" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied === "code" ? "COPIED" : "COPY CODE"}
                  </button>
                  <button type="button" className="dd-secondary" onClick={() => copy("link")}>
                    {copied === "link" ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                    {copied === "link" ? "COPIED" : "COPY INVITE"}
                  </button>
                </div>
                <p className="dd-room-hint">
                  {session.isHost ? "Send this to your friends. They join from the title screen or with the invite link." : "You're in. Wait for the host to start, or toggle ready."}
                </p>
              </div>

              <div className="dd-roommap">
                <div className="dd-roommap-frame">
                  <img src={info.preview} alt={`${info.name} preview`} />
                  <div className="dd-roommap-wash" />
                  <div className="dd-roommap-name">
                    <span className="dd-kicker">{session.isHost ? "HOST'S PICK" : "HOST'S MAP"}</span>
                    <b>{info.name}</b>
                    <i>{config.grapple ? "GRAPPLING HOOK ENABLED" : "GRAPPLING HOOK DISABLED"}</i>
                  </div>
                </div>

                <div className="dd-roommap-picks" role="group" aria-label="Choose a map">
                  {MAPS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`dd-minimap ${m.id === config.map ? "on" : ""}`}
                      aria-pressed={m.id === config.map}
                      disabled={!session.isHost}
                      onClick={() => chooseMap(m.id)}
                      title={m.name}
                    >
                      <img src={m.preview} alt="" />
                      <span>{m.name.replace("THE ", "")}</span>
                    </button>
                  ))}
                </div>
                {!session.isHost && <p className="dd-locknote">Only the host can change the battlefield.</p>}

                <div className="dd-roomrule">
                  <div>
                    <b>
                      <Link2 className="size-4" /> GRAPPLING HOOK
                    </b>
                    <span>
                      {session.isHost
                        ? "Applies to every player the moment you save it."
                        : "The host controls this rule for the whole room."}
                    </span>
                  </div>
                  <div className="dd-segment" role="group" aria-label="Grappling hook">
                    <button type="button" aria-pressed={config.grapple} disabled={!session.isHost} onClick={() => chooseGrapple(true)}>
                      ENABLED
                    </button>
                    <button type="button" aria-pressed={!config.grapple} disabled={!session.isHost} onClick={() => chooseGrapple(false)}>
                      DISABLED
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="dd-lobby-right">
              <div className="dd-roster-head">
                <div>
                  <span className="dd-kicker dd-kicker--ink">IN THE ROOM</span>
                  <h2>
                    {players.length} / 4 <span>players</span>
                  </h2>
                </div>
                <span className={`dd-ready-chip ${allReady ? "on" : ""}`}>
                  {allReady ? "ALL READY" : `${guests.filter((g) => g.ready).length}/${guests.length} READY`}
                </span>
              </div>

              <div className="dd-roster">
                {players.length === 0 && (
                  <div className="dd-roster-empty">
                    <Loader2 className="size-5 animate-spin" />
                    {status || "Waiting for the broker…"}
                  </div>
                )}
                {players.map((p) => (
                  <div className={`dd-roster-row ${p.ready || p.isHost ? "ready" : ""}`} key={p.id}>
                    <span className="dot" style={{ color: INK_LIST[p.ink % INK_LIST.length] }} />
                    <span className="nm">
                      {p.name}
                      {p.isMe ? " (you)" : ""}
                    </span>
                    {p.isHost && (
                      <span className="dd-host-tag">
                        <Crown className="size-3.5" /> HOST
                      </span>
                    )}
                    <span className={`dd-ready-badge ${p.ready || p.isHost ? "on" : ""}`}>
                      {p.ready || p.isHost ? <Check className="size-3.5" /> : null}
                      {p.ready || p.isHost ? "READY" : "WAITING"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="dd-lobby-status" aria-live="polite">
                <span className={`dd-live-dot ${session.phase === "lobby" ? "on" : ""}`} />
                {status || (session.isHost ? "Share the code and wait for your friends." : "Connected — waiting for the host.")}
              </div>
              {error && (
                <div className="dd-neterr">
                  {error}
                  <button type="button" className="dd-neterr-retry" onClick={() => leaveRoom(true)}>
                    BACK TO SETUP
                  </button>
                </div>
              )}

              <div className="dd-lobby-actions">
                {session.isHost ? (
                  <button type="button" className="dd-primary" disabled={!allReady} onClick={() => session.beginMatch()}>
                    <ShieldCheck className="size-5" />
                    {allReady ? `START MATCH${guests.length ? ` · ${guests.length} FRIEND${guests.length === 1 ? "" : "S"}` : ""}` : "WAITING FOR READY"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`dd-ready-toggle ${me?.ready ? "on" : ""}`}
                    onClick={() => session.setReady(!me?.ready)}
                  >
                    <Check className="size-5" /> {me?.ready ? "READY — TAP TO UNREADY" : "I'M READY"}
                  </button>
                )}
                <button type="button" className="dd-secondary dd-leave" onClick={() => leaveRoom(true)}>
                  <LogOut className="size-3.5" /> LEAVE ROOM
                </button>
              </div>

              <div className="dd-lobby-facts">
                <div>
                  <b>MAP</b>
                  <span>{info.name}</span>
                </div>
                <div>
                  <b>RULES</b>
                  <span>Free-for-all · first to {KILLS_TO_WIN} kills</span>
                </div>
                <div>
                  <b>HOOK</b>
                  <span>{config.grapple ? "Enabled" : "Disabled"}</span>
                </div>
                <div>
                  <b>CONNECTION</b>
                  <span>{session.isHost ? "Host · relays the room" : "Guest · direct to host"}</span>
                </div>
              </div>

              <div className="dd-lobby-note">
                <UserPlus className="size-4" />
                <span>
                  {session.isHost
                    ? "Friends can join with the code at any time before the start. Late joiners receive these exact rules."
                    : "You can join mid-match — the host's current rules come with the start packet."}
                </span>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function grappleLabel(on: boolean) {
  return on ? "Grappling hook enabled · peer-to-peer" : "Grappling hook disabled · peer-to-peer";
}

/* ======================================================================== *
 * the arena
 * ======================================================================== */

function PvpMatch({ session, onLeave }: { session: NetSession; onLeave: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  const remotes = useRef(new Map<string, NetPlayerState>());
  const feedId = useRef(0);
  const msgTimer = useRef<number | null>(null);
  const tipTimer = useRef<number | null>(null);
  const winnerRef = useRef(false);
  const respawnTimer = useRef<number | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [players, setPlayers] = useState<NetPlayer[]>(() => session.getPlayers());
  const [feed, setFeed] = useState<{ id: number; text: string; hot: boolean }[]>([]);
  const [message, setMessage] = useState<{ t: string; s: string | null } | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [hitmarker, setHitmarker] = useState(0);
  const [ads, setAds] = useState(false);
  const [paused, setPaused] = useState(false);
  const [down, setDown] = useState(false);
  const config = session.getConfig();
  const info = mapInfo(config.map);

  const pushFeed = useCallback((text: string, hot: boolean) => {
    const id = ++feedId.current;
    setFeed((f) => [...f.slice(-5), { id, text, hot }]);
    window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 3800);
  }, []);

  const resetRound = useCallback(() => {
    if (respawnTimer.current) {
      window.clearTimeout(respawnTimer.current);
      respawnTimer.current = null;
    }
    winnerRef.current = false;
    setDown(false);
    setPaused(false);
    remotes.current.clear();
    const handle = gameRef.current;
    if (!handle) return;
    handle.setRemotePlayers([]);
    handle.start();
    handle.netRespawn(session.getPlayers().find((p) => p.isMe)?.ink ?? 0);
    session.reportRespawn(handle.netState().epoch);
  }, [session]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;

    // The match is built with the host's rules, not with whatever this browser
    // last had selected: `config` came from the config/start packet.
    const handle = createGame(
      host,
      {
        onHud: setHud,
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
        onKillFeed: pushFeed,
        onHitmarker: () => setHitmarker((n) => n + 1),
        onBoss: () => {},
        onGameOver: () => {},
        onPause: () => setPaused(true),
        onResume: () => setPaused(false),
        onAim: setAds,
        onNetHit: (hit) => session.reportHit(hit.victim, hit.dmg, hit.epoch, hit.origin),
        onNetDeath: (killerId) => {
          session.reportDeath(killerId ?? session.me);
          {
            const roster = session.getPlayers();
            const whoMe = roster.find((p) => p.isMe);
            const killer = killerId && killerId !== session.me ? roster.find((p) => p.id === killerId) : null;
            const who = whoMe?.name ?? "YOU";
            pushFeed(killer ? `${killer.name} ERASED ${who}` : `${who} ERASED THEMSELVES`, true);
          }
          setDown(true);
          if (respawnTimer.current) window.clearTimeout(respawnTimer.current);
          respawnTimer.current = window.setTimeout(() => {
            respawnTimer.current = null;
            if (winnerRef.current) return;
            const h = gameRef.current;
            if (!h) return;
            h.netRespawn();
            session.reportRespawn(h.netState().epoch);
            setDown(false);
          }, 3200);
        },
      },
      { map: config.map, grapple: config.grapple },
    );
    gameRef.current = handle;

    const pushRemotes = () => {
      const roster = session.getPlayers();
      const list = [];
      for (const p of roster) {
        if (p.isMe) continue;
        const s = remotes.current.get(p.id);
        if (!s) continue;
        list.push({ id: p.id, name: p.name, ink: p.ink, state: s });
      }
      handle.setRemotePlayers(list);
    };

    handle.setPvp(true);
    handle.setSensitivity(Number(localStorage.getItem("dd_sens") || 100));
    handle.setInvert(localStorage.getItem("dd_invert") === "1");
    handle.setMusic(localStorage.getItem("dd_music") !== "0");
    handle.start();
    handle.netRespawn(session.getPlayers().find((p) => p.isMe)?.ink ?? 0);
    session.reportRespawn(handle.netState().epoch);

    session.setStateProvider(() => handle.netState());
    session.startTicking();
    session.setHandlers({
      onRemoteState: (id, s) => {
        remotes.current.set(id, s);
      },
      onPeerGone: (id) => {
        remotes.current.delete(id);
      },
      onChange: () => {
        setPlayers(session.getPlayers());
        pushRemotes();
      },
      onFeed: pushFeed,
      onHitMe: (dmg, killer, epoch, origin) => {
        const me = handle.netState();
        if (epoch !== me.epoch) return;
        handle.takeNetHit(dmg, killer, session.rewindMs, origin);
      },
      onLatency: (ms) => handle.setNetLatency(ms),
      onStart: () => resetRound(),
      onRematch: () => resetRound(),
      onError: (t) => pushFeed(t.toUpperCase(), true),
    });
    pushRemotes();

    const iv = window.setInterval(pushRemotes, 60);
    return () => {
      window.clearInterval(iv);
      session.setStateProvider(null);
      handle.dispose();
      gameRef.current = null;
      if (msgTimer.current) window.clearTimeout(msgTimer.current);
      if (tipTimer.current) window.clearTimeout(tipTimer.current);
      if (respawnTimer.current) window.clearTimeout(respawnTimer.current);
      respawnTimer.current = null;
    };
    // config is fixed for the lifetime of this arena: the session's rules do
    // not change mid-match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, pushFeed, resetRound]);

  const winner = players.find((p) => p.kills >= KILLS_TO_WIN) ?? null;
  useEffect(() => {
    winnerRef.current = Boolean(winner);
    if (winner) gameRef.current?.pause();
  }, [winner]);

  const resume = useCallback(() => gameRef.current?.resume(), []);
  const live = !paused && !down && !winner;
  const hpFrac = Math.max(0, hud.hp / hud.maxHp);
  const me = players.find((p) => p.isMe);
  const iWon = winner?.isMe ?? false;

  return (
    <div className={`dd-root ${live ? "dd-live" : ""} ${hud.dark ? "dd-dark" : ""}`}>
      <div ref={stageRef} className="dd-stage absolute inset-0" />

      <div className="dd-hud">
        <div className={`dd-crosshair ${hud.weapon === "KATANA" ? "katana" : ""} ${ads ? "ads" : ""}`} style={{ display: live ? undefined : "none" }}>
          <i className="ch-t" />
          <i className="ch-b" />
          <i className="ch-l" />
          <i className="ch-r" />
          <i className="ch-dot" />
        </div>

        {ads && live && (
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
          <div className="dd-area">{info.name}</div>
          <div className="score">
            KILLS <b>{me?.kills ?? 0}</b> / {KILLS_TO_WIN}
          </div>
          <div className="combo">{me ? me.name : ""}</div>
        </div>

        <div className="dd-hud-tr">
          <div className="wave">
            FREE FOR ALL <b>{players.length}</b>
          </div>
          <div className="dd-score">
            <div className="row head">
              <span className="nm">DOODLER</span>
              <span className="kb">K</span>
              <span className="kb">D</span>
            </div>
            {players.map((p) => (
              <div className={`row ${p.isMe ? "me" : ""} ${p.online ? "" : "off"}`} key={p.id}>
                <span className="dot" style={{ color: INK_LIST[p.ink % INK_LIST.length] }} />
                <span className="nm">{p.name}</span>
                <span className="kb">{p.kills}</span>
                <span className="kb">{p.deaths}</span>
              </div>
            ))}
          </div>

          <div className="minimap">
            <div className="mm-cross" />
            <div className="mm-me" />
            {hud.blips.map((b, i) => (
              <span key={i} className="mm-blip" style={{ left: `${50 + b.x * 45}%`, top: `${50 + b.z * 45}%` }} />
            ))}
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

        {tip && live && <div className="dd-tip" dangerouslySetInnerHTML={{ __html: tip }} />}

        <div className="dd-hud-bl">
          <div className="health">
            <span>HP</span>
            <div className="bar">
              <div className="fill" style={{ width: `${hpFrac * 100}%`, background: hpFrac < 0.3 ? "#b32b3a" : "#3947b8" }} />
            </div>
            <span className="hpnum">{hud.hp}</span>
          </div>
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

      <button type="button" className="dd-exit" onClick={onLeave}>
        <LogOut className="size-3.5" /> LEAVE MATCH (room {session.code}) · {info.name}
      </button>

      {down && !winner && (
        <div className="dd-screen">
          <div className="panel">
            <h1>ERASED</h1>
            <h2>back in a few seconds…</h2>
            <div className="stats">
              K <b>{me?.kills ?? 0}</b> · D <b>{me?.deaths ?? 0}</b>
            </div>
          </div>
        </div>
      )}

      {paused && !winner && (
        <div className="dd-screen">
          <div className="panel">
            <h1>PAUSED</h1>
            <h2>the match keeps running — get back in</h2>
            <div className="dd-screen-map">
              {info.name} · grappling hook {config.grapple ? "enabled" : "disabled"}
            </div>
            <div className="mainbtns">
              <button type="button" className="start" onClick={resume}>
                RESUME<i>back into the fight</i>
              </button>
              <button type="button" className="alt" onClick={onLeave}>
                LEAVE MATCH
              </button>
            </div>
          </div>
        </div>
      )}

      {winner && (
        <div className="dd-screen">
          <div className="panel">
            <h1>{iWon ? "YOU WIN" : "MATCH OVER"}</h1>
            <h2>
              {winner.name} took it · {winner.kills} kills
            </h2>
            <div className="dd-screen-map">
              {info.name} · grappling hook {config.grapple ? "enabled" : "disabled"}
            </div>
            <div className="dd-score" style={{ textAlign: "center", margin: "0 auto" }}>
              {players.map((p) => (
                <div className={`row ${p.isMe ? "me" : ""}`} key={p.id} style={{ justifyContent: "center" }}>
                  <span className="dot" style={{ color: INK_LIST[p.ink % INK_LIST.length] }} />
                  <span className="nm">{p.name}</span>
                  <span className="kb">{p.kills}</span>
                  <span className="kb">{p.deaths}</span>
                </div>
              ))}
            </div>
            <div className="mainbtns">
              {session.isHost ? (
                <button type="button" className="start" onClick={() => session.rematch()}>
                  REMATCH<i>everyone back to a fresh corner</i>
                </button>
              ) : (
                <div className="dd-netstatus">waiting for the host to start a rematch…</div>
              )}
              <button type="button" className="alt" onClick={onLeave}>
                LEAVE MATCH
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

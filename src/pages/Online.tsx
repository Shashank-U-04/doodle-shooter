// PLAY WITH FRIENDS — the lobby and the free-for-all arena.
//
// The lobby is where the room code is made, shared and waited on; the match is
// the ordinary engine with `setPvp(true)`, which turns the wave spawner off and
// every other player on. Solo play is a different page and a different code
// path, so nothing here can change how the survival run behaves.
//
// Match rules: the map and the grappling-hook rule are chosen on /setup and
// carried in as the match configuration. The host owns them (config packets
// broadcast any change), and the start packet repeats them so a late joiner
// still builds the same level. The engine is constructed from that
// configuration, which is what makes the toggle more than decoration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
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
import { NetSession, type NetPlayer, type SignalState } from "@/game/net";
import { ColyseusSession, resumableSeat } from "@/game/colyseus";
import { matchWinner, NET_TRANSPORT, type MatchSession } from "@/game/transport";
import {
  clearRoomLease,
  codeForCreate,
  isValidRoomCode,
  LEGACY_ROOM_PARAM,
  normalizeRoomCode,
  ROOM_PARAM,
  writeRoomLease,
} from "@/game/room";

const KILLS_TO_WIN = 15;
const INK_LIST = Object.values(INK_HEX).filter((v): v is string => typeof v === "string");

export default function Online() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const setup = useMemo(() => readSetup(), []);
  const [session, setSession] = useState<MatchSession | null>(null);
  const [mode, setMode] = useState<"menu" | "host" | "join">("menu");
  const [name, setName] = useState(() => setup.name || localStorage.getItem("dd_name") || "");
  const [codeInput, setCodeInput] = useState("");
  const [players, setPlayers] = useState<NetPlayer[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signal, setSignal] = useState<SignalState>("idle");
  const [signalDetail, setSignalDetail] = useState("");
  const [phase, setPhase] = useState<"lobby" | "playing">("lobby");
  const [copied, setCopied] = useState(false);
  const [match, setMatch] = useState<MatchConfig>(() =>
    normalizeMatchConfig({
      map: normalizeMapId(params.get("map") ?? setup.map),
      grapple: params.get("grapple") === null ? setup.grapple : params.get("grapple") === "1",
    }),
  );
  const ref = useRef<MatchSession | null>(null);

  const remember = useCallback((v: string) => {
    setName(v);
    localStorage.setItem("dd_name", v);
  }, []);

  const wire = useCallback((s: MatchSession) => {
    s.setHandlers({
      onStatus: (t) => setStatus(t),
      onError: (t) => {
        setError(t);
        // Safe metadata only: broker endpoint, relay source, candidate counts.
        console.warn(`[net ${s.code}] ${t}`, s.diagnostics());
      },
      onFeed: (t) => setStatus(t),
      onChange: () => setPlayers(s.getPlayers()),
      onConfig: (cfg) => setMatch(cfg),
      onSignal: (state, detail) => {
        setSignal(state);
        setSignalDetail(detail ?? "");
        // A recovered broker makes the previous "unreachable" error stale; an
        // ICE/TURN error is not cleared by this, because signaling never left.
        if (state === "open") setError(null);
      },
    });
  }, []);

  const create = useCallback(() => {
    const who = name.trim().slice(0, 16);
    if (!who) {
      setError("type a name first — your friends have to know who to blame");
      return;
    }
    localStorage.setItem("dd_name", who);
    let s: MatchSession;
    let resumed = false;
    if (NET_TRANSPORT === "colyseus") {
      // The server draws the code; the session keeps its own reconnection seat.
      s = new ColyseusSession("", who, true, match);
    } else {
      // Reuse this tab's live room instead of drawing a new code on every
      // mount/reload. A new code comes only after LEAVE (which clears the lease)
      // or after the lease expires.
      const lease = codeForCreate(sessionStorage, Date.now());
      resumed = lease.resumed;
      s = new NetSession(lease.code, who, true, match);
      writeRoomLease(sessionStorage, { code: s.code, isHost: true, createdAt: Date.now() });
    }
    wire(s);
    s.connect();
    ref.current = s;
    setSession(s);
    setMode("host");
    setError(null);
    setStatus(resumed ? `REOPENING ROOM ${s.code}…` : "OPENING YOUR ROOM…");
  }, [match, name, wire]);

  const join = useCallback(
    (codeArg?: string) => {
      const code = normalizeRoomCode(codeArg ?? codeInput);
      if (!isValidRoomCode(code)) {
        setError("Enter the 4-letter code your friend sent you.");
        return;
      }
      const who = name.trim().slice(0, 16);
      if (!who) {
        setError("type a name before joining");
        return;
      }
      localStorage.setItem("dd_name", who);
      let s: MatchSession;
      if (NET_TRANSPORT === "colyseus") {
        s = new ColyseusSession(code, who, false, match);
      } else {
        s = new NetSession(code, who, false, match);
        writeRoomLease(sessionStorage, { code: s.code, isHost: false, createdAt: Date.now() });
      }
      wire(s);
      s.connect();
      ref.current = s;
      setSession(s);
      setMode("join");
      setError(null);
    },
    [codeInput, match, name, wire],
  );

  /**
   * Colyseus only: take back the seat this tab held before a reload. Never
   * creates or joins anything new; if the hold ran out, the lobby says so.
   */
  const resume = useCallback(
    (seat: { code: string; isHost: boolean }) => {
      const who = name.trim().slice(0, 16) || (seat.isHost ? "HOST" : "GUEST");
      const s = new ColyseusSession(seat.code, who, seat.isHost, match, { resumeOnly: true });
      wire(s);
      s.connect();
      ref.current = s;
      setSession(s);
      setMode(seat.isHost ? "host" : "join");
      setError(null);
      setStatus(`REJOINING MATCH ${seat.code}…`);
    },
    [match, name, wire],
  );

  const leave = useCallback(() => {
    ref.current?.close();
    ref.current = null;
    // Leaving is the explicit way to replace a room: the next CREATE is free
    // to draw a new code.
    clearRoomLease(sessionStorage);
    setSession(null);
    setPlayers([]);
    setStatus("");
    setError(null);
    setCopied(false);
    setPhase("lobby");
    setMode("menu");
  }, []);

  // a session must never outlive the page that owns it
  useEffect(() => () => ref.current?.close(), []);

  // Tab visibility and the page lifecycle are not room lifecycles. Switching
  // tabs must not create a new room or destroy a working peer; coming back
  // only re-checks signaling. A real unload (not bfcache) does tear down the
  // transport, and the lease lets the reload resume the same code.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) ref.current?.resume();
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) ref.current?.suspend();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) ref.current?.resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  // Arriving from /setup with ?create=1 or ?room=XXXX: open or join the room
  // once. The timer keeps React StrictMode's mount → cleanup → mount cycle from
  // opening a room that the cleanup has already torn down.
  // A guest's room code is read once and then taken off the URL, so a reload
  // behaves as it always has (old ?code= links lose theirs to Convex Auth; see
  // ROOM_PARAM). With the Colyseus transport a reload resumes the held seat
  // on its own instead (see colyseus.ts).
  useEffect(() => {
    const wantsCreate = params.get("create") === "1";
    const wantsCode = params.get(ROOM_PARAM) ?? params.get(LEGACY_ROOM_PARAM);
    const held =
      NET_TRANSPORT === "colyseus" && !wantsCreate && !wantsCode ? resumableSeat(sessionStorage, Date.now()) : null;
    if (!wantsCreate && !wantsCode && !held) return;
    const t = window.setTimeout(() => {
      if (wantsCreate) create();
      else if (wantsCode) {
        join(wantsCode);
        setParams(
          (p) => {
            p.delete(ROOM_PARAM);
            return p;
          },
          { replace: true },
        );
      } else if (held) resume(held);
    }, 0);
    return () => window.clearTimeout(t);
    // mount-only: these are the initial URL choices
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // while the lobby is up: the host's GO drops us into the arena, and any
  // config packet the host sends becomes this client's match rules
  useEffect(() => {
    if (!session || phase !== "lobby") return;
    session.setHandlers({
      onStart: (cfg) => {
        if (cfg) setMatch(cfg);
        setPhase("playing");
      },
      onConfig: (cfg) => setMatch(cfg),
      onChange: () => setPlayers(session.getPlayers()),
    });
  }, [session, phase]);

  /** Host only: change the map and tell the room. */
  const chooseMap = (id: MapId) => {
    const next = { ...match, map: id };
    setMatch(next);
    writeSetup(next);
    session?.setConfig(next);
  };

  /** Host only: change the grapple rule and tell the room. */
  const chooseGrapple = (on: boolean) => {
    const next = { ...match, grapple: on };
    setMatch(next);
    writeSetup(next);
    session?.setConfig(next);
  };

  if (phase === "playing" && session) {
    return <PvpMatch session={session} onLeave={leave} />;
  }

  const guests = players.filter((p) => !p.isHost);
  const readyGuests = guests.filter((p) => p.ready).length;
  const allReady = guests.every((p) => p.ready);
  const me = players.find((p) => p.isMe);
  // The match server can hand the room to a guest when the host leaves for
  // good; PeerJS never marks a guest as host, so this is `mode === "host"` there.
  const hosting = mode === "host" || Boolean(me?.isHost);
  const info = mapInfo(match.map);

  return (
    <div className="dd-landing">
      <div className="dd-screen">
        <div className="panel">
          {mode === "menu" && (
            <>
              <h1>PLAY WITH FRIENDS</h1>
              <h2>free for all · shoot the other doodles</h2>

              <div className="dd-netform">
                <label>
                  your name
                  <input
                    value={name}
                    maxLength={16}
                    placeholder="doodler"
                    onChange={(e) => remember(e.target.value)}
                  />
                </label>
              </div>

              <div className="mapgrid">
                {MAPS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`mapbtn ${m.id === match.map ? "on" : ""}`}
                    aria-pressed={m.id === match.map}
                    onClick={() => chooseMap(m.id)}
                  >
                    <span className="mapthumb">
                      <img src={m.snapshot} alt={`${m.name} in-game snapshot`} loading="lazy" />
                    </span>
                    {m.name}
                    <i>{m.tagline}</i>
                  </button>
                ))}
              </div>
              <div className="settings">
                <label>
                  <input type="checkbox" checked={match.grapple} onChange={(e) => chooseGrapple(e.target.checked)} />
                  grappling hook enabled <span className="k">(this match only · Q / E)</span>
                </label>
                <div className="controls-note">
                  {match.grapple ? "the hook is part of this match" : "off for this match — nobody can equip or fire it"}
                </div>
              </div>

              <div className="mainbtns">
                <button type="button" className="start" onClick={create}>
                  CREATE MATCH<i>you get a code to share · {info.name.toLowerCase()}</i>
                </button>
                <button type="button" onClick={() => setMode("join")}>
                  JOIN A MATCH<i>enter a friend's code</i>
                </button>
              </div>

              <div className="cols">
                <div>
                  <div className="colhead">HOW IT WORKS</div>
                  <div>
                    <b>1</b> one of you creates a match and sends the 4-letter code
                  </div>
                  <div>
                    <b>2</b> the other types it in and joins the room
                  </div>
                  <div>
                    <b>3</b> everyone readies up, the host starts it — free for all, first to{" "}
                    <b>{KILLS_TO_WIN}</b> kills
                  </div>
                  <div>
                    <b>note</b>{" "}
                    {NET_TRANSPORT === "colyseus"
                      ? "the lobby runs on the match server"
                      : "play is peer-to-peer, straight between your browsers"}
                  </div>
                </div>
              </div>

              {error && <div className="dd-neterr">{error}</div>}

              <div className="mainbtns">
                <button type="button" className="alt" onClick={() => navigate("/")}>
                  BACK TO TITLE
                </button>
              </div>
            </>
          )}

          {mode === "join" && !session && (
            <>
              <h1>JOIN A MATCH</h1>
              <h2>type the code your friend sent you</h2>
              <div className="dd-netform">
                <label>
                  match code
                  <input
                    className="code"
                    value={codeInput}
                    maxLength={4}
                    autoFocus
                    placeholder="ABCD"
                    onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && join()}
                  />
                </label>
                <label>
                  your name
                  <input value={name} maxLength={16} onChange={(e) => remember(e.target.value)} />
                </label>
              </div>
              <div className="mainbtns">
                <button type="button" className="start" onClick={() => join()}>
                  CONNECT
                </button>
              </div>
              {error && <div className="dd-neterr">{error}</div>}
              <div className="mainbtns">
                <button type="button" className="alt" onClick={leave}>
                  BACK
                </button>
              </div>
            </>
          )}

          {session && (mode === "host" || mode === "join") && (
            <>
              <h1>{hosting ? "MATCH CODE" : `CODE ${session.code}`}</h1>
              <h2>
                {info.name.toLowerCase()} · grappling hook {match.grapple ? "on" : "off"}
              </h2>
              {hosting && (
                <>
                  <div className="dd-netcode">{session.code}</div>
                  <div className="mainbtns">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(session.code).catch(() => {});
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1600);
                      }}
                    >
                      {copied ? "COPIED!" : "COPY CODE"}
                    </button>
                  </div>
                  <h2>send it to your friend, then start</h2>
                </>
              )}
              {!hosting && <h2>connecting to the host…</h2>}

              {/* the host sets the battlefield and the rule; guests read them */}
              {hosting ? (
                <>
                  <div className="mapgrid small">
                    {MAPS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`mapbtn small ${m.id === match.map ? "on" : ""}`}
                        aria-pressed={m.id === match.map}
                        onClick={() => chooseMap(m.id)}
                      >
                        <span className="mapthumb">
                          <img src={m.snapshot} alt={`${m.name} in-game snapshot`} loading="lazy" />
                        </span>
                        {m.name}
                      </button>
                    ))}
                  </div>
                  <div className="settings">
                    <label>
                      <input
                        type="checkbox"
                        checked={match.grapple}
                        onChange={(e) => chooseGrapple(e.target.checked)}
                      />
                      grappling hook enabled <span className="k">(everyone plays by this)</span>
                    </label>
                  </div>
                </>
              ) : (
                <div className="controls-note">the host controls the map and the rules</div>
              )}

              <div className="dd-roster">
                <div className="row head">
                  <span className="dot" style={{ color: "#2e3342" }} />
                  <span>IN THE ROOM ({players.length})</span>
                </div>
                {players.length === 0 && <div className="row">nobody yet…</div>}
                {players.map((p) => (
                  <div className="row" key={p.id}>
                    <span className="dot" style={{ color: INK_LIST[p.ink % INK_LIST.length] }} />
                    <span className="nm">
                      {p.name}
                      {p.isMe ? " (you)" : ""}
                      {p.isHost ? " · host" : ""}
                      {p.isHost || p.ready ? " · ready" : " · waiting"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="dd-netstatus">{status}</div>
              {signal !== "open" && signal !== "idle" && (
                <div className="dd-netstatus">
                  SIGNALING {signal.toUpperCase()}
                  {signalDetail ? ` — ${signalDetail}` : ""}
                </div>
              )}
              {error && <div className="dd-neterr">{error}</div>}

              <div className="mainbtns">
                {hosting ? (
                  <button
                    type="button"
                    className="start"
                    disabled={!allReady || !session.joined}
                    onClick={() => session.beginMatch()}
                  >
                    ENTER ARENA
                    <i>
                      {!session.joined
                        ? "this room is not reachable on the signaling broker yet"
                        : !allReady
                          ? `${readyGuests}/${guests.length} friends ready — waiting on the rest`
                          : guests.length > 0
                            ? `${guests.length} friend${guests.length === 1 ? "" : "s"} ready · ${info.name.toLowerCase()}`
                            : "waiting for a friend… you can still scope the map"}
                    </i>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="start"
                      disabled={!session.joined}
                      onClick={() => session.setReady(!me?.ready)}
                    >
                      {!session.joined ? "JOINING…" : me?.ready ? "READY — TAP TO UNREADY" : "I'M READY"}
                      <i>{session.joined ? "the host starts when everyone is ready" : "waiting for the host to confirm this seat"}</i>
                    </button>
                    <button type="button" className="start" disabled>
                      WAITING FOR HOST<i>the room starts when they do</i>
                    </button>
                  </>
                )}
                <button type="button" className="alt" onClick={leave}>
                  LEAVE ROOM
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================================================================== *
 * the arena
 * ======================================================================== */

function PvpMatch({ session, onLeave }: { session: MatchSession; onLeave: () => void }) {
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
  // The match server is gone for good (restart, unreachable, seat expired).
  // Only the Colyseus session reports this; the arena stops and says why.
  const [lost, setLost] = useState<string | null>(null);
  // The host's rules, straight off the session: the map is fixed for the whole
  // match and the grapple rule is the one every client received.
  const config = session.getConfig();

  const pushFeed = useCallback((text: string, hot: boolean) => {
    const id = ++feedId.current;
    setFeed((f) => [...f.slice(-5), { id, text, hot }]);
    window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 3800);
  }, []);

  /**
   * Start a round: the first one, or a rematch.
   *
   * Everything that survives a round lives in React state or a ref, so every
   * one of them has to be put back here — the overlay flag, the pause, the
   * cached remote transforms, the pending respawn timer. A rematch that only
   * restarted the engine left the victory overlay derived from a scoreboard
   * nobody had cleared, which is why the button looked dead.
   */
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
    // Tell the room about the teleport. The epoch is what lets every peer snap
    // to the fresh pad instead of easing a body across the district.
    session.reportRespawn(handle.netState().epoch);
  }, [session]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;

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
        // our rounds landed on someone: they are the authority on their own body
        onNetHit: (hit) => session.reportHit(hit.victim, hit.dmg, hit.epoch, hit.origin),
        // Colyseus: our attacks go to the server, which decides what they did
        onNetCombat: (intent) => session.reportCombat?.(intent),
        onNetDeath: (killerId) => {
          session.reportDeath(killerId ?? session.me);
          // A client never applies its own death envelope, so the victim's page
          // has to record its own obituary here or its kill feed stays silent.
          {
            const roster = session.getPlayers();
            const me = roster.find((p) => p.isMe);
            const killer = killerId && killerId !== session.me ? roster.find((p) => p.id === killerId) : null;
            const who = me?.name ?? "YOU";
            pushFeed(killer ? `${killer.name} ERASED ${who}` : `${who} ERASED THEMSELVES`, true);
          }
          setDown(true);
          if (respawnTimer.current) window.clearTimeout(respawnTimer.current);
          respawnTimer.current = window.setTimeout(() => {
            respawnTimer.current = null;
            // A rematch that started while we were down owns the respawn now;
            // this timer must not teleport a body into a round that has moved on.
            if (winnerRef.current) return;
            const h = gameRef.current;
            if (!h) return;
            h.netRespawn();
            session.reportRespawn(h.netState().epoch);
            setDown(false);
          }, 3200);
        },
      },
      // The match is built from the host's rules, not from whatever this
      // browser last had selected.
      { map: config.map, grapple: config.grapple },
    );
    gameRef.current = handle;

    /** rebuild the avatar list from the roster + the newest packets */
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
    handle.setServerCombat(session.serverCombat === true);
    handle.setSensitivity(Number(localStorage.getItem("dd_sens") || 100));
    handle.setInvert(localStorage.getItem("dd_invert") === "1");
    handle.setMusic(localStorage.getItem("dd_music") !== "0");
    handle.start();
    // our ink doubles as our spawn pad, so nobody starts on top of anyone
    handle.netRespawn(session.getPlayers().find((p) => p.isMe)?.ink ?? 0);
    session.reportRespawn(handle.netState().epoch);

    session.setStateProvider(() => handle.netState());
    session.startTicking();
    session.setHandlers({
      onRemoteState: (id, s) => {
        remotes.current.set(id, s);
      },
      // They left, or went silent. Forget their transform now, so a respawn or
      // a rematch cannot rebuild a body out of a position nobody is holding.
      onPeerGone: (id) => {
        remotes.current.delete(id);
      },
      onChange: () => {
        setPlayers(session.getPlayers());
        pushRemotes();
      },
      onFeed: pushFeed,
      // A hit from the net layer, validated here: the epoch says whether it
      // belongs to the body we are in now (a shot that arrived after our
      // respawn is not ours to take), and we hand back our own half round trip
      // so the engine can rewind to where we were when it was fired.
      onHitMe: (dmg, killer, epoch, origin) => {
        const me = handle.netState();
        if (epoch !== me.epoch) return;
        handle.takeNetHit(dmg, killer, session.rewindMs, origin);
      },
      onLatency: (ms) => handle.setNetLatency(ms),
      // Colyseus: the server's verdicts (PeerJS never calls these)
      onShotLanded: (hit) => handle.showNetHit(hit),
      onHurt: (dmg, killer) => handle.netDamage(dmg, killer),
      onHealth: (hp, alive, killer) => handle.syncNetHealth(hp, alive, killer),
      // a rematch (or the very first start) rebuilds the arena from scratch
      onStart: () => resetRound(),
      onRematch: () => resetRound(),
      onError: (t) => pushFeed(t.toUpperCase(), true),
      onLost: (t) => {
        setLost(t);
        handle.pause();
      },
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

  // First to fifteen takes it. Over PeerJS every client builds the same
  // scoreboard from the same death messages and reads the result straight off
  // the roster; the match server declares it instead. The effect only freezes
  // our own view behind it.
  const winner = matchWinner(players, session.winnerId, KILLS_TO_WIN);
  // a fresh object every render; the effect only cares whether the match is decided
  const decided = winner !== null;
  useEffect(() => {
    winnerRef.current = decided;
    if (decided) gameRef.current?.pause();
  }, [decided]);

  const resume = useCallback(() => gameRef.current?.resume(), []);
  const live = !paused && !down && !winner && !lost;
  const hpFrac = Math.max(0, hud.hp / hud.maxHp);
  const me = players.find((p) => p.isMe);
  const iWon = winner?.isMe ?? false;
  // The match server hands the room to a guest when the host leaves for good,
  // and only the current host's rematch counts; PeerJS never changes hosts.
  const canRematch = session.serverCombat ? Boolean(me?.isHost) : session.isHost;

  return (
    <div className={`dd-root ${live ? "dd-live" : ""} ${hud.dark ? "dd-dark" : ""}`}>
      <div ref={stageRef} className="dd-stage absolute inset-0" />

      <div className="dd-hud">
        <div
          className={`dd-crosshair ${hud.weapon === "KATANA" ? "katana" : ""} ${ads ? "ads" : ""}`}
          style={{ display: live ? undefined : "none" }}
        >
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
              <div
                className="fill"
                style={{ width: `${hpFrac * 100}%`, background: hpFrac < 0.3 ? "#b32b3a" : "#3947b8" }}
              />
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
        ← LEAVE MATCH (room {session.code})
      </button>

      {lost && (
        <div className="dd-screen">
          <div className="panel">
            <h1>CONNECTION LOST</h1>
            <h2>{lost}</h2>
            <div className="mainbtns">
              <button type="button" className="start" onClick={onLeave}>
                LEAVE MATCH<i>back to the lobby menu</i>
              </button>
            </div>
          </div>
        </div>
      )}

      {down && !winner && !lost && (
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

      {paused && !winner && !lost && (
        <div className="dd-screen">
          <div className="panel">
            <h1>PAUSED</h1>
            <h2>the match keeps running — get back in</h2>
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

      {winner && !lost && (
        <div className="dd-screen">
          <div className="panel">
            <h1>{iWon ? "YOU WIN" : "MATCH OVER"}</h1>
            <h2>
              {winner.name} took it · {winner.kills} kills
            </h2>
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
              {canRematch ? (
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

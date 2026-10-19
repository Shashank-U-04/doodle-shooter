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
import { NetSession, makeRoomCode, type NetPlayer } from "@/game/net";

const KILLS_TO_WIN = 15;
const INK_LIST = Object.values(INK_HEX).filter((v): v is string => typeof v === "string");

export default function Online() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setup = useMemo(() => readSetup(), []);
  const [session, setSession] = useState<NetSession | null>(null);
  const [mode, setMode] = useState<"menu" | "host" | "join">("menu");
  const [name, setName] = useState(() => setup.name || localStorage.getItem("dd_name") || "");
  const [codeInput, setCodeInput] = useState("");
  const [players, setPlayers] = useState<NetPlayer[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"lobby" | "playing">("lobby");
  const [copied, setCopied] = useState(false);
  const [match, setMatch] = useState<MatchConfig>(() =>
    normalizeMatchConfig({
      map: normalizeMapId(params.get("map") ?? setup.map),
      grapple: params.get("grapple") === null ? setup.grapple : params.get("grapple") === "1",
    }),
  );
  const ref = useRef<NetSession | null>(null);

  const remember = useCallback((v: string) => {
    setName(v);
    localStorage.setItem("dd_name", v);
  }, []);

  const wire = useCallback((s: NetSession) => {
    s.setHandlers({
      onStatus: (t) => setStatus(t),
      onError: (t) => setError(t),
      onFeed: (t) => setStatus(t),
      onChange: () => setPlayers(s.getPlayers()),
      onConfig: (cfg) => setMatch(cfg),
    });
  }, []);

  const create = useCallback(() => {
    const who = name.trim().slice(0, 16);
    if (!who) {
      setError("type a name first — your friends have to know who to blame");
      return;
    }
    localStorage.setItem("dd_name", who);
    const s = new NetSession(makeRoomCode(), who, true, match);
    wire(s);
    s.connect();
    ref.current = s;
    setSession(s);
    setMode("host");
    setError(null);
  }, [match, name, wire]);

  const join = useCallback(
    (codeArg?: string) => {
      const code = (codeArg ?? codeInput).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length < 3) {
        setError("Enter the code your friend sent you.");
        return;
      }
      const who = name.trim().slice(0, 16);
      if (!who) {
        setError("type a name before joining");
        return;
      }
      localStorage.setItem("dd_name", who);
      const s = new NetSession(code, who, false, match);
      wire(s);
      s.connect();
      ref.current = s;
      setSession(s);
      setMode("join");
      setError(null);
    },
    [codeInput, match, name, wire],
  );

  const leave = useCallback(() => {
    ref.current?.close();
    ref.current = null;
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

  // Arriving from /setup with ?create=1 or ?code=XXXX: open or join the room
  // once. The timer keeps React StrictMode's mount → cleanup → mount cycle from
  // opening a room that the cleanup has already torn down.
  useEffect(() => {
    const wantsCreate = params.get("create") === "1";
    const wantsCode = params.get("code");
    if (!wantsCreate && !wantsCode) return;
    const t = window.setTimeout(() => {
      if (wantsCreate) create();
      else if (wantsCode) join(wantsCode);
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
                    <b>note</b> play is peer-to-peer, straight between your browsers
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
              <h1>{mode === "host" ? "MATCH CODE" : `CODE ${session.code}`}</h1>
              <h2>
                {info.name.toLowerCase()} · grappling hook {match.grapple ? "on" : "off"}
              </h2>
              {mode === "host" && (
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
              {mode === "join" && <h2>connecting to the host…</h2>}

              {/* the host sets the battlefield and the rule; guests read them */}
              {mode === "host" ? (
                <>
                  <div className="mapgrid">
                    {MAPS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`mapbtn ${m.id === match.map ? "on" : ""}`}
                        aria-pressed={m.id === match.map}
                        onClick={() => chooseMap(m.id)}
                      >
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
              {error && <div className="dd-neterr">{error}</div>}

              <div className="mainbtns">
                {mode === "host" ? (
                  <button
                    type="button"
                    className="start"
                    disabled={!allReady}
                    onClick={() => session.beginMatch()}
                  >
                    ENTER ARENA
                    <i>
                      {!allReady
                        ? `${readyGuests}/${guests.length} friends ready — waiting on the rest`
                        : guests.length > 0
                          ? `${guests.length} friend${guests.length === 1 ? "" : "s"} ready · ${info.name.toLowerCase()}`
                          : "waiting for a friend… you can still scope the map"}
                    </i>
                  </button>
                ) : (
                  <>
                    <button type="button" className="start" onClick={() => session.setReady(!me?.ready)}>
                      {me?.ready ? "READY — TAP TO UNREADY" : "I'M READY"}
                      <i>the host starts when everyone is ready</i>
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
      // a rematch (or the very first start) rebuilds the arena from scratch
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

  // First to fifteen takes it. Every client builds the same scoreboard from the
  // same death messages, so nobody has to be told who won — the result is read
  // straight off the roster. The effect only freezes our own view behind it.
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

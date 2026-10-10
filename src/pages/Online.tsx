// PLAY ONLINE — the lobby and the free-for-all arena.
//
// The lobby is where the room code is made, shared and waited on; the match is
// the ordinary engine with `setPvp(true)`, which turns the wave spawner off and
// every other player on. Solo play is a different page and a different code
// path, so nothing here can change how the survival run behaves.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createGame } from "@/game/engine";
import { EMPTY_HUD, type GameHandle, type HudState, type NetPlayerState } from "@/game/types";
import { INK_HEX } from "@/game/world";
import { NetSession, makeRoomCode, type NetPlayer } from "@/game/net";

const KILLS_TO_WIN = 15;
const INK_LIST = Object.values(INK_HEX).filter((v): v is string => typeof v === "string");

export default function Online() {
  const navigate = useNavigate();
  const [session, setSession] = useState<NetSession | null>(null);
  const [mode, setMode] = useState<"menu" | "host" | "join">("menu");
  const [name, setName] = useState(() => localStorage.getItem("dd_name") || "");
  const [codeInput, setCodeInput] = useState("");
  const [players, setPlayers] = useState<NetPlayer[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"lobby" | "playing">("lobby");
  const [copied, setCopied] = useState(false);
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
    });
  }, []);

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

  // while the lobby is up, the host's GO drops us into the arena
  useEffect(() => {
    if (!session || phase !== "lobby") return;
    session.setHandlers({ onStart: () => setPhase("playing") });
  }, [session, phase]);

  const create = () => {
    const s = new NetSession(makeRoomCode(), name, true);
    wire(s);
    s.connect();
    ref.current = s;
    setSession(s);
    setMode("host");
    setError(null);
  };

  const join = () => {
    const code = codeInput.trim().toUpperCase();
    if (code.length < 3) {
      setError("Enter the code your friend sent you.");
      return;
    }
    const s = new NetSession(code, name, false);
    wire(s);
    s.connect();
    ref.current = s;
    setSession(s);
    setMode("join");
    setError(null);
  };

  if (phase === "playing" && session) {
    return <PvpMatch session={session} onLeave={leave} />;
  }

  const guests = players.filter((p) => !p.isHost).length;

  return (
    <div className="dd-landing">
      <div className="dd-screen">
        <div className="panel">
          {mode === "menu" && (
            <>
              <h1>PLAY ONLINE</h1>
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
              <div className="mainbtns">
                <button type="button" className="start" onClick={create}>
                  CREATE MATCH<i>you get a code to share</i>
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
                    <b>3</b> the host starts it — free for all, first to{" "}
                    <b>{KILLS_TO_WIN}</b> kills
                  </div>
                  <div>
                    <b>note</b> play is peer-to-peer, straight between your two browsers
                  </div>
                </div>
              </div>
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
                <button type="button" className="start" onClick={join}>
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
                    </span>
                  </div>
                ))}
              </div>

              <div className="dd-netstatus">{status}</div>
              {error && <div className="dd-neterr">{error}</div>}

              <div className="mainbtns">
                {mode === "host" ? (
                  <button type="button" className="start" onClick={() => session.beginMatch()}>
                    ENTER ARENA<i>{guests > 0 ? `${guests} friend${guests === 1 ? "" : "s"} waiting on you` : "waiting for a friend… you can still scope the map"}</i>
                  </button>
                ) : (
                  <button type="button" className="start" disabled>
                    WAITING FOR HOST<i>the room starts when they do</i>
                  </button>
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
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [players, setPlayers] = useState<NetPlayer[]>(() => session.getPlayers());
  const [feed, setFeed] = useState<{ id: number; text: string; hot: boolean }[]>([]);
  const [message, setMessage] = useState<{ t: string; s: string | null } | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [hitmarker, setHitmarker] = useState(0);
  const [ads, setAds] = useState(false);
  const [paused, setPaused] = useState(false);
  const [down, setDown] = useState(false);

  const pushFeed = useCallback((text: string, hot: boolean) => {
    const id = ++feedId.current;
    setFeed((f) => [...f.slice(-5), { id, text, hot }]);
    window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 3800);
  }, []);

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;

    const handle = createGame(host, {
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
      onNetHit: (id, dmg) => session.reportHit(id, dmg),
      onNetDeath: (killerId) => {
        session.reportDeath(killerId ?? session.me);
        setDown(true);
        window.setTimeout(() => {
          if (winnerRef.current) return;
          gameRef.current?.netRespawn();
          session.reportRespawn();
          setDown(false);
        }, 3200);
      },
    });
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

    session.setStateProvider(() => handle.netState());
    session.startTicking();
    session.setHandlers({
      onRemoteState: (id, s) => {
        remotes.current.set(id, s);
      },
      onChange: () => {
        setPlayers(session.getPlayers());
        pushRemotes();
      },
      onFeed: pushFeed,
      onHitMe: (dmg, killer) => handle.takeNetHit(dmg, killer),
      // a rematch (or the very first start) rebuilds the arena from scratch
      onStart: () => {
        setDown(false);
        setPaused(false);
        remotes.current.clear();
        handle.setRemotePlayers([]);
        handle.start();
        handle.netRespawn(session.getPlayers().find((p) => p.isMe)?.ink ?? 0);
      },
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
    };
  }, [session, pushFeed]);

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
    <div className={`dd-root ${live ? "dd-live" : ""}`}>
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
                <button type="button" className="start" onClick={() => session.beginMatch()}>
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

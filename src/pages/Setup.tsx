// The setup screen: the game mode's map and match rules, in the original
// title-screen paper-panel style. It is the only screen that decides which
// battlefield a match loads and whether the grappling hook is part of it.
//
// Solo: pick a map, set the rule, START MATCH.
// Friends: pick a map, set the rule, then create a room or type a code — the
// choice is carried into the lobby as the match configuration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { MAPS, gameHref, mapInfo, normalizeMapId, readSetup, writeSetup, type GameMode, type MapId } from "@/game/maps";
import { ROOM_PARAM } from "@/game/room";
import { NAME_MAX as MAX_NAME } from "../../server/src/shared/rules.js";

export default function Setup() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initial = useMemo(() => readSetup(), []);

  const mode: GameMode =
    params.get("mode") === "friends" ? "friends" : params.get("mode") === "solo" ? "solo" : initial.mode;
  const map = normalizeMapId(params.get("map") ?? initial.map);
  const grappleParam = params.get("grapple");
  const grapple = grappleParam === "0" ? false : grappleParam === "1" ? true : initial.grapple;

  const [name, setName] = useState(() => initial.name || localStorage.getItem("dd_name") || "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const info = mapInfo(map);

  // Mirror every visible choice into the session match store, so Back or a
  // refresh keeps it. The URL carries the same values for a shareable link.
  useEffect(() => {
    writeSetup({ mode, map, grapple, name });
    const next = new URLSearchParams(params);
    next.set("mode", mode);
    next.set("map", map);
    next.set("grapple", grapple ? "1" : "0");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, map, grapple]);

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
    if (!cleanName) {
      setError("type a name first — your friends have to know who to blame");
      return;
    }
    localStorage.setItem("dd_name", cleanName);
    writeSetup({ mode: "friends", map, grapple, name: cleanName });
    navigate(`/online?create=1&map=${map}&grapple=${grapple ? 1 : 0}`);
  };

  const joinRoom = () => {
    const room = code.trim().toUpperCase();
    if (room.length < 3) {
      setError("enter the code your friend sent you");
      return;
    }
    if (!cleanName) {
      setError("type a name before joining");
      return;
    }
    localStorage.setItem("dd_name", cleanName);
    writeSetup({ mode: "friends", map, grapple, name: cleanName });
    navigate(`/online?${ROOM_PARAM}=${room}&map=${map}&grapple=${grapple ? 1 : 0}`);
  };

  return (
    <div className="dd-landing">
      <div className="dd-screen">
        <div className="panel">
          <h1>{mode === "solo" ? "CHOOSE A BATTLEFIELD" : "SET UP THE ROOM"}</h1>
          <h2>
            {mode === "solo" ? "play vs computer · pick a map, set the rules" : "play with friends · map + rules first"}
          </h2>

          <div className="mapgrid">
            {MAPS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mapbtn ${m.id === map ? "on" : ""}`}
                aria-pressed={m.id === map}
                onClick={() => pickMap(m.id)}
              >
                <span className="mapthumb">
                  <img src={m.snapshot} alt={`${m.name} in-game snapshot`} loading="lazy" />
                </span>
                {m.name}
                <i>{m.tagline}</i>
              </button>
            ))}
          </div>

          <div className="controls-note">{info.description}</div>

          <div className="settings">
            <label>
              <input type="checkbox" checked={grapple} onChange={(e) => setGrapple(e.target.checked)} />
              grappling hook enabled <span className="k">(this match only · Q / E)</span>
            </label>
            <div className="controls-note">
              {grapple
                ? "a 34 m ink hook, held to reel in, released to let go"
                : "off for this match: nothing can equip or fire the hook"}
            </div>
          </div>

          {mode === "solo" ? (
            <div className="mainbtns">
              <button type="button" className="start" onClick={startSolo}>
                START MATCH<i>{info.name.toLowerCase()}{grapple ? " · grapple on" : " · grapple off"}</i>
              </button>
            </div>
          ) : (
            <>
              <div className="dd-netform">
                <label>
                  your name
                  <input
                    value={name}
                    maxLength={MAX_NAME}
                    placeholder="doodler"
                    onChange={(e) => {
                      setName(e.target.value);
                      writeSetup({ name: e.target.value });
                      setError(null);
                    }}
                  />
                </label>
                <label>
                  room code (to join)
                  <input
                    className="code"
                    value={code}
                    maxLength={6}
                    placeholder="ABCD"
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                      setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                  />
                </label>
              </div>
              {error && <div className="dd-neterr">{error}</div>}
              <div className="mainbtns">
                <button type="button" className="start" onClick={createRoom}>
                  CREATE ROOM<i>you get a code to share · {info.name.toLowerCase()}</i>
                </button>
                <button type="button" onClick={joinRoom}>
                  JOIN A ROOM<i>enter a friend's code</i>
                </button>
              </div>
            </>
          )}

          <div className="mainbtns">
            <button type="button" onClick={() => setMode(mode === "solo" ? "friends" : "solo")}>
              {mode === "solo" ? "SWITCH TO PLAY WITH FRIENDS" : "SWITCH TO PLAY VS COMPUTER"}
            </button>
            <button type="button" className="alt" onClick={() => navigate("/")}>
              BACK TO TITLE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

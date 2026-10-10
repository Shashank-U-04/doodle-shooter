// The title screen: paper sheet, panel, START / PLAY ONLINE buttons, settings
// and the control list. START goes solo, PLAY ONLINE opens the deathmatch lobby.

import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

const KEYBOARD: [string, string][] = [
  ["WASD", "move &nbsp; · &nbsp; <b>Mouse</b> look &nbsp; · &nbsp; <b>Shift</b> sprint"],
  ["LMB", "fire / slash &nbsp; · &nbsp; <b>RMB</b> aim down sights / block"],
  ["Space", "jump &nbsp; · &nbsp; again in the air for a double jump"],
  ["C / Ctrl", "crouch &nbsp; · &nbsp; <b>X</b> dash"],
  ["Q / E", "grapple: hold to reel in, release to let go"],
  ["F", "katana slash &nbsp; · &nbsp; <b>R</b> reload &nbsp; · &nbsp; <b>G</b> grenade"],
  ["1-5 / wheel", "rifle · shotgun · sniper · katana · revolver"],
  ["M", "music &nbsp; · &nbsp; <b>P / Esc</b> pause"],
];

export default function Landing() {
  const navigate = useNavigate();
  const [sens, setSens] = useState(() => Number(localStorage.getItem("dd_sens") || 100));
  const [invert, setInvert] = useState(() => localStorage.getItem("dd_invert") === "1");
  const [music, setMusic] = useState(() => localStorage.getItem("dd_music") !== "0");
  const [best] = useState(() => Number(localStorage.getItem("dd_best") || 0));
  const [note] = useState<string | null>(null);

  // PLAY ONLINE opens the lobby: one player creates a match and shares the
  // 4-letter code, the other types it in, and the two browsers talk directly.
  const online = useCallback(() => {
    navigate("/online");
  }, [navigate]);

  return (
    <div className="dd-landing">
      <div className="dd-screen">
        <div className="panel">
          <h1>DOODLE SHOOTER</h1>
          <h2>a scribbled survival shooter</h2>

          <div className="mainbtns">
            <button type="button" className="start" onClick={() => navigate("/game")}>
              START<i>solo · survive the waves</i>
            </button>
            <button type="button" onClick={online}>
              PLAY ONLINE<i>free for all · share a code, play a friend</i>
            </button>
          </div>

          <div className="cols">
            <div>
              <div className="colhead">MOUSE + KEYBOARD</div>
              {KEYBOARD.map(([key, rest]) => (
                <div key={key}>
                  <b>{key}</b>{" "}
                  <span dangerouslySetInnerHTML={{ __html: rest }} />
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
                }}
              />
              invert vertical look
            </label>
            <label>
              <input
                type="checkbox"
                checked={music}
                onChange={(e) => {
                  setMusic(e.target.checked);
                  localStorage.setItem("dd_music", e.target.checked ? "1" : "0");
                }}
              />
              music <span className="k">(M)</span>
            </label>
          </div>

          {note && <div className="beststat">{note}</div>}
          {best > 0 && <div className="beststat">best score: {best}</div>}
        </div>
      </div>
    </div>
  );
}

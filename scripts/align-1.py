import io

ok = True


def patch(path, subs):
    global ok
    s = io.open(path, encoding="utf-8").read()
    for i, (old, new, count) in enumerate(subs):
        n = s.count(old)
        if n != count:
            print("MISS %s #%d (%d != %d): %r" % (path, i, n, count, old[:70]))
            ok = False
            continue
        s = s.replace(old, new, count)
    io.open(path, "w", encoding="utf-8").write(s)
    print("patched", path)


D = "src/game/enemies-data.ts"
A = "src/game/audio.ts"
T = "src/game/types.ts"
G = "src/pages/Game.tsx"
E = "src/game/engine.ts"

patch(D, [
    ("export const GRAV = 22;", "export const GRAV = 26; // the original's gravity", 1),
    ("export const EYE = 1.6;",
     "export const EYE = 1.6;\nexport const EYE_CROUCH = 0.88; // crouched eye height (the original's Kr)", 1),
])

patch(A, [
    ('''  uiClick() {
    this.tone(700, 500, 0.05, 0.08, "square");
  }
}
''', '''  uiClick() {
    this.tone(700, 500, 0.05, 0.08, "square");
  }
  jump() {
    this.tone(260, 480, 0.1, 0.1, "triangle");
  }
  land(t = 0.5) {
    this.noise(0.14, 0.15 + 0.35 * t, "lowpass", 350);
  }
  footstep(t = 1) {
    this.noise(0.07, 0.12 * t, "lowpass", 400 + Math.random() * 400);
  }
  slide() {
    this.noise(0.45, 0.18, "lowpass", 500);
  }
  pump() {
    this.tone(300, 150, 0.08, 0.15, "square");
    this.noise(0.06, 0.2, "highpass", 1500);
  }
  shell() {
    this.tone(1400, 900, 0.05, 0.08, "square");
  }
  dash() {
    this.noise(0.18, 0.25, "bandpass", 900);
  }
}
''', 1),
])

patch(T, [
    ("  weapon: string;\n  hint: string;",
     "  weapon: string;\n  hint: string;\n  /** crosshair gap in px - the original's 5 + spread*900 */\n  spreadPx: number;", 1),
])

patch(G, [
    ('import { useCallback, useEffect, useRef, useState } from "react";',
     'import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";', 1),
    ('''<div className={`dd-crosshair ${hud.weapon === "KATANA" ? "katana" : ""} ${ads ? "ads" : ""}`} style={{ display: overlay.kind === "menu" && hud.wave > 0 ? undefined : "none" }}>''',
     '''<div
          className={`dd-crosshair ${hud.weapon === "KATANA" ? "katana" : ""} ${ads ? "ads" : ""}`}
          style={
            {
              display: overlay.kind === "menu" && hud.wave > 0 ? undefined : "none",
              "--s": `${Math.round(hud.spreadPx)}px`,
            } as CSSProperties
          }
        >''', 1),
])

patch(E, [
    ('import { ED, PR, QR, VR, XN, XN_AIR, CI, JN, BASE_FOV, type EnemyKind, type EnemyDef } from "./enemies-data";',
     'import { ED, PR, QR, VR, XN, XN_AIR, CI, JN, EYE, EYE_CROUCH, BASE_FOV, SENS, DR, NR, FR, OR_, GRAV, type EnemyKind, type EnemyDef } from "./enemies-data";', 1),
    ("const rand = (a: number, b: number) => a + Math.random() * (b - a);",
     '''const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Exponential approach - the original's `st`, used for bob/spread/fov. */
const expDamp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
/** Under-damped spring, the original's `ss`: recoil, yaw kick, fov punch, landing dip. */
class Spring {
  value = 0;
  vel = 0;
  target = 0;
  constructor(private k: number, private d: number) {}
  update(dt: number) {
    const steps = dt > 0.02 ? 3 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = (this.target - this.value) * this.k - this.vel * this.d;
      this.vel += accel * h;
      this.value += this.vel * h;
    }
    return this.value;
  }
  kick(v: number) {
    this.vel += v;
  }
  reset() {
    this.value = 0;
    this.vel = 0;
  }
}''', 1),
    ('''  // Where the cursor is, so the view can still turn when the pointer cannot be
  // captured (see steerFromEdge).
  let cursorX = 0;
  let cursorY = 0;
  let cursorSeen = false;''',
     '''  // Look deltas accumulate here and are consumed once per frame by the player
  // update - the original's exact mx/my scheme, so the aim slow-down (.38
  // scoped / .62 irons) applies to the whole frame's delta. One-shot key edges
  // (jump / crouch / dash) are set in the key handlers and consumed per frame.
  let lookX = 0;
  let lookY = 0;
  let jumpPressed = false;
  let crouchPressed = false;
  let dashPressed = false;''', 1),
    ('''    onGround: false,
    jumps: 0,
    crouch: false,
    sprint: false,
    radius: 0.42,
    height: 1.7,
    regenDelay: 0,''',
     '''    onGround: false,
    radius: 0.42,
    height: CI,
    // the original's movement state
    crouching: false,
    sprinting: false,
    aiming: false,
    sliding: false,
    slideT: 0,
    airT: 0,
    coyote: 0,
    jumpBuffer: 0,
    airJumps: 1,
    landGraceT: 0,
    lastDamageT: 10,
    eyeH: EYE,
    roll: 0,
    bobPhase: 0,
    bobAmt: 0,
    stepDist: 0,''', 1),
    ("    dashT: 0,\n    dashCd: 0,", "    dashCd: 0,", 1),
    ('''  const slots = WEAPONS.map((def) => ({ def, mag: def.magSize, reserve: def.reserve }));
  let curSlot = 0;
  let switchT = 0;
  let fireCd = 0;
  let reloadT = 0;
  let recoil = 0;''',
     '''  const slots = WEAPONS.map((def) => ({
    def,
    mag: def.magSize,
    reserve: def.reserve,
    spreadCur: def.spread,
    pumpT: 0,
    pumped: false,
    reloadT: 0,
    reloading: false,
  }));
  let curSlot = 0;
  let switchT = 0;
  let fireCd = 0;
  let autoReloadT = 0;
  // the original's camera springs
  const recoilPitch = new Spring(190, 17);
  const recoilYaw = new Spring(190, 17);
  const fovKick = new Spring(220, 14);
  const landDip = new Spring(170, 15);''', 1),
])

print("OK" if ok else "HAD MISSES")

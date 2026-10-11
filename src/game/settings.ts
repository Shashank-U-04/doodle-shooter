// Player settings that live in localStorage. Every screen (title, solo run,
// deathmatch lobby) reads the same keys, so the rules about what a stored value
// is allowed to mean live here rather than being re-guessed per page.
//
// Look sensitivity is the one that can break a run. The engine turns the view
// by `0.0022 * sensitivity / 100` radians per mouse count, so a stored 0 aims
// the mouse at nothing at all — the view simply never turns — and a stored
// value that parses to NaN or Infinity poisons the yaw, which makes the camera
// matrix NaN and stops the scene drawing. The slider only ever writes 25..250,
// but the stored value is not ours to trust: it survives across builds, and a
// single bad one must not leave a player unable to look around.

export const SENS_MIN = 25;
export const SENS_MAX = 250;
export const SENS_DEFAULT = 100;

/** Any look sensitivity from anywhere (storage, a slider, a link) -> a usable one. */
export function clampSensitivity(v: number): number {
  if (!Number.isFinite(v)) return SENS_DEFAULT;
  return Math.min(SENS_MAX, Math.max(SENS_MIN, v));
}

/** The look sensitivity to play with: read from storage, then made safe. */
export function readSensitivity(): number {
  const raw = localStorage.getItem("dd_sens");
  if (raw === null || raw.trim() === "") return SENS_DEFAULT;
  return clampSensitivity(Number(raw));
}

// The weapon rack, the player-versus-player table and the katana, as the
// engine uses them. The definitions live in server/src/shared/weapons.ts, the
// one copy the match server reads too, so the numbers players feel and the
// numbers the server applies cannot drift apart.
export { DEFAULT_WEAPON, KATANA_MELEE, PVP, WEAPON_NAMES, WEAPONS, type MeleeConfig, type WeaponDef } from "../../server/src/shared/weapons.js";

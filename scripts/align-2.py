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


E = "src/game/engine.ts"

patch(E, [
    # WeaponDef type -> the original's full field set
    ('''  spread: number;
  adsSpread: number;
  reloadTime: number;
  auto: boolean;
  zoom: number;
  katana?: boolean;
};''',
     '''  spread: number;
  adsSpread: number;
  spreadKick: number;
  spreadMax: number;
  camKick: [number, number];
  fovKick: number;
  moveSpread: number;
  reloadDur: number;
  reloadType: "mag" | "shells" | "cylinder";
  cycleDur?: number;
  scope?: boolean;
  falloff?: [number, number, number] | null;
  auto: boolean;
  adsFov: number;
  katana?: boolean;
};''', 1),
    # exact original weapon table (zr)
    ('''  { name: "RIFLE", kind: "rifle", hint: "auto \u00b7 put the red dot on them", magSize: 35, reserve: 175, maxReserve: 350, interval: 1 / 11, damage: 24, headMul: 2.6, pellets: 1, spread: 0.016, adsSpread: 0.0034, reloadTime: 1.45, auto: true, zoom: 58 },
  { name: "SHOTGUN", kind: "shotgun", hint: "pump \u00b7 devastating up close", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.78, damage: 19, headMul: 1.8, pellets: 10, spread: 0.062, adsSpread: 0.034, reloadTime: 2.0, auto: false, zoom: 68 },
  { name: "SNIPER", kind: "sniper", hint: "scoped bolt action \u00b7 one shot, one erasure", magSize: 5, reserve: 25, maxReserve: 50, interval: 0.9, damage: 150, headMul: 3, pellets: 1, spread: 0.075, adsSpread: 0.0004, reloadTime: 2.1, auto: false, zoom: 20 },
  { name: "KATANA", kind: "katana", hint: "slash \u00b7 hold aim to block & return bullets", magSize: Infinity, reserve: Infinity, maxReserve: Infinity, interval: 0.27, damage: 75, headMul: 1.6, pellets: 1, spread: 0, adsSpread: 0, reloadTime: 0, auto: false, zoom: 82, katana: true },
  { name: "REVOLVER", kind: "revolver", hint: "hand cannon \u00b7 headshots erase", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.3, damage: 62, headMul: 3, pellets: 1, spread: 0.006, adsSpread: 0.002, reloadTime: 1.9, auto: false, zoom: 52 },''',
     '''  // transcribed 1:1 from the original's weapon table (rates, spreads, kicks,
  // ads fov, falloff, reload behaviour)
  { name: "RIFLE", kind: "rifle", hint: "auto \u00b7 put the red dot on them", magSize: 35, reserve: 175, maxReserve: 350, interval: 1 / 11, damage: 24, headMul: 2.6, pellets: 1, spread: 0.016, adsSpread: 0.0034, spreadKick: 0.009, spreadMax: 0.075, camKick: [0.009, 0.0034], fovKick: 1.2, moveSpread: 0.0012, reloadDur: 1.45, reloadType: "mag", auto: true, adsFov: 58 },
  { name: "SHOTGUN", kind: "shotgun", hint: "pump \u00b7 devastating up close", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.78, damage: 19, headMul: 1.8, pellets: 10, spread: 0.062, adsSpread: 0.034, spreadKick: 0, spreadMax: 0.1, camKick: [0.05, 0.012], fovKick: 4, moveSpread: 0.0006, cycleDur: 0.45, reloadDur: 0.45, reloadType: "shells", falloff: [11, 32, 0.22], auto: false, adsFov: 68 },
  { name: "SNIPER", kind: "sniper", hint: "scoped bolt action \u00b7 one shot, one erasure", magSize: 5, reserve: 25, maxReserve: 50, interval: 0.2, damage: 150, headMul: 3, pellets: 1, spread: 0.075, adsSpread: 0.0004, spreadKick: 0.05, spreadMax: 0.14, camKick: [0.055, 0.008], fovKick: 4.5, moveSpread: 0.004, cycleDur: 0.85, reloadDur: 2.1, reloadType: "mag", scope: true, auto: false, adsFov: 20 },
  { name: "KATANA", kind: "katana", hint: "slash \u00b7 hold aim to block & return bullets", magSize: Infinity, reserve: Infinity, maxReserve: Infinity, interval: 0.27, damage: 75, headMul: 1.6, pellets: 1, spread: 0, adsSpread: 0, spreadKick: 0, spreadMax: 0, camKick: [0, 0], fovKick: 0, moveSpread: 0, reloadDur: 0, reloadType: "mag", auto: false, adsFov: 82, katana: true },
  { name: "REVOLVER", kind: "revolver", hint: "hand cannon \u00b7 headshots erase", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.3, damage: 62, headMul: 3, pellets: 1, spread: 0.006, adsSpread: 0.002, spreadKick: 0.02, spreadMax: 0.06, camKick: [0.038, 0.007], fovKick: 2.5, moveSpread: 0.0015, reloadDur: 1.9, reloadType: "cylinder", auto: false, adsFov: 52 },''', 1),
    # Bullet: origin + falloff, plus the falloff helper
    ('''  mesh: THREE.Mesh;
  source: string;
};
type Grenade = { pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; mesh: THREE.Mesh };''',
     '''  mesh: THREE.Mesh;
  source: string;
  origin: THREE.Vector3;
  falloff?: [number, number, number] | null;
};
/** the original's shotgun falloff [near, far, minMul], measured from the muzzle */
const bulletDmg = (b: Bullet, from: THREE.Vector3) => {
  if (!b.falloff) return b.dmg;
  const d = from.distanceTo(b.origin);
  const [near, far, minMul] = b.falloff;
  if (d <= near) return b.dmg;
  if (d >= far) return b.dmg * minMul;
  return b.dmg * (1 + (minMul - 1) * ((d - near) / (far - near)));
};
type Grenade = { pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; mesh: THREE.Mesh };''', 1),
    ('''  const spawnBullet = (pos: THREE.Vector3, vel: THREE.Vector3, dmg: number, friendly: boolean, ink: InkId, source: string, headMul = 1) => {
    const mesh = new THREE.Mesh(bulletGeo, makeInkMaterial(ink, false, THREE.FrontSide, true));
    mesh.position.copy(pos);
    mesh.lookAt(pos.clone().add(vel));
    scene.add(mesh);
    bullets.push({ pos: pos.clone(), vel: vel.clone(), life: 2.2, dmg, headMul, friendly, ink, mesh, source });
  };''',
     '''  const spawnBullet = (
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    dmg: number,
    friendly: boolean,
    ink: InkId,
    source: string,
    headMul = 1,
    falloff?: [number, number, number] | null,
  ) => {
    const mesh = new THREE.Mesh(bulletGeo, makeInkMaterial(ink, false, THREE.FrontSide, true));
    mesh.position.copy(pos);
    mesh.lookAt(pos.clone().add(vel));
    scene.add(mesh);
    bullets.push({ pos: pos.clone(), vel: vel.clone(), life: 2.2, dmg, headMul, friendly, ink, mesh, source, origin: pos.clone(), falloff });
  };''', 1),
    # eye height from the smoothed state
    ("  const eyePos = () => new THREE.Vector3(player.pos.x, player.pos.y + (player.crouch ? JN * 0.94 : 1.6), player.pos.z);",
     "  const eyePos = () => new THREE.Vector3(player.pos.x, player.pos.y + player.eyeH, player.pos.z);", 1),
    # firing: the original's exact kick chain + spread + pump + interrupt
    ('''  function fireWeapon() {
    const s = slots[curSlot];
    const def = s.def;
    if (reloadT > 0 || switchT > 0) return;
    if (def.katana) {
      katanaSlash();
      fireCd = def.interval;
      return;
    }
    if (s.mag <= 0) {
      fx.dry();
      startReload();
      return;
    }
    s.mag--;
    fireCd = def.interval;
    recoil = Math.min(recoil + (def.kind === "shotgun" ? 3.2 : 1.2), 5);
    player.pitch += def.kind === "sniper" ? 0.02 : 0.006;
    player.flashFx = 0.14;
    if (def.kind === "shotgun") fx.shotgun();
    else if (def.kind === "sniper") fx.sniper();
    else fx.shoot();

    const eye = eyePos();
    const base = fwdVec();
    const spread = (mouseAim ? def.adsSpread : def.spread) * (player.onGround ? 1 : 1.8);
    for (let i = 0; i < def.pellets; i++) {
      const dir = base.clone();
      dir.x += rand(-spread, spread);
      dir.y += rand(-spread, spread);
      dir.z += rand(-spread, spread);
      dir.normalize();
      const hitT = raycastWorld(eye, dir, 160);
      // friendly tracer
      const hitPoint = eye.clone().addScaledVector(dir, hitT);
      spawnBullet(eye.clone().addScaledVector(dir, 0.6), dir.multiplyScalar(70), def.damage, true, INK.BLUE, def.kind, def.headMul);
      if (hitT < 160) spawnShards(hitPoint, INK.BLACK, 2, 2);
    }
    pushHud();
  }''',
     '''  function fireWeapon() {
    const s = slots[curSlot];
    const def = s.def;
    if (s.pumpT > 0 || switchT > 0) return;
    if (def.katana) {
      katanaSlash();
      fireCd = def.interval;
      return;
    }
    if (s.mag <= 0) {
      fx.dry();
      startReload();
      return;
    }
    // firing interrupts a reload, exactly like the original
    if (s.reloading) {
      s.reloading = false;
      s.reloadT = 0;
    }
    s.mag--;
    fireCd = def.interval;
    if (def.cycleDur) {
      s.pumpT = def.cycleDur + 0.12;
      s.pumped = false;
    }
    s.spreadCur = Math.min(s.spreadCur + def.spreadKick, def.spreadMax);
    // the original's exact kick: pitch nudge, recoil springs, fov punch, shake
    const kick = def.camKick[0] * (player.aiming ? 0.7 : 1) + rand(0, def.camKick[0] * 0.3);
    player.pitch = clamp(player.pitch + kick * 0.55, -1.5, 1.5);
    recoilPitch.kick(kick * 22);
    recoilYaw.kick(rand(-def.camKick[1], def.camKick[1]) * 30);
    fovKick.kick(def.fovKick);
    shakeT = Math.max(shakeT, 0.02 + def.fovKick * 0.02);
    player.flashFx = 0.14;
    if (def.kind === "shotgun") {
      fx.shotgun();
      hitstopT = Math.max(hitstopT, 0.03);
    } else if (def.kind === "sniper") fx.sniper();
    else fx.shoot();

    const eye = eyePos();
    const base = fwdVec();
    const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    // the original's spread: offset along the right vector and world y, renormalised
    for (let i = 0; i < def.pellets; i++) {
      const dir = base.clone();
      if (s.spreadCur > 0) {
        dir.addScaledVector(right, rand(-s.spreadCur, s.spreadCur));
        dir.y += rand(-s.spreadCur, s.spreadCur);
        dir.normalize();
      }
      const hitT = raycastWorld(eye, dir, 160);
      const hitPoint = eye.clone().addScaledVector(dir, hitT);
      spawnBullet(eye.clone().addScaledVector(dir, 0.6), dir.clone().multiplyScalar(70), def.damage, true, INK.BLUE, def.kind, def.headMul, def.falloff);
      if (hitT < 160) spawnShards(hitPoint, INK.BLACK, 2, 2);
    }
    if (s.mag === 0 && def.reloadType === "mag") autoReloadT = 0.25;
    pushHud();
  }''', 1),
    ('''  function startReload() {
    const s = slots[curSlot];
    if (s.def.katana || reloadT > 0 || s.mag >= s.def.magSize || s.reserve <= 0) return;
    reloadT = s.def.reloadTime;
    fx.reload();
  }

  function finishReload() {
    const s = slots[curSlot];
    const need = s.def.magSize - s.mag;
    const take = Math.min(need, s.reserve);
    s.mag += take;
    s.reserve -= take;
    pushHud();
  }''',
     '''  function startReload() {
    const s = slots[curSlot];
    if (s.def.katana || s.reloading || s.pumpT > 0 || s.mag >= s.def.magSize || s.reserve <= 0) return;
    s.reloading = true;
    s.reloadT = 0;
    fx.reload();
    pushHud();
  }''', 1),
    ("    curSlot = i;\n    switchT = 0.28;\n    reloadT = 0;",
     "    curSlot = i;\n    switchT = 0.28;\n    autoReloadT = 0;", 1),
    ("    fx.katana();\n    recoil = 2.5;",
     "    fx.katana();\n    recoilPitch.kick(60);\n    recoilYaw.kick(rand(-12, 12));\n    fovKick.kick(1.2);", 1),
    ("    player.regenDelay = 4.5;", "    player.lastDamageT = 0;", 1),
    ('''    for (const s of slots) {
      s.mag = s.def.magSize;
      s.reserve = s.def.reserve;
    }
    player.pos.set(0, 0.2, 38);''',
     '''    for (const s of slots) {
      s.mag = s.def.magSize;
      s.reserve = s.def.reserve;
      s.spreadCur = s.def.spread;
      s.pumpT = 0;
      s.pumped = false;
      s.reloadT = 0;
      s.reloading = false;
    }
    autoReloadT = 0;
    recoilPitch.reset();
    recoilYaw.reset();
    fovKick.reset();
    landDip.reset();
    player.sliding = false;
    player.crouching = false;
    player.sprinting = false;
    player.aiming = false;
    player.airT = 0;
    player.coyote = 0;
    player.jumpBuffer = 0;
    player.airJumps = 1;
    player.landGraceT = 0;
    player.lastDamageT = 10;
    player.roll = 0;
    player.bobPhase = 0;
    player.bobAmt = 0;
    player.stepDist = 0;
    player.pos.set(0, 0.2, 38);''', 1),
    ("      reloading: reloadT > 0,", "      reloading: slots[curSlot].reloading,", 1),
    ("      weapon: s.def.name,\n      hint: s.def.hint,",
     "      weapon: s.def.name,\n      hint: s.def.hint,\n      spreadPx: s.def.katana ? 5 : 5 + s.spreadCur * 900,", 1),
    ("damageEnemy(e, b.dmg", "damageEnemy(e, bulletDmg(b, from)", 2),
])

print("OK" if ok else "HAD MISSES")

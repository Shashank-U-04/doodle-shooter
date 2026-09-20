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

OLD_UPDATE = '''  function updatePlayer(dt: number) {
    const p = player;
    p.crouch = keys.has("ControlLeft") || keys.has("KeyC");
    p.sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");
    p.height = p.crouch ? JN : CI;

    let ix = 0;
    let iz = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
    const move = new THREE.Vector3(ix, 0, iz);
    if (move.lengthSq() > 0) move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);

    let speed = p.crouch ? VR : p.sprint && iz < 0 ? QR : PR;
    if (mouseAim) speed *= 0.8;
    if (p.dashT > 0) {
      speed *= 3.4;
      p.dashT -= dt;
    }
    p.dashCd = Math.max(0, p.dashCd - dt);

    const accel = p.onGround ? 40 : 12;
    p.vel.x += (move.x * speed - p.vel.x) * Math.min(1, accel * dt);
    p.vel.z += (move.z * speed - p.vel.z) * Math.min(1, accel * dt);
    p.vel.y -= 22 * dt;

    updateGrapple(dt);

    const wasGround = p.onGround;
    const r = resolveMove(p.pos, p.vel, p.radius, p.height, world.colliders, dt);
    p.onGround = r.onGround;
    if (p.onGround) {
      p.jumps = 0;
      if (!wasGround) recoil = Math.max(recoil, 1.2);
    }
    p.pos.x = clamp(p.pos.x, world.bounds.minX, world.bounds.maxX);
    p.pos.z = clamp(p.pos.z, world.bounds.minZ, world.bounds.maxZ);

    // regen
    p.regenDelay = Math.max(0, p.regenDelay - dt);
    if (p.regenDelay <= 0 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 11 * dt);
    p.hurtFx = Math.max(0, p.hurtFx - dt * 1.4);
    p.flashFx = Math.max(0, p.flashFx - dt * 1.2);
    p.nadeCd = Math.max(0, p.nadeCd - dt);

    // weapons
    fireCd = Math.max(0, fireCd - dt);
    switchT = Math.max(0, switchT - dt);
    if (reloadT > 0) {
      reloadT -= dt;
      if (reloadT <= 0) finishReload();
    }
    if (mouseFire && fireCd <= 0 && state === "playing") {
      fireWeapon();
      if (!slots[curSlot].def.auto) mouseFire = false;
    }
    recoil = Math.max(0, recoil - dt * 14);
    blocking = mouseAim && slots[curSlot].def.katana === true;

    // camera
    const bobT = performance.now() * 0.011;
    const moving = move.lengthSq() > 0 && p.onGround;
    const bobY = moving ? Math.sin(bobT) * 0.035 : 0;
    const bobX = moving ? Math.cos(bobT * 0.5) * 0.02 : 0;
    camera.position.set(p.pos.x + bobX, p.pos.y + (p.crouch ? JN * 0.94 : 1.6) + bobY, p.pos.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = p.yaw;
    camera.rotation.x = p.pitch;
    let roll = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      roll += rand(-1, 1) * 0.02 * shakeT * 4;
      camera.position.y += rand(-1, 1) * 0.05 * shakeT * 4;
    }
    camera.rotation.z = roll;

    // fov / ads
    const def = slots[curSlot].def;
    const targetFov = mouseAim ? def.zoom : BASE_FOV;
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();

    // viewmodel pose
    const vm = viewModels[curSlot];
    if (vm) {
      const ads = mouseAim ? 1 : 0;
      const aimX = def.katana ? 0.27 : 0.22 * (1 - ads * 0.9);
      const aimY = -0.2 + ads * 0.03 - (reloadT > 0 ? 0.14 : 0) - switchT * 0.6;
      const aimZ = -0.42 + ads * 0.12;
      vm.position.set(aimX + bobX * 0.5, aimY + bobY * 0.5, aimZ + recoil * 0.02);
      vm.rotation.set(recoil * 0.04 + (reloadT > 0 ? 0.7 : 0), 0, 0);
    }
  }'''

NEW_UPDATE = '''  function updatePlayer(dt: number) {
    const p = player;
    const s = slots[curSlot];
    const def = s.def;

    /* ----- look: the original's scheme - accumulated deltas consumed once per
       frame, scaled by .38 scoped / .62 irons while aiming ----- */
    const look = (SENS * sensitivity) / 100;
    const lookMul = p.aiming ? (def.scope ? 0.38 : 0.62) : 1;
    p.yaw -= lookX * look * lookMul;
    p.pitch = clamp(p.pitch - lookY * look * lookMul * (invertY ? -1 : 1), -1.5, 1.5);
    lookX = 0;
    lookY = 0;

    /* ----- wish direction from keys ----- */
    let mvx = 0; // strafe
    let mvy = 0; // forward
    if (keys.has("KeyW") || keys.has("ArrowUp")) mvy += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) mvy -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) mvx += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) mvx -= 1;
    const sinY = Math.sin(p.yaw);
    const cosY = Math.cos(p.yaw);
    const fl = { x: -sinY, z: -cosY }; // flat forward
    const rt = { x: cosY, z: -sinY }; // right
    let wx = rt.x * mvx + fl.x * mvy;
    let wz = rt.z * mvx + fl.z * mvy;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) {
      wx /= wl;
      wz /= wl;
    }
    const wish = Math.min(1, wl);

    p.aiming = mouseAim && !def.katana;
    const sprintHeld = keys.has("ShiftLeft") || keys.has("ShiftRight");

    /* ----- crouch & slide, the original's exact slide ----- */
    const crouchHeld = keys.has("ControlLeft") || keys.has("KeyC");
    const h0 = Math.hypot(p.vel.x, p.vel.z);
    if (crouchPressed && p.onGround && h0 > 6.3 && !p.sliding) {
      p.sliding = true;
      p.slideT = 0;
      const boost = clamp(12.8 - h0, 0, 4.5);
      if (h0 > 0) {
        p.vel.x += (p.vel.x / h0) * boost;
        p.vel.z += (p.vel.z / h0) * boost;
      }
      fx.slide();
      fovKick.kick(2.5);
      landDip.kick(-2.5);
    }
    if (p.sliding) {
      p.slideT += dt;
      if (!crouchHeld || h0 < 3.5 || p.airT > 0.35) p.sliding = false;
    }
    const crouching = (crouchHeld && p.onGround) || p.sliding;
    p.crouching = crouching;
    p.height = crouching ? JN : CI;

    /* ----- movement: the original's friction 8 / accelerate 140 on the ground,
       air-accelerate 7.5 capped at 36/s in the air ----- */
    const sprinting = (p.sprinting = sprintHeld && mvy > 0.1 && !crouching && !p.aiming);
    const v = crouching && !p.sliding ? VR : sprinting ? QR : PR;
    if (p.onGround) {
      p.coyote = 0.13;
      p.airT = 0;
      p.airJumps = 1;
      if (p.sliding) {
        // a slide keeps its speed, bleeding 6.5/s, steerable at 6/s
        if (h0 > 0) {
          const k = Math.max(0, h0 - 6.5 * dt) / h0;
          p.vel.x *= k;
          p.vel.z *= k;
        }
        if (wish > 0) {
          p.vel.x += wx * 6 * dt;
          p.vel.z += wz * 6 * dt;
          const nv = Math.hypot(p.vel.x, p.vel.z);
          if (nv > h0 && nv > 0) {
            p.vel.x *= h0 / nv;
            p.vel.z *= h0 / nv;
          }
        }
      } else {
        const fr = NR * (p.landGraceT > 0 ? 0.25 : 1);
        if (h0 > 0) {
          const k = Math.max(0, h0 - h0 * fr * dt) / h0;
          p.vel.x *= k;
          p.vel.z *= k;
        }
        if (wish > 0) {
          const along = p.vel.x * wx + p.vel.z * wz;
          const add = Math.min(v * wish - along, DR * dt);
          if (add > 0) {
            p.vel.x += wx * add;
            p.vel.z += wz * add;
          }
        }
      }
    } else {
      p.coyote -= dt;
      p.airT += dt;
      if (wish > 0) {
        const along = p.vel.x * wx + p.vel.z * wz;
        const add = Math.min(OR_ * wish - along, FR * dt);
        if (add > 0) {
          p.vel.x += wx * add;
          p.vel.z += wz * add;
        }
      }
    }

    /* ----- jump: 0.15s buffer, 0.13s coyote, one air jump at 9.6*.92 ----- */
    if (jumpPressed) p.jumpBuffer = 0.15;
    else p.jumpBuffer -= dt;
    jumpPressed = false;
    p.dashCd = Math.max(0, p.dashCd - dt);
    if (p.jumpBuffer > 0) {
      if (p.grap.active) {
        p.jumpBuffer = 0;
        grappleToggle();
      } else if (p.onGround || p.coyote > 0) {
        p.jumpBuffer = 0;
        p.coyote = 0;
        p.vel.y = XN;
        p.onGround = false;
        p.airJumps = 1;
        if (p.sliding) {
          p.vel.x *= 1.06;
          p.vel.z *= 1.06;
          p.sliding = false;
        }
        fx.jump();
        landDip.kick(-1.2);
      } else if (p.airJumps > 0) {
        p.jumpBuffer = 0;
        p.airJumps--;
        p.vel.y = XN_AIR;
        if (wish > 0) {
          const along = p.vel.x * wx + p.vel.z * wz;
          const add = Math.max(0, 7.5 * wish - along);
          p.vel.x += wx * add;
          p.vel.z += wz * add;
        }
        fx.jump();
        fovKick.kick(1.6);
        landDip.kick(-1.4);
      }
    }

    /* ----- dash: air only, X/Alt (or a crouch tap), to max(along+6, 14) ----- */
    if ((dashPressed || (crouchPressed && !p.onGround)) && !p.onGround && p.dashCd <= 0 && !p.grap.active) {
      const dx = wish > 0 ? wx : fl.x;
      const dz = wish > 0 ? wz : fl.z;
      const along = p.vel.x * dx + p.vel.z * dz;
      const target = Math.max(along + 6, 14);
      p.vel.x += dx * (target - along);
      p.vel.z += dz * (target - along);
      p.vel.y = Math.max(p.vel.y, 2);
      p.dashCd = 1.3;
      fx.dash();
      fovKick.kick(4);
      p.roll += (dx * rt.x + dz * rt.z) * 0.08;
    }
    dashPressed = false;
    crouchPressed = false;

    p.vel.y -= GRAV * dt;
    updateGrapple(dt);
    const sp3 = p.vel.length();
    if (sp3 > 48) p.vel.multiplyScalar(48 / sp3);

    const prevVelY = p.vel.y;
    const wasGround = p.onGround;
    const res = resolveMove(p.pos, p.vel, p.radius, p.height, world.colliders, dt);
    p.onGround = res.onGround;
    if (p.onGround && !wasGround) {
      // the original's landing: dip + thud scaled by impact, low friction for a
      // moment after a hard, fast landing
      const impact = clamp(-prevVelY / 14, 0, 1.5);
      landDip.kick(-impact * 6 - 0.5);
      fx.land(impact);
      if (impact > 0.8) shakeT = Math.max(shakeT, impact * 0.15);
      if (Math.hypot(p.vel.x, p.vel.z) > 9) p.landGraceT = 0.4;
    }
    p.landGraceT -= dt;

    // off the page: the original respawns you at the start and takes 20 hp
    const b = world.bounds;
    if (p.pos.y < -12 || p.pos.x < b.minX - 6 || p.pos.x > b.maxX + 6 || p.pos.z < b.minZ - 6 || p.pos.z > b.maxZ + 6) {
      p.pos.set(0, 0.2, 38);
      p.vel.set(0, 0, 0);
      damagePlayer(20, new THREE.Vector3());
      cb.onMessage("OFF THE PAGE", "redrawn at the start", 1.8);
    }

    // regen 4.5s after the last hit, 11/s, paused while sprinting or grappling
    p.lastDamageT += dt;
    if (p.lastDamageT > 4.5 && p.hp < p.maxHp && !p.sprinting && !p.grap.active)
      p.hp = Math.min(p.maxHp, p.hp + 11 * dt);
    p.hurtFx = Math.max(0, p.hurtFx - dt * 1.4);
    p.flashFx = Math.max(0, p.flashFx - dt * 1.2);
    p.nadeCd = Math.max(0, p.nadeCd - dt);

    /* ----- weapon timers: only the equipped weapon ticks, as in the original ----- */
    fireCd = Math.max(0, fireCd - dt);
    switchT = Math.max(0, switchT - dt);
    if (s.pumpT > 0) {
      s.pumpT = Math.max(0, s.pumpT - dt);
      if (!s.pumped && s.pumpT <= (def.cycleDur ?? 0) * 0.5) {
        s.pumped = true;
        fx.pump();
      }
      if (s.pumpT <= 0) s.pumped = false;
    }
    if (s.reloading) {
      s.reloadT += dt;
      if (def.reloadType === "shells") {
        // one shell every .45s until full or out of reserve
        if (s.reloadT >= def.reloadDur) {
          s.reloadT = 0;
          if (s.mag < def.magSize && s.reserve > 0) {
            s.mag++;
            s.reserve--;
            fx.shell();
            pushHud();
          } else s.reloading = false;
        }
      } else if (s.reloadT >= def.reloadDur) {
        const take = Math.min(def.magSize - s.mag, s.reserve);
        s.mag += take;
        s.reserve -= take;
        s.reloading = false;
        s.reloadT = 0;
        if (def.reloadType === "cylinder") fx.shell();
        pushHud();
      }
    }
    if (autoReloadT > 0) {
      autoReloadT -= dt;
      if (autoReloadT <= 0 && s.mag === 0 && !s.reloading) startReload();
    }
    // the original's spread model: base -> +movement, +air, +slide; tighter when aimed
    if (!def.katana) {
      let target = p.aiming ? def.adsSpread : def.spread;
      target += Math.min(h0, 24) * def.moveSpread + (p.onGround ? 0 : 0.01) + (p.sliding ? 0.008 : 0);
      if (p.aiming) target *= def.scope ? 0.03 : 0.3;
      s.spreadCur = expDamp(s.spreadCur, target, 7, dt);
    }
    if (mouseFire && fireCd <= 0 && s.pumpT <= 0 && state === "playing") {
      fireWeapon();
      if (!def.auto) mouseFire = false;
    }
    blocking = mouseAim && def.katana === true;

    /* ----- camera: the original's bob, strafe roll, springs, dynamic fov ----- */
    const hs = Math.hypot(p.vel.x, p.vel.z);
    const bobbing = p.onGround && hs > 0.6 && !p.sliding;
    p.bobAmt = expDamp(p.bobAmt, bobbing ? clamp(hs / 7, 0.3, 1.4) : 0, 8, dt);
    if (bobbing) {
      p.bobPhase += dt * (7 + hs * 0.5);
      p.stepDist += hs * dt;
      if (p.stepDist > (sprinting ? 2.5 : 2)) {
        p.stepDist = 0;
        fx.footstep(clamp(hs / 8, 0.3, 1));
      }
    }
    recoilPitch.update(dt);
    recoilYaw.update(dt);
    fovKick.update(dt);
    landDip.update(dt);
    p.roll = expDamp(p.roll, -mvx * 0.022 + (p.sliding ? -0.08 : 0), 9, dt);
    p.eyeH = expDamp(p.eyeH, crouching ? EYE_CROUCH : EYE, 14, dt);
    shakeT = Math.max(0, shakeT - dt * 2.2);

    const bobY = Math.abs(Math.sin(p.bobPhase)) * 0.03 * p.bobAmt;
    const bobX = Math.cos(p.bobPhase * 0.5) * 0.018 * p.bobAmt;
    const sh = Math.min(shakeT, 1.2);
    const jx = (Math.random() - 0.5) * sh * 0.07;
    const jy = (Math.random() - 0.5) * sh * 0.07;
    camera.position.set(p.pos.x + rt.x * bobX + jx, p.pos.y + p.eyeH + landDip.value * 0.07 + bobY + jy, p.pos.z + rt.z * bobX);
    camera.rotation.order = "YXZ";
    camera.rotation.set(
      p.pitch + recoilPitch.value + (Math.random() - 0.5) * sh * 0.035,
      p.yaw + recoilYaw.value + (Math.random() - 0.5) * sh * 0.035,
      p.roll + Math.sin(p.bobPhase * 0.5) * 0.004 * p.bobAmt,
    );
    const targetFov = p.aiming
      ? def.adsFov
      : BASE_FOV + clamp((hs - 7) / 16, 0, 1) * 8 + (sprinting ? 3 : 0) + (p.sliding ? 4 : 0) + (p.grap.active ? 3 : 0) + fovKick.value;
    camera.fov = expDamp(camera.fov, targetFov, p.aiming ? 16 : 8, dt);
    camera.updateProjectionMatrix();

    // viewmodel pose
    const vm = viewModels[curSlot];
    if (vm) {
      const ads = mouseAim ? 1 : 0;
      const aimX = def.katana ? 0.27 : 0.22 * (1 - ads * 0.9);
      const aimY = -0.2 + ads * 0.03 - (s.reloading ? 0.14 : 0) - switchT * 0.6 - landDip.value * 0.012;
      const aimZ = -0.42 + ads * 0.12 + recoilPitch.value * 0.02;
      vm.position.set(aimX + bobX * 0.5, aimY + bobY * 0.5, aimZ);
      vm.rotation.set(recoilPitch.value * 0.12 + (s.reloading ? 0.7 : 0), 0, recoilYaw.value * 0.05);
    }
  }'''

patch(E, [
    (OLD_UPDATE, NEW_UPDATE, 1),
    # mouse look: accumulate, consume per frame
    ('''  const onMouseMove = (e: MouseEvent) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    cursorSeen = true;
    if (state !== "playing") return;
    // Moving the mouse turns the view. That is the whole look system: it does
    // not wait on — and is not gated by — whether the browser granted a pointer
    // capture, because a restricted frame can refuse that outright.
    // the reference's own sensitivity: 0.0022 rad per mouse count at 100%
    const s = (0.0022 * sensitivity) / 100;
    // its spike guard too: a single wild delta (a device switch, a glitch) is
    // dropped rather than snapping the view
    let dx = e.movementX;
    let dy = e.movementY;
    if (Math.abs(dx) > 400) dx = 0;
    if (Math.abs(dy) > 400) dy = 0;
    player.yaw -= dx * s;
    player.pitch -= dy * s * (invertY ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.5, 1.5);
  };''',
     '''  const onMouseMove = (e: MouseEvent) => {
    if (state !== "playing") return;
    // Moving the mouse turns the view. That is the whole look system: it does
    // not wait on - and is not gated by - whether the browser granted a pointer
    // capture, because a restricted frame can refuse that outright.
    // The original accumulates deltas (dropping a single wild spike over 400)
    // and consumes them once per frame - see updatePlayer.
    let dx = e.movementX;
    let dy = e.movementY;
    if (Math.abs(dx) > 400) dx = 0;
    if (Math.abs(dy) > 400) dy = 0;
    lookX += dx;
    lookY += dy;
  };''', 1),
    # the edge-steer hack is gone: it made the view drift on its own
    ('''  /**
   * Lock-free steering. A sandboxed preview frame cannot take the pointer, and
   * a loose cursor stops at the window edge — so the view would lock up as soon
   * as you turned far enough to reach it. While the pointer is not captured,
   * pushing the cursor into an edge keeps turning, which makes a full circle of
   * look possible wherever the game is running. With the pointer captured this
   * does nothing at all.
   */
  const steerFromEdge = (dt: number) => {
    if (isLocked() || !cursorSeen) return;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const margin = 46;
    const rate = 2.4; // rad/s at the very edge
    const depth = (v: number, span: number) =>
      v < margin
        ? -(margin - v) / margin
        : v > span - margin
          ? (v - (span - margin)) / margin
          : 0;
    const ex = depth(cursorX, w);
    const ey = depth(cursorY, h);
    if (!ex && !ey) return;
    player.yaw -= ex * rate * dt;
    player.pitch -= ey * rate * dt * (invertY ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.5, 1.5);
  };
  const onContext = (e: Event) => e.preventDefault();''',
     "  const onContext = (e: Event) => e.preventDefault();", 1),
    ("    steerFromEdge(dt);\n", "", 1),
    # jump is buffered and handled in updatePlayer, like the original
    ('''      case "Space":
        if (player.onGround) {
          player.vel.y = XN;
          player.jumps = 1;
        } else if (player.jumps < 2) {
          player.vel.y = XN_AIR;
          player.jumps = 2;
        }
        break;''',
     '''      case "Space":
        jumpPressed = true;
        break;
      case "ControlLeft":
      case "KeyC":
        crouchPressed = true;
        break;''', 1),
    ('''      case "KeyX":
      case "AltLeft":
        if (player.dashCd <= 0 && player.grap.active === false) {
          player.dashT = 0.16;
          player.dashCd = 1.4;
          fx.grappleFire();
        }
        break;''',
     '''      case "KeyX":
      case "AltLeft":
        dashPressed = true;
        break;''', 1),
])

print("OK" if ok else "HAD MISSES")

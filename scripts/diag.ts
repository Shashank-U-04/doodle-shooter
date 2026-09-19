import * as THREE from "three";

async function main() {
  const world = await import("../src/game/world.ts");
  const district = await import("../src/game/district.ts");
  const rig = await import("../src/game/rig.ts");
  const ed = await import("../src/game/enemies-data.ts");
  const shaders = await import("../src/game/shaders.ts");
  const weapons = await import("../src/game/weapons.ts");
  console.log("imports ok");

  const eng = await import("../src/game/engine.ts");
  const audio = await import("../src/game/audio.ts");
  console.log("engine import ok", Object.keys(eng).join(","), "audio:", Object.keys(audio).join(","));

  const scene = new THREE.Scene();
  const d = district.buildDistrict(scene);
  console.log("district ok:", Object.keys(d).join(","), "children:", scene.children.length);

  const kinds = Object.keys(ed.ED ?? {});
  console.log("kinds:", kinds.join(","));
  for (const k of kinds) {
    try {
      const def = (ed.ED as any)[k];
      const r = rig.makeRig({ def } as any);
      console.log("rig ok", k, r.root.children.length);
    } catch (e) {
      console.log("RIG FAIL", k, (e as Error).message, (e as Error).stack?.split("\n")[1]);
    }
  }
  for (const k of ["boss", "eraser", "inkblot"]) {
    try {
      rig.makeBlobRig({ def: (ed.ED as any)[k] } as any, k);
      console.log("blob ok", k);
    } catch (e) {
      console.log("BLOB FAIL", k, (e as Error).message);
    }
  }
  try {
    rig.makeWaspRig({ def: (ed.ED as any).flyer } as any);
    console.log("wasp ok");
  } catch (e) {
    console.log("WASP FAIL", (e as Error).message);
  }

  console.log("shaders keys:", Object.keys(shaders).join(","));
  console.log("weapons keys:", Object.keys(weapons).join(","));
  console.log("world keys:", Object.keys(world).join(","));
}

main().catch((e) => {
  console.log("FATAL", e?.message);
  console.log(e?.stack);
});

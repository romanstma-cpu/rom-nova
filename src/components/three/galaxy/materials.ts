// Shared materials, geometry and the procedural environment for the galaxy
// scene. Everything here is deterministic and self-contained: the static
// export ships with no network access, so an external HDR/cubemap is not an
// option — the environment is rendered from a canvas gradient through PMREM.

import * as THREE from "three";

/** Deterministic PRNG. The demo universe is seeded, and a starfield that
 *  reshuffles on every mount makes renders and screenshot diffs unstable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- palette */

export const SLATE = new THREE.Color("#42557d");
export const CYAN = new THREE.Color("#38e1ff");
export const HOT = new THREE.Color("#d7f8ff");
export const BODY = new THREE.Color("#1a2440");

/** Signal strength drives a slate→cyan ramp; the token's identity hue survives
 *  only as a faint tint. State glows, identity whispers — the inverse gives
 *  rainbow marbles, which this brand has rejected twice. */
export function tokenColors(signalScore: number, hue: number) {
  const t = Math.min(1, Math.max(0, (signalScore - 35) / 55));
  const body = BODY.clone().lerp(new THREE.Color().setHSL(hue / 360, 0.45, 0.34), 0.14);
  // Was t*t, which crushed the whole middle of the range into slate: a score of
  // 60 landed at 0.2 along the ramp, so most of a healthy field rendered as the
  // same dull blue-grey and the scene read as a pile of identical marbles. The
  // gentler curve still keeps the bottom end firmly slate and the top end
  // firmly cyan — it just lets the middle be legible, which is the entire job
  // of a colour ramp.
  const emissive = SLATE.clone().lerp(CYAN, Math.pow(t, 1.35));
  if (signalScore >= 88) emissive.lerp(HOT, 0.5);
  return { body, emissive };
}

/* ------------------------------------------------------- environment map */

/** A small procedural environment: cool zenith, dark horizon, one warm key.
 *  Enough for a metallic sheen that travels across the shells as they turn,
 *  without shipping a megabyte of HDR into a static export.
 *
 *  Returns a PMREM-prefiltered texture — a 2D CubeUV texture, NOT a samplerCube,
 *  so it must be assigned to `material.envMap` and sampled by three's own PBR
 *  chunks rather than by a hand-written textureCube() call. */
export function makeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  // 1024×512, up from 512×256. PMREM derives its mip chain from this source,
  // so the low-roughness end of the chain — the sharp end, the one you actually
  // see as a highlight — was being built from a half-resolution blur.
  const w = 1024;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "#25375a");
  grad.addColorStop(0.45, "#0a0f1a");
  grad.addColorStop(1.0, "#04060a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const key = ctx.createRadialGradient(w * 0.68, h * 0.3, 0, w * 0.68, h * 0.3, h * 0.85);
  key.addColorStop(0, "rgba(140, 215, 255, 0.9)");
  key.addColorStop(0.35, "rgba(60, 120, 190, 0.28)");
  key.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  // a cooler counter-rim so the far side of a shell is not dead black
  const fill = ctx.createRadialGradient(w * 0.15, h * 0.62, 0, w * 0.15, h * 0.62, h * 0.7);
  fill.addColorStop(0, "rgba(120, 108, 220, 0.4)");
  fill.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);

  // Three tight, bright sources. A pure gradient has no edges, and an
  // environment with no edges gives a metal nothing to reflect — which is what
  // made the shells read as plastic no matter how the PBR values were tuned.
  // These are what travels across a coin as it turns.
  const softbox = (cx: number, cy: number, r: number, rgb: string, peak: number) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${rgb}, ${peak})`);
    g.addColorStop(0.55, `rgba(${rgb}, ${peak * 0.32})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  softbox(w * 0.72, h * 0.22, h * 0.16, "215, 244, 255", 1.0); // key, near-white
  softbox(w * 0.24, h * 0.34, h * 0.1, "120, 190, 255", 0.72); // cool fill
  softbox(w * 0.5, h * 0.08, h * 0.09, "168, 150, 255", 0.55); // violet zenith

  // A horizon band. Equirectangular v maps to elevation, so a bright line here
  // becomes a ring around the scene — the classic studio cue that tells the eye
  // a surface is curved and reflective rather than flat and lit.
  const band = ctx.createLinearGradient(0, h * 0.46, 0, h * 0.56);
  band.addColorStop(0, "rgba(56, 225, 255, 0)");
  band.addColorStop(0.5, "rgba(56, 225, 255, 0.30)");
  band.addColorStop(1, "rgba(56, 225, 255, 0)");
  ctx.fillStyle = band;
  ctx.fillRect(0, h * 0.46, w, h * 0.1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // The seam at u=0/1 wraps; without this the highlight tears as a coin turns.
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/* --------------------------------------------------- instanced coin material */

/** Insert `code` immediately before the first anchor that exists in `src`.
 *  Throws when none match: a no-op onBeforeCompile replace produces a material
 *  that compiles fine and looks wrong, which is far harder to notice than a
 *  crash at startup. */
function injectBefore(src: string, anchors: string[], code: string): string {
  for (const anchor of anchors) {
    if (src.includes(anchor)) return src.replace(anchor, `${code}\n${anchor}`);
  }
  throw new Error(
    `galaxy/materials: no shader anchor matched (tried ${anchors.join(", ")}). ` +
      `three's chunk names changed — update the anchor list.`,
  );
}

export interface CoinMaterialHandle {
  material: THREE.MeshStandardMaterial;
  /** advance the aura clock; call once per frame */
  setTime: (t: number) => void;
  dispose: () => void;
}

/**
 * Coin shell material.
 *
 * A MeshStandardMaterial rather than a raw ShaderMaterial on purpose: it keeps
 * three's PBR env sampling (so the PMREM CubeUV texture Just Works and gives a
 * real metallic sheen) and tone mapping, and we inject only what PBR does not
 * provide — a per-instance Fresnel aura whose colour and intensity come from
 * instanced attributes, so all N coins still draw in one call.
 */
export function makeCoinMaterial(env: THREE.Texture | null): CoinMaterialHandle {
  const material = new THREE.MeshStandardMaterial({
    color: BODY,
    // Tightened from 0.38 now that the environment has actual highlights in it
    // to reflect. A rough surface smears a sharp source back into the same grey
    // wash the old gradient environment produced.
    roughness: 0.3,
    // Metals have no diffuse term: at 0.62 the shells went black wherever the
    // environment did not hit them. Keep enough for a sheen, not enough to
    // swallow the body colour.
    metalness: 0.3,
    envMap: env,
    envMapIntensity: 1.25,
  });

  const uTime = { value: 0 };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute vec3 aEmissive;
         attribute float aScore;
         varying vec3 vAEmissive;
         varying float vAScore;
         varying vec3 vWorldNormal;
         varying vec3 vWorldView;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vAEmissive = aEmissive;
         vAScore = aScore;
         vec4 gWorld = modelMatrix * instanceMatrix * vec4(position, 1.0);
         vWorldNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
         vWorldView = normalize(cameraPosition - gWorld.xyz);`,
      );

    shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         varying vec3 vAEmissive;
         varying float vAScore;
         varying vec3 vWorldNormal;
         varying vec3 vWorldView;`,
    );

    // Add the aura after lighting resolves, so it reads as emission from the
    // shell rather than a light the shell is reflecting.
    //
    // The chunk is <opaque_fragment> on three >= r152 and <output_fragment>
    // before it. A string replace that matches nothing fails SILENTLY — the
    // material still compiles and every coin just renders dull — so verify.
    shader.fragmentShader = injectBefore(
      shader.fragmentShader,
      ["#include <opaque_fragment>", "#include <output_fragment>"],
      `float fres = 1.0 - abs(dot(normalize(vWorldNormal), normalize(vWorldView)));
         // 2.6 kept the rim hugging the silhouette so tightly it barely
         // survived being drawn; 2.0 gives it enough width to read as a lit
         // edge rather than a one-pixel outline.
         fres = pow(clamp(fres, 0.0, 1.0), 2.0);
         float pulse = 0.82 + 0.18 * sin(uTime * (1.1 + vAScore * 2.2) + vAScore * 9.0);
         // floor the rim so a low-signal coin still reads as a body in space
         vec3 aura = vAEmissive * fres * (0.9 + vAScore * 2.0) * pulse;
         // A little light across the whole shell, not just the rim, so a hot
         // coin looks lit from within instead of outlined.
         outgoingLight += aura + vAEmissive * (0.06 + vAScore * 0.3);
        `,
    );
  };
  // changing onBeforeCompile after first compile needs a new program key
  material.customProgramCacheKey = () => "rom-nova-coin-v1";

  return {
    material,
    setTime: (t: number) => {
      uTime.value = t;
    },
    dispose: () => material.dispose(),
  };
}

/** Icosahedron rather than a UV sphere: even triangle distribution, no pole
 *  pinching.
 *
 *  three's PolyhedronGeometry already normalises its normals, so these shells
 *  are smooth-shaded, not faceted — worth knowing before anyone "fixes" the
 *  shading: the small angular marks visible on a coin are the wireframe overlay
 *  from coinWireGeometry, not flat-shading artifacts. galaxy.test.ts pins the
 *  smooth normals so a future geometry swap cannot quietly reintroduce
 *  faceting. */
export function coinGeometry(detail: number): THREE.IcosahedronGeometry {
  return new THREE.IcosahedronGeometry(1, detail);
}

/** Wireframe overlay, deduplicated to unique edges. Built from a LOW detail
 *  hull on purpose — the detail-4 hull has thousands of edges per coin, which
 *  is visual noise at any realistic screen size and murders the vertex budget. */
export function coinWireGeometry(detail = 1): THREE.BufferGeometry {
  // very slightly proud of the shell, or it z-fights and disappears
  const base = new THREE.IcosahedronGeometry(1.025, detail);
  const edges = new THREE.EdgesGeometry(base, 1);
  base.dispose();
  return edges;
}

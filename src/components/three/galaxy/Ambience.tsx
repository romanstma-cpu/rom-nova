"use client";

// Background starfield and the market-temperature heat ring.
//
// Both are single Points/Mesh objects driven entirely on the GPU: the starfield
// drifts via a shader on a baked position buffer rather than rewriting 10k
// positions on the CPU every frame.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mulberry32 } from "./materials";

/* ------------------------------------------------------------- starfield */

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;

  void main() {
    vColor = color;
    // slow parallax drift; the whole field breathes rather than each star
    // moving independently, which would read as noise
    vec3 p = position;
    p.x += sin(uTime * 0.05 + aPhase) * 1.6;
    p.y += cos(uTime * 0.04 + aPhase * 1.3) * 1.2;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // twinkle is per-star phased so the sky never pulses in unison
    float tw = 0.75 + 0.25 * sin(uTime * 1.6 + aPhase * 6.2831);
    gl_PointSize = aSize * tw * uPixelRatio * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    // round, soft-edged point without needing a texture upload
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float a = smoothstep(0.25, 0.0, r);
    gl_FragColor = vec4(vColor, a);
  }
`;

export function Starfield({ count = 10000, radius = 190 }: { count?: number; radius?: number }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const rnd = mulberry32(0x5eed);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);

    const cold = new THREE.Color("#8fb7ff");
    const warm = new THREE.Color("#ffffff");
    const c = new THREE.Color();

    for (let i = 0; i < count; i++) {
      // shell distribution, biased outward so the interior stays readable
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const r = radius * (0.55 + 0.45 * Math.cbrt(rnd()));
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(th) * s * r;
      pos[i * 3 + 1] = u * r * 0.6;
      pos[i * 3 + 2] = Math.sin(th) * s * r;

      c.copy(cold).lerp(warm, rnd() * rnd());
      const dim = 0.35 + rnd() * 0.65;
      col[i * 3] = c.r * dim;
      col[i * 3 + 1] = c.g * dim;
      col[i * 3 + 2] = c.b * dim;

      size[i] = 0.9 + rnd() * rnd() * 3.4;
      phase[i] = rnd() * Math.PI * 2;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    return g;
  }, [count, radius]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2) },
    }),
    [],
  );

  useFrame(({ clock }, dt) => {
    if (dt > 0.1) return;
    if (matRef.current) matRef.current.uniforms.uTime.value = clock.elapsedTime;
  });

  return (
    <points geometry={geometry} frustumCulled={false} raycast={() => null}>
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={STAR_VERT}
        fragmentShader={STAR_FRAG}
        vertexColors
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ------------------------------------------------------------- heat ring */

// RingGeometry emits PLANAR uvs (bounding-box mapped), not (angle, radial),
// so the gradient is computed from local position instead.
const RING_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Temperature is a single 0..1 reading of the whole market. The ring shows it
// as a gradient sweeping the circumference so it is readable at a glance from
// any camera angle, with a travelling highlight to keep it from looking static.
const RING_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uTemp;
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vPos;

  const float TAU = 6.28318530718;

  void main() {
    vec3 cold = vec3(0.16, 0.28, 0.47);
    vec3 mid  = vec3(0.22, 0.88, 1.00);
    vec3 hot  = vec3(1.00, 0.71, 0.33);

    vec3 base = uTemp < 0.5
      ? mix(cold, mid, uTemp * 2.0)
      : mix(mid, hot, (uTemp - 0.5) * 2.0);

    float angle = atan(vPos.y, vPos.x) / TAU + 0.5;
    float radial = clamp((length(vPos) - uInner) / max(0.0001, uOuter - uInner), 0.0, 1.0);

    // one highlight travelling the ring; speed scales with temperature
    float sweep = fract(angle - uTime * (0.03 + uTemp * 0.09));
    float glow = smoothstep(0.0, 0.12, sweep) * smoothstep(0.34, 0.12, sweep);

    // soften both edges of the band so it does not read as a hard hoop
    float edge = smoothstep(0.0, 0.35, radial) * smoothstep(1.0, 0.65, radial);

    float a = (0.10 + glow * 0.55) * edge;
    gl_FragColor = vec4(base * (0.5 + glow * 1.5), a);
  }
`;

export function HeatRing({ temperature, radius = 62 }: { temperature: number; radius?: number }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uTemp: { value: THREE.MathUtils.clamp(temperature, 0, 1) },
      uInner: { value: radius },
      uOuter: { value: radius * 1.16 },
    }),
    // temperature is eased through the material ref below rather than by
    // rebuilding the uniform object on every data refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [radius],
  );

  useFrame(({ clock }, dt) => {
    if (dt > 0.1) return;
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value = clock.elapsedTime;
    // ease toward the target so a data refresh does not snap the colour
    const cur = m.uniforms.uTemp.value as number;
    m.uniforms.uTemp.value = cur + (THREE.MathUtils.clamp(temperature, 0, 1) - cur) * Math.min(1, dt * 1.5);
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} frustumCulled={false}>
      <ringGeometry args={[radius, radius * 1.16, 192, 1]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={RING_VERT}
        fragmentShader={RING_FRAG}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

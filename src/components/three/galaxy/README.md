# galaxy/ — the 3D scene module

All three.js logic lives here. The React surface above it (`../Network3D.tsx`)
owns only the `<Canvas>` and the context-loss UI, so pages import one component
and never touch three directly.

```
Network3D.tsx        <Canvas>, renderer policy, context-loss fallback
└── GalaxyScene.tsx  camera, quality governor, layer composition
    ├── TokenField   coins: instanced LOD pair, Fresnel aura, hover
    ├── WalletField  wallets: instanced, bucketed by kind
    ├── Trails       orbital trails (ring buffer → one LineSegments)
    ├── WhaleArcs    Bézier whale moves with a travelling dash
    ├── Ambience     starfield + market heat ring
    ├── SignalPods   floating cards for top-conviction coins
    └── materials.ts shared palette, procedural env, coin material
```

## Dependencies

No new packages. The scene is built on what the app already ships:

| package                       | version   | note                                        |
| ----------------------------- | --------- | ------------------------------------------- |
| `three`                       | `0.185.1` | see the version note below                  |
| `@react-three/fiber`          | `9.7.0`   | React 19 renderer                           |
| `@react-three/drei`           | `10.7.8`  | `OrbitControls`, `Html`                     |
| `@react-three/postprocessing` | `3.1.0`   | `Bloom`, `Vignette` (tier-2 only)           |

**On `three@0.160.0`:** the upgrade brief asked for it; this module is built
against **0.185.1** instead, deliberately. R3F 9 / drei 10 / postprocessing 3
all require a considerably newer three than 0.160, and pinning back would break
the render stack rather than stabilise it. Nothing here depends on an API newer
than 0.160 *except* the shader-chunk name below, which is handled by feature
detection rather than a version check.

### The one version-sensitive point

`makeCoinMaterial` injects the Fresnel aura through `onBeforeCompile`, anchored
on the material's output chunk. That chunk is `<opaque_fragment>` on three
≥ r152 and `<output_fragment>` before it.

A `String.replace` whose pattern does not match **fails silently** — the
material still compiles and every coin simply renders dull. That exact bug cost
a debugging round during this build, so `injectBefore()` tries each known anchor
and **throws** when none match, instead of shipping a scene that looks subtly
wrong. If a future three release renames it again, the app fails loudly at
startup with the anchor list in the message.

## Performance

Targets *perceived smoothness*, not a number. Three mechanisms:

**Draw-call collapse.** Every coin is one `InstancedMesh` per LOD tier and every
wallet one per kind, so the field is a fixed handful of draw calls regardless of
universe size — 64 tokens + 30 wallets go from ~94 draws to 6.

**LOD.** Coins inside `LOD_DISTANCE` (95 units) draw as detail-4 icosahedra with
the full PBR + aura shader; beyond it, detail-2 with a flat basic material and no
env sampling. Buckets are repartitioned at 6 Hz, not per frame: repartitioning
every frame costs more than it saves and makes coins visibly pop between tiers as
the camera drifts across the boundary.

**Adaptive tiers.** `QualityGovernor` samples frame time over 1.2 s windows and
steps down when it sees sustained sub-30 fps — first dropping post-processing
(bloom is the single most expensive pass here), then pixel ratio. Degradation is
**sticky**: oscillating between tiers is more distracting than sitting one tier
lower. Pixel ratio is capped at 2 on the way in, since a 3× phone panel
quadruples fragment cost for detail nobody can resolve.

Additionally, every `useFrame` returns early when `delta > 100 ms`. A tab
returning from the background delivers one enormous delta; integrating it
teleports every coin and snaps the camera.

### Expected on a GTX 1060

Comfortably smooth at 1080p with everything on — the geometry budget is small
(the near tier is ~64 × 1280 triangles) and the field is fill-bound rather than
vertex-bound, so bloom dominates the frame. Expect the governor to stay at tier 2
and never trip. At 1440p, or on a laptop 1050/integrated part, expect it to shed
post-processing once and then hold steady; the scene keeps its silhouette
lighting and instancing at every tier, so tier 1 still reads as the same picture
with less glow.

The starfield is 10k GPU points with drift and twinkle computed in the vertex
shader from one uniform — no per-frame CPU work and no buffer re-upload.

## Data contract

`GalaxyScene` is pure with respect to its props: give it a `NetworkPayload` and
it renders. Positions come from `layoutNetwork()` in `../graph.ts` and are
*lerped toward*, never snapped, so a mode change or a WebSocket refresh glides.
To drive it live, replace the payload — no imperative scene API is exposed or
needed.

Signals are **not** computed here. They come from `src/lib/engine/signals.ts`,
which is shared with the scanner, backtester and paper desk; a signal id must
recompute bit-for-bit across all of them, so the scene reads scores and never
derives them.

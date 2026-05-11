# services/higgsfield.js — file map

This is the largest single file in the codebase (~1,478 LOC). The
internal carve into `providers/`, `models/`, `lifecycle/` is tracked
as a Phase 5 refactor in PUNCHLIST. Until then, this README is the
navigation map for future engineers.

> **NOTE:** The file is at `services/higgsfield.js`, not `services/higgsfield/index.js`.
> This README lives in a folder of the same name because Node resolves
> `require('./services/higgsfield')` to the file first and only falls back
> to `./services/higgsfield/index.js` if the file doesn't exist. Once the
> internal carve happens, the folder takes over.

## Public API (returned by `createHiggsfieldService(deps)`)

| Method | What it does |
|---|---|
| `modelForCapability(cap)` | Pure helper. cap='image' → 'nano_banana', 'video' → 'kling', 'soul' → 'soul_v2', 'cinema' → 'cinema_studio'. |
| `pathForModel(modelId)` | Maps model id to Higgsfield path string. |
| `generateProductImage(...)` | Cloud-first → FNF fallback. ~80 LOC. |
| `generateProductVideo(...)` | Two-step: generate image, then animate. |
| `generateHeroAd(...)` | High-stakes ad creative path. |
| `scoreContent(...)` | Claude vision + text scoring on the generated asset. |
| `generateCaption(...)` | Per-platform caption gen after image lands. |
| `schedule30DaysClaude(...)` | Bulk schedule across content pieces. |
| `processProductCatalog(...)` | E-commerce SKU loop. |
| `vetCustomerAsset(...)` / `vetCustomerAssetBatch(...)` | Customer-uploaded image vetting. |
| `smartProcessAsset(...)` / `smartProcessAssetRegenerate(...)` | Vetting → process / regenerate pipeline. |
| `developCreativeConcept(...)` | Concept brief generation. |
| `trainSoulCharacter(...)` | Soul ID training entry point. |

## File sections (line ranges)

| Section | Lines | What's there |
|---|---|---|
| Module factory + env reads | 1-79 | `createHiggsfieldService` entry. All env-derived constants live here. |
| Path constants | 36-78 | 20+ model path constants (Soul, Kling, Sora, DoP, Seedream, Seedance, Veo, Nano Banana, Wan, Flux Kontext, Cinema, Vibe Motion). All overridable via env. |
| Capability → model resolver | 122-134 | `modelForCapability`, `pathForModel`. |
| Supabase asset mirror | 136-204 | `downloadImageBuffer`, `uploadBufferToContentImages`, `mirrorHiggsfieldImageToSupabase`, `persistGeneratedImageUrl`. Customer assets stored in `content-images` bucket. |
| HTTP layer | 206-285 | `higgsfieldUrl`, `keyAuthHeaders`, `parseJsonBody`, `extractRequestId`, `statusNorm`, `extractImageResultUrl`, `extractVideoResultUrl`, `hfPost`, `hfGet`. |
| Polling loop | 286-355 | `pollRequestStatus` — handles 'queued', 'processing', 'completed', NSFW terminal states. |
| Submit + wait helpers | 357-438 | `submitSoulAndWait`, `submitVideoAndWait`. |
| Cancellation | 439-448 | `cancelRequest` for cleaning up stuck jobs. |
| Brand-context helpers | 450-460 | `brandText` — extracts text from brand DNA. |
| **Claude vision + text calls** | **461-510** | `claudeVision`, `claudeText`. **Both have TODO(callClaude-migration) comments** — they bypass `callClaude` so cost tracking + budget gates don't apply. PUNCHLIST item 7 tracks the migration. |
| SerpAPI niche context | 513-520 | Pulls competitor context for prompts. |
| Product image generation | 522-616 | `generateProductImage` + `submitImageOnPath` — the core image creation pipeline. |
| Product video generation | 618-643 | `generateProductVideo` — extends image with motion. |
| Hero ad generation | 645-668 | `generateHeroAd` — high-CTR ad creative path. |
| Scoring | 670-755 | `runScoreDimensions`, `scoreContent` — Claude-judged quality scoring. |
| Caption generation | 757-790 | `generateCaption` — per-platform caption + hashtags. |
| Scheduling | 792-803 | `schedule30DaysClaude`. |
| Plan normalization | 805-810 | `normalizePlan`. |
| Product catalog pipeline | 811-942 | `processProductCatalog` — e-commerce bulk processing. |
| Asset vetting | 943-1016 | `vetCustomerAsset`, `vetCustomerAssetBatch`, `smartProcessAsset`, `smartProcessAssetRegenerate`. |
| Creative concept | 1034+ | `developCreativeConcept` — concept brief gen. |
| Soul ID training | (remaining) | `trainSoulCharacter` + Cloud/FNF fallback logic. |

## Why it's one big closure (and not refactored yet)

The original n8n-era code stored all state in a single `createHiggsfieldService(deps)` closure so deps (`sbGet`, `sbPost`, `callClaude`, `logger`, env keys) could be referenced by name from every helper without explicit threading. That pattern works fine at this size; refactoring requires either:

1. **Module-level closure leak** — set deps at module init via a `configure(deps)` call. Discouraged because it makes the module non-reentrant.
2. **Explicit dep threading** — pass `(deps, ...args)` to every internal helper. Verbose but clean.
3. **Class-based** — `new HiggsfieldClient(deps)` with all helpers as methods. Clean but a stylistic shift from the rest of `services/`.

The Phase 5 plan is option (2): extract `providers/cloud.js` + `providers/fnf.js` + `models/{soul,kling,seedance,...}.js` + `lifecycle.js` (polling + cancellation) + a thin `index.js` facade. Each module takes `deps` as its first arg.

## Testing notes

`tests/higgsfield-models.test.js` covers prompt builders (the deterministic helpers). The HTTP-call layer + polling + fallback chain are not yet tested — see PUNCHLIST item: "Add contract tests for higgsfield" (Phase 5). Until then, breakage is detected by customer-reported issues, not by CI.

Recommended approach for adding tests: use `tests/helpers/fakeHiggsfield.js` to fake the Cloud + FNF API surface, then test the resolver / fallback / polling logic against the fake. The factory accepts a `fetch` override via a deps property — wire it through in the constructor.

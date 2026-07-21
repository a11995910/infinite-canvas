# Canvas Asset Reference Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Implement this plan inline in the current task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow canvas image generation to select multiple image assets as visible connected reference nodes, and extend AI image request timeouts to 10 minutes.

**Architecture:** Reuse the existing asset picker, canvas image nodes, canvas connections, and `NodeGenerationContext` instead of storing a second hidden reference list. Add an image-only multi-select mode to the picker, create compact image nodes beside the generation target, connect them in selection order, and let the existing reference hydration and retry metadata handle them.

**Tech Stack:** React, TypeScript, Ant Design, Zustand, Axios, existing canvas node and asset APIs.

## Global Constraints

- Keep the existing canvas theme and flat, low-visual-weight controls.
- Preserve original image aspect ratios.
- Do not add backend assumptions; assets remain browser-local.
- Do not run syntax checks, builds, or tests for this task, per `AGENTS.md`.

---

### Task 1: Add image-only multi-select to the asset picker

**Files:**
- Modify: `web/src/components/canvas/asset-picker-modal.tsx`

**Interfaces:**
- Consumes: existing `Asset` values from `useAssetStore`.
- Produces: `onSelectImages(payloads: ImageAssetPayload[])` in selection order.

- [x] Add an explicit `select-images` mode without changing the default insert mode.
- [x] Filter the modal to image assets, show selected state and count, and confirm all selections together.
- [x] Include stored dimensions and MIME type in image payloads so canvas nodes preserve source geometry and metadata.

### Task 2: Connect selected assets as canvas reference nodes

**Files:**
- Modify: `web/src/components/canvas/canvas-config-node-panel.tsx`
- Modify: `web/src/components/canvas/canvas-node-prompt-panel.tsx`
- Modify: `web/src/pages/canvas/project.tsx`

**Interfaces:**
- Consumes: `ImageAssetPayload[]` from Task 1 and a target canvas node id.
- Produces: compact `CanvasNodeType.Image` nodes and ordered connections into the generation target.

- [x] Add a flat icon action to image-generation panels that opens the image-only picker.
- [x] Create reference nodes beside the target, preserving aspect ratio and local storage metadata.
- [x] Skip duplicate references already connected to the same target and keep composer references active when applicable.
- [x] Combine an existing image node's own source image with additional connected references for multi-image editing.

### Task 3: Extend generation request timeout and document behavior

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/services/api/model-plugin.ts`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: 600000 ms timeout for direct image API requests and model-script HTTP/poll helpers.

- [x] Apply the 10-minute timeout to OpenAI-compatible and Gemini image calls while preserving caller cancellation signals.
- [x] Extend model-script HTTP requests and default/example polling deadlines to 10 minutes.
- [x] Add one pending-test entry and one concise `Unreleased` changelog entry.

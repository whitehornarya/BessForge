# Manual Auto Align + 10 ft road clearance

## Goal

1. Make **equipment ↔ road edge = 10 ft** everywhere Auto Scan / packing / compliance already read `CLEARANCES.equipmentToRoadEdge` (was **8.0625**).
2. Add **Auto Align** for Manual Placement selections: recompose a PCS + BESS block to Auto Scan PCS/battery gaps and snap the PCS outer face to that same **10 ft** road clearance.
3. Scope this pass to **roads, PCS, and batteries only**. Other equipment (aux, panels, laydown) stays out of Auto Align until a later pass.

Keep existing Align X / Align Y (centroid) unchanged.

## 1. Catalog road clearance → 10 ft

In [`catalog.ts`](../client/src/lib/nextera/catalog.ts):

```ts
equipmentToRoadEdge: 10, // was 8.0625 (8'-0 3/4")
```

Downstream (no separate magic numbers — they already use the constant):

- `ROW_AISLE_GAP_FT` → `24 + 2×10 = 44` (was 40.125)
- `equipmentMarginFor` roads mode → `10 + 24 + 10 = 44` (was 42.0625)
- Aisle encroachment checks, drawn-road pad inflation defaults, etc.

Also update **hardcoded copy** that still says `8'-0 3/4"`:

- [`SheetAnnotations2D.tsx`](../client/src/components/SheetAnnotations2D.tsx) key note
- [`complianceReport.ts`](../client/src/lib/nextera/complianceReport.ts) kn5 labels
- Any matching comments in [`layoutEngine.ts`](../client/src/lib/nextera/layoutEngine.ts) / DXF notes if present

## 2. Auto Align (PCS + batteries + road)

### Spacing rules (this tool — same as Auto Scan after step 1)

- PCS ↔ containers: **10 ft** (`CLEARANCES.pcsStandard`) for this tool (not hot-climate 14)
- Container / mirrored-pair geometry: via `composeManualPcsBatteries`
- PCS outer face ↔ road edge: **`CLEARANCES.equipmentToRoadEdge` (10 ft)** after the catalog change

### Supported selection

- Exactly **1 PCS** + **2 or 3 BESS** → full recompose + road snap
- Exactly **1 PCS** alone → road snap only
- Anything else → toast error (aux/panels/etc. not in this pass)

### Algorithm

1. Resolve member ids like `alignManualSelection`.
2. Classify inverter vs bess.
3. Recompose (2–3 batteries) with `composeManualPcsBatteries` + `pcsClearance = CLEARANCES.pcsStandard`.
4. Road snap from `design.roads` / aisles so PCS outer face (opposite batteries) sits `equipmentToRoadEdge` outside the nearest road edge.
5. Write `placedEquipment` (preserve peq ids; rematch batteries by nearest old pose).
6. `regenerate` + `pushHistory`.

Helper in `layoutEngine.ts`; UI button **Auto Align** in `DesignControlPanel.tsx` next to Align X/Y.

## Equipment spacing (reference)

### In scope now — roads, PCS, batteries

- PCS ↔ battery: **10 ft** standard / **14 ft** hot (Auto Align uses **10**)
- Container front↔front **10** · rear↔rear **3** · side↔side **3**
- Pair inner / A-3 gaps **3** · pair↔pair **10/14** · N↔S aux corridor **10**
- Equipment ↔ road edge: **10 ft** (catalog + Auto Scan + Auto Align)
- Road width **24** · row aisle pitch **44** after catalog change

### Later (not Auto Align this pass)

- Fence / lot / NFPA setbacks
- Aux transformers, switchgear, island mid-gear, FJB
- Small panels, manual catalog PAD, laydown
- DXF-only PE door notes
- Feeder / grounding / substation spacing

## Out of scope (this pass)

- Auto Align for aux, panels, laydown, or multi-PCS selections
- Replacing Align X / Align Y
- Changing hot-climate PCS↔container from 14 (Auto Scan still uses hot when `hotClimate`; Auto Align forces 10 for the recomposed block)

## Verify

- New/regen Auto Scan: equipment faces sit **10 ft** from aisle edges; row pitch **44 ft**
- Sheet/compliance key note 5 reads **10 ft** (not 8'-0 3/4")
- Skewed PCS + 3 BESS → Auto Align: internal Auto Scan gaps + PCS outer face 10 ft from road
- Aux-only selection → error toast; Align X/Y unchanged

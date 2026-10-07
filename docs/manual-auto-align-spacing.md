# Manual Auto Align + road / PCS spacing

## Goal

1. Keep **equipment ↔ road edge = 8.0625 ft** (`CLEARANCES.equipmentToRoadEdge`, 8′-0¾″) for Auto Scan packing, compliance, and Auto Align road snap.
2. **Auto Align** for Manual Placement: recompose a PCS + BESS block to Auto Scan PCS/battery gaps (**10 ft** `pcsStandard`) and snap the PCS outer face to `equipmentToRoadEdge` from the nearest road.
3. Scope: **roads, PCS, and batteries only**. Other equipment stays out of Auto Align until a later pass.

Keep existing Align X / Align Y (centroid) unchanged.

## Catalog road clearance

```ts
equipmentToRoadEdge: 8.0625, // 8'-0 3/4" min distance to road edge
```

Downstream (via the constant):

- `ROW_AISLE_GAP_FT` → `24 + 2×8.0625 = 40.125`
- `equipmentMarginFor` roads mode → `10 + 24 + 8.0625 = 42.0625`
- Sheet / compliance / DXF key note 5 copy: `8'-0 3/4"`

## Auto Align (PCS + batteries + road)

### Spacing rules

- PCS ↔ containers: **10 ft** (`CLEARANCES.pcsStandard`) for this tool (not hot-climate 14)
- Container / mirrored-pair geometry: via `composeManualPcsBatteries`
- PCS outer face ↔ road edge: **`CLEARANCES.equipmentToRoadEdge` (8.0625 ft)**

### Supported selection

- Exactly **1 PCS** + **2 or 3 BESS** → full recompose + road snap
- Exactly **1 PCS** alone → road snap only
- Anything else → toast error

### Algorithm

1. Resolve member ids like `alignManualSelection`.
2. Classify inverter vs bess.
3. Recompose (2–3 batteries) with `composeManualPcsBatteries` + `pcsClearance = CLEARANCES.pcsStandard`.
4. Road snap from aisles + gate entrance (`design.roads`) + each leg of `layoutEdits.customRoads` via `collectAutoAlignRoadSegments`. `design.roads` alone is gate-only and is often empty on Manual Placement yards.
5. Write `placedEquipment` (preserve peq ids; rematch batteries by nearest old pose).
6. `regenerate` + `pushHistory`.

Helper in `layoutEngine.ts`; UI button **Auto Align** in `DesignControlPanel.tsx` next to Align X/Y.

## Equipment spacing (reference)

### In scope — roads, PCS, batteries

- PCS ↔ battery: **10 ft** standard / **14 ft** hot (Auto Align uses **10**)
- Container front↔front **10** · rear↔rear **3** · side↔side **3**
- Pair inner / A-3 gaps **3** · pair↔pair **10/14** · N↔S aux corridor **10**
- Equipment ↔ road edge: **8.0625 ft** (catalog + Auto Scan + Auto Align)
- Road width **24** · row aisle pitch **40.125**

### Later (not Auto Align this pass)

- Fence / lot / NFPA setbacks
- Aux / panels / laydown / multi-PCS

## Verify

- Auto Scan: equipment faces sit **8.0625 ft** from aisle edges; row pitch **40.125 ft**
- Sheet/compliance key note 5 reads **8′-0¾″**
- Auto Align: PCS↔batt **10 ft**; PCS outer face **~8.0625 ft** from nearest aisle/custom strip

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

- One or more PCS groups in the selection / active group(s)
- Each group: **1 PCS** + **0, 2, or 3 BESS** (named `manualGroups` preferred; otherwise batteries cluster to the nearest PCS)
- Non-PCS/BESS in the selection → toast error

### Algorithm

1. Resolve member ids like `alignManualSelection`.
2. Partition into PCS groups (`partitionManualPcsGroups`).
3. For each group: recompose with `composeManualPcsBatteries` + `pcsClearance = CLEARANCES.pcsStandard`, then road-snap via `computeManualBlockAutoAlign`.
4. Road targets from aisles + gate entrance + `customRoads` legs (`collectAutoAlignRoadSegments`).
5. Merge all pose updates into one `placedEquipment` write.
6. `regenerate` + `pushHistory` (`Auto-aligned N PCS groups`).

Helpers in `layoutEngine.ts`; UI button **Auto Align** in `DesignControlPanel.tsx` next to Align X/Y.

## Equipment spacing (reference)

### In scope — roads, PCS, batteries

- PCS ↔ battery: **10 ft** standard / **14 ft** hot (Auto Align uses **10**)
- Container front↔front **10** · rear↔rear **3** · side↔side **3**
- Pair inner / A-3 gaps **3** · pair↔pair **10/14** · N↔S aux corridor **10**
- Equipment ↔ road edge: **8.0625 ft** (catalog + Auto Scan + Auto Align)
- Road width **24** · row aisle pitch **40.125**

### Later (not Auto Align this pass)

- Fence / lot / NFPA setbacks
- Aux / panels / laydown

## Verify

- Auto Scan: equipment faces sit **8.0625 ft** from aisle edges; row pitch **40.125 ft**
- Sheet/compliance key note 5 reads **8′-0¾″**
- Auto Align: one or more PCS groups; PCS↔batt **10 ft**; PCS outer face **~8.0625 ft** from nearest aisle/custom strip
- Multi-select two PCS+3 groups → both align; bad battery counts → clear error
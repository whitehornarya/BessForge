// Real procurement parts catalog, transcribed VERBATIM from the issued-for-90%
// NextEra package "Carousel Energy Storage, 149.6 MW / 598.4 MWH battery
// system" bill of materials sheets:
//   CAR-D-B018-1 rev 0B (BILL OF MATERIALS SHEET 1) — bus/conductor, rubber
//     goods/surge arresters, equipment, patch panel & comms, hardware, conduit
//   CAR-D-B018-2 rev 0B (BILL OF MATERIALS SHEET 2) — conduit (cont.),
//     equipment labels, grounding
//
// Text fidelity is character-for-character against the issued sheets, which
// are internally inconsistent — that is intentional and must be preserved:
//   - mixed-case unit tokens ("350 kcmil" but "600 KCMIL", "35 KV" but
//     "34.5 kV", "5.1 MWh", "Type PV", "9/125um")
//   - mixed-case manufacturers ("Southwire", "CORNING OR EQUAL" vs
//     "CORNING or EQUAL", "BURNDY or EQUAL", "NORDIC OR EQUAL")
//   - sheet typos kept verbatim ("INSULATING CAB", "BATTEY EXTERNAL GROUND",
//     "O.DX", the K4D catalog placeholder "(where to find?)")
//   - "AS REQ'D" with the apostrophe
//   - blank cells ('') vs literal dash cells ('-') vs H32's double dash ('--')
//   - H33 child quantities printed with a thousands comma ("1,160"); no other
//     row uses commas (qtyComma flag)
//
// Package reference design counts (drive the quantity scaling below):
//   51 PCS units (Power Electronics FP4200M1), 145 LG JF2 containers
//   (74 "A" + 71 "C"), 4 islands (1 aux transformer + 1 aux distribution
//   center + 1 fiber junction box per island).
//
// Quantities on the sheets are for THAT site. `derivePartQty` scales them to
// any generated design: rows with an exact per-entity basis (verified integer
// ratios against the package counts) scale exactly; all other numeric rows
// scale proportionally by container count and are flagged `estimated`.
// "AS REQ'D" rows pass through untouched.

export const AS_REQD = "AS REQ'D" as const;
export type PkgQty = number | typeof AS_REQD;

export interface PackagePart {
  section: PartSection;
  /** Item tag from the BOM sheet (assembly children get parent.N tags). */
  item: string;
  /** Manufacturer ('' where the sheet cell is blank, '-' where it shows a dash). */
  mfgr: string;
  /** Manufacturer catalog / part number ('' blank, '-' dash, '--' double dash — verbatim). */
  catalogNo: string;
  description: string;
  /** Package quantity — a number, or "AS REQ'D" verbatim from the sheet. */
  qty: PkgQty;
  unit: 'EA' | 'FT';
  /** '' where the sheet cell is blank (K4C, K8C). */
  furnishedBy: 'CONTRACTOR' | 'NEXTERA' | 'BATTERY MANUFACTURER' | 'BY POWER ELECTRONICS' | '';
  notes?: string;
  /** Hardware-assembly child row (sheet prints blank ITEM/MFGR, indented under parent). */
  child?: true;
  /** Sheet prints this row's quantity with a thousands comma (H33 children only). */
  qtyComma?: true;
}

export type PartSection =
  | 'BUS/CONDUCTOR'
  | 'RUBBER GOODS/ SURGE ARRESTERS'
  | 'EQUIPMENT'
  | 'PATCH PANEL & COMMS'
  | 'HARDWARE'
  | 'CONDUIT'
  | 'EQUIPMENT LABELS'
  | 'GROUNDING';

/** Reference design counts of the 90% package site (CAR-D-B001/B002 series). */
export const PACKAGE_DESIGN_COUNTS = {
  pcsUnits: 51,
  containers: 145,
  containersA: 74,
  containersC: 71,
  islands: 4,
} as const;

const C = 'CONTRACTOR' as const;
const N = 'NEXTERA' as const;
const BM = 'BATTERY MANUFACTURER' as const;
const PE = 'BY POWER ELECTRONICS' as const;
const HOLD_CUT = 'HOLD FOR CABLE CUT SHEETS';

/**
 * Hardware bolt-assembly parent rows exactly as printed on CAR-D-B018-1:
 * ITEM + MFGR + "STAINLESS STEEL BOLT ASSEMBLY:" with QUANTITY/UNIT/FURNISHED
 * BY blank; H30/H32/H33 carry their application in the NOTES column (the
 * "BATTEY" typo is the sheet's, kept verbatim).
 */
export const HARDWARE_ASSEMBLIES: Record<string, { mfgr: string; description: string; notes?: string }> = {
  H13: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:' },
  H22: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:' },
  H24: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:' },
  H27: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:' },
  H30: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:', notes: 'BATTERY AUX.' },
  H32: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:', notes: 'BATTEY EXTERNAL GROUND' },
  H33: { mfgr: 'BURNDY or EQUAL', description: 'STAINLESS STEEL BOLT ASSEMBLY:', notes: 'BATTERY DC' },
};

export const PACKAGE_BOM: PackagePart[] = [
  // ------------------------------------------------- BUS/CONDUCTOR
  { section: 'BUS/CONDUCTOR', item: 'A2', mfgr: 'BURNDY', catalogNo: 'YA8CTC14', description: 'TERMINAL, COMPRESSION, NEMA 1-HOLE PAD, LONG BARREL, W/O INSPECTION WINDOW, 1/4" STUD HOLE, COPPER, #8 AWG', qty: 145, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A3', mfgr: 'BURNDY', catalogNo: 'YA8CA3', description: 'TERMINAL, COMPRESSION, NEMA 1-HOLE PAD, STANDARD BARREL, W/O INSPECTION WINDOW, 1/4" STUD HOLE, ALUMINUM/COPPER, #8 AWG', qty: 435, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A147', mfgr: 'BURNDY', catalogNo: 'YA34A3', description: 'TERMINAL, COMPRESSION, NEMA 2-HOLE PAD, STANDARD BARREL, W/O INSPECTION WINDOW, 1/2" STUD HOLE, 1-3/4" STUD HOLE SPACING, ALUMINUM/COPPER, 350 kcmil', qty: 96, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A150', mfgr: 'BURNDY', catalogNo: 'YA36A3', description: 'TERMINAL, COMPRESSION, NEMA 2-HOLE PAD, STANDARD BARREL, W/O INSPECTION WINDOW, 1/2" STUD HOLE, 1-3/4" STUD HOLE SPACING, ALUMINUM/COPPER, 600 KCMIL', qty: 2320, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A157', mfgr: 'M3', catalogNo: 'QL2-A-350-750', description: 'TERMINAL, SHEERBOLT, 2-HOLE MECHANICAL LUG KIT, 500 kcmil', qty: 3, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A166', mfgr: 'M3', catalogNo: 'QL2-A-1500-2000', description: 'TERMINAL, SHEERBOLT, 2-HOLE MECHANICAL LUG KIT, 1500 kcmil', qty: 24, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A390', mfgr: 'CHANCE', catalogNo: 'CCS820', description: 'CABLE POSITIONER', qty: 27, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A391', mfgr: 'SSZ', catalogNo: '350020', description: 'CABLE CLAMPS', qty: 27, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A398', mfgr: '3M', catalogNo: '7665-S-8', description: 'TERMINATION KIT, 35 KV, SILICON RUBBER, COLD SHRINK, #3/0 AWG - 600 kcmil', qty: 3, unit: 'EA', furnishedBy: N },
  { section: 'BUS/CONDUCTOR', item: 'A399', mfgr: '3M', catalogNo: '7666-S-8', description: 'TERMINATION KIT, 35 KV, SILICON RUBBER, COLD SHRINK, 700 kcmil - 1500 kcmil', qty: 24, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A400', mfgr: 'SALISBURY', catalogNo: '21846', description: 'BALL STUD, 90 OFFSET, NEMA PAD', qty: 12, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A401', mfgr: 'SALISBURY', catalogNo: '21236', description: 'COVER FOR BALL STUD', qty: 12, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A402', mfgr: 'BURNDY', catalogNo: 'COVERYA4BLK', description: 'COVER FOR SPADE W/HOT STICK TAB', qty: 12, unit: 'EA', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A420', mfgr: 'SCOTCH', catalogNo: 'SCOTCH 35', description: 'PHASE/POLARITY TAPE', qty: AS_REQD, unit: 'FT', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A501', mfgr: 'PRYSMIAN or EQUAL', catalogNo: '851663', description: 'CONDUCTOR, 1500 kcmil, MV-105, 34.5 kV, 345 mil (100%) TR-XLPE, AL, 1/6 JCN (ROUND, 17-#12 AWG), XLPE JACKET', qty: 24660, unit: 'FT', furnishedBy: C, notes: HOLD_CUT },
  { section: 'BUS/CONDUCTOR', item: 'A502', mfgr: 'PRYSMIAN or EQUAL', catalogNo: '721318', description: 'CONDUCTOR, 1000 kcmil, MV-105, 34.5 kV, 345 mil (100%) TR-XLPE, AL, 1/6 JCN (ROUND, 29-#16 AWG), XLPE JACKET', qty: 3120, unit: 'FT', furnishedBy: C, notes: HOLD_CUT },
  { section: 'BUS/CONDUCTOR', item: 'A503', mfgr: 'PRYSMIAN or EQUAL', catalogNo: '427536', description: 'CONDUCTOR, 500 kcmil, MV-105, 34.5 kV, 345 mil (100%) TR-XLPE, AL, 1/3 JCN (ROUND, 29-#16 AWG), XLPE JACKET', qty: 9015, unit: 'FT', furnishedBy: C, notes: HOLD_CUT },
  { section: 'BUS/CONDUCTOR', item: 'A577', mfgr: 'Southwire', catalogNo: '-', description: 'CONDUCTOR, #8 AWG, CU, XHHW-2, 600 V, 45 mil XLPE', qty: 60075, unit: 'FT', furnishedBy: C, notes: HOLD_CUT },
  { section: 'BUS/CONDUCTOR', item: 'A591', mfgr: 'Southwire', catalogNo: '-', description: 'CONDUCTOR, 500 kcmil, CU, XHHW-2, 600 V, 65 mil XLPE', qty: 3840, unit: 'FT', furnishedBy: C, notes: HOLD_CUT },
  { section: 'BUS/CONDUCTOR', item: 'A602', mfgr: 'AFL or EQUAL', catalogNo: '-', description: 'OPTICAL FIBER, INDOOR/OUTDOOR LOOSE TUBE CABLE, 144 FIBER COUNT, SINGLE-MODE', qty: 3050, unit: 'FT', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A603', mfgr: 'AFL or EQUAL', catalogNo: '-', description: 'OPTICAL FIBER, INDOOR/OUTDOOR LOOSE TUBE CABLE, 6 FIBER COUNT, SINGLE-MODE', qty: 26350, unit: 'FT', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A606', mfgr: 'AFL or EQUAL', catalogNo: '-', description: 'OPTICAL FIBER, INDOOR/OUTDOOR LOOSE TUBE CABLE, 12 FIBER COUNT, SINGLE-MODE', qty: 940, unit: 'FT', furnishedBy: C },
  { section: 'BUS/CONDUCTOR', item: 'A681', mfgr: 'Southwire', catalogNo: '-', description: 'CONDUCTOR, 600 kcmil, AL, Type PV, 2000 V, 135 mil XLPE', qty: 69048, unit: 'FT', furnishedBy: C },
  // ------------------------------------- RUBBER GOODS/ SURGE ARRESTERS
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C1C', mfgr: 'COOPER', catalogNo: 'BT635XS3A1T', description: 'ELBOW, DEAD BREAK KIT, 35 kV, 600 A, 150 kV BIL, 500 kcmil, W/ COLD SHRINK JACKET SEAL', qty: 123, unit: 'EA', furnishedBy: C, notes: HOLD_CUT },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C1E', mfgr: 'COOPER', catalogNo: 'BT635XS6A1T', description: 'ELBOW, DEAD BREAK KIT, 35 kV, 600 A, 150 kV BIL, 1000 kcmil, W/ COLD SHRINK JACKET SEAL', qty: 96, unit: 'EA', furnishedBy: C, notes: HOLD_CUT },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C1G', mfgr: 'COOPER', catalogNo: 'BT635XS8A1T', description: 'ELBOW, DEAD BREAK KIT, 35 kV, 600 A, 150 kV BIL, 1500 kcmil, W/ COLD SHRINK JACKET SEAL', qty: 84, unit: 'EA', furnishedBy: C, notes: HOLD_CUT },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C10A', mfgr: 'COOPER', catalogNo: 'DCP635AS', description: 'CONNECTING PLUG, WITH STUD, 35 KV, 600 A, 150 KV BIL', qty: 153, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C16A', mfgr: 'ELASTIMOLD', catalogNo: '771BGAD', description: '600 SERIES GROUNDING DEVICE', qty: 24, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C16B', mfgr: 'ELASTIMOLD', catalogNo: '771BGADDR', description: '600 SERIES INSULATING CAB FOR GROUNDING DEVICE', qty: 24, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C51', mfgr: 'TYCO', catalogNo: 'ELB-35-600 ARSTR-36', description: 'ARRESTER, NON-GAPPED SURGE, 35 kV, 600 A, 29.0 kV MCOV', qty: 27, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C61', mfgr: 'SEL', catalogNo: 'TPR#4HK7', description: 'FAULT CIRCUIT INDICATOR, TEST POINT RESET', qty: 16, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C62', mfgr: '', catalogNo: '', description: 'FAULT CIRCUIT INDICATOR LABELS', qty: 16, unit: 'EA', furnishedBy: C },
  { section: 'RUBBER GOODS/ SURGE ARRESTERS', item: 'C63', mfgr: 'SEL', catalogNo: 'ARU#72FH', description: 'FAULT CIRCUIT INDICATOR, CURRENT RESET', qty: 27, unit: 'EA', furnishedBy: C },
  // ----------------------------------------------------- EQUIPMENT
  { section: 'EQUIPMENT', item: 'E101', mfgr: 'POWER ELECTRONICS', catalogNo: 'FP4200M1', description: 'PCS UNIT, CONVERTER W/ INTEGRATED TRANSFORMER: 4200 kVA @ 40C, 34.5 kV, 1500 VDC, 8.9% G.S.U.', qty: 51, unit: 'EA', furnishedBy: N },
  { section: 'EQUIPMENT', item: 'E103A', mfgr: 'LG', catalogNo: 'EPNLTF_1200A', description: 'LG JF2 BATTERY / CONTAINER, 5.1 MWh - A', qty: 74, unit: 'EA', furnishedBy: N },
  { section: 'EQUIPMENT', item: 'E103B', mfgr: 'LG', catalogNo: 'EPNLTF_1200C', description: 'LG JF2 BATTERY / CONTAINER, 5.1 MWh - C', qty: 71, unit: 'EA', furnishedBy: N },
  { section: 'EQUIPMENT', item: 'E104', mfgr: 'HITACHI', catalogNo: '-', description: 'AUXILIARY TRANSFORMER, PADMOUNT, 34.5 kV-480 V, 1.5 MVA, Z=5.75%', qty: 4, unit: 'EA', furnishedBy: N },
  { section: 'EQUIPMENT', item: 'E106', mfgr: 'LAKESHORE ELECTRIC', catalogNo: '-', description: 'AUXILIARY DISTRIBUTION CENTER, 480 V, 2000 A FRAME, 2000 A TRIP, 65 KAIC, MAIN BUS, 3PH, 4W', qty: 4, unit: 'EA', furnishedBy: N },
  // ------------------------------------------- PATCH PANEL & COMMS
  { section: 'PATCH PANEL & COMMS', item: 'F1', mfgr: 'HOFFMAN OR EQUAL', catalogNo: 'A48H36DLP', description: 'NEMA 4X ENCLOSURE, 48" X 36" X 12" HINGED COVER, ORDER WITH F6', qty: 4, unit: 'EA', furnishedBy: C, notes: 'FIBER JUNCTION BOX' },
  { section: 'PATCH PANEL & COMMS', item: 'F6', mfgr: 'HOFFMAN OR EQUAL', catalogNo: 'A48P36', description: 'REAR PANEL FOR 48" X 36" ENCLOSURE', qty: 4, unit: 'EA', furnishedBy: C, notes: 'FIBER JUNCTION BOX' },
  { section: 'PATCH PANEL & COMMS', item: 'F10', mfgr: 'CORNING OR EQUAL', catalogNo: 'SPH-01P', description: 'WALL MOUNTABLE SINGLE PANEL HOUSING (1 CCH)', qty: 341, unit: 'EA', furnishedBy: C },
  { section: 'PATCH PANEL & COMMS', item: 'F11', mfgr: 'CORNING or EQUAL', catalogNo: 'WSH-16-5PT', description: 'WALL MOUNT SPLICE HOUSING, ACCEPTS (11) (0.4") TYPE 4S, 4R, OR 4A SPLICE TRAYS', qty: 4, unit: 'EA', furnishedBy: C, notes: 'FIBER JUNCTION BOX' },
  { section: 'PATCH PANEL & COMMS', item: 'F31', mfgr: 'CORNING OR EQUAL', catalogNo: 'CCH-CP06-3C', description: 'CLOSET CONNECTOR HOUSING (CCH) PANEL, SC ADAPTERS SIMPLEX, UPC, 6F, SINGLE-MODE (OS2)', qty: 51, unit: 'EA', furnishedBy: C, notes: 'PCS UNITS' },
  { section: 'PATCH PANEL & COMMS', item: 'F32', mfgr: 'CORNING', catalogNo: 'CCH-CP12-3C', description: 'CLOSET CONNECTOR HOUSING (CCH) PANEL, SC ADAPTERS SIMPLEX, UPC, 12F, SINGLE-MODE (OS2)', qty: 290, unit: 'EA', furnishedBy: C },
  { section: 'PATCH PANEL & COMMS', item: 'F51', mfgr: 'CORNING or EQUAL', catalogNo: 'M67-110', description: 'SPLICE TRAY, HEAT SHRINK FUSION SPLICES, 0.4 IN, 6F, 2 PER CONNECTOR HOUSING', qty: 40, unit: 'EA', furnishedBy: C, notes: 'FIBER JUNCTION BOX' },
  { section: 'PATCH PANEL & COMMS', item: 'F88', mfgr: 'CORNING', catalogNo: 'FCDUS71V8870', description: 'PATCH CORD, SC TO LC UPC, 9/125um SINGLE-MODE DUPLEX FIBER CABLE (OS2), 0.5 METER', qty: 529, unit: 'EA', furnishedBy: C },
  { section: 'PATCH PANEL & COMMS', item: 'F92', mfgr: 'CORNING OR EQUAL', catalogNo: 'SOC-SCU-FAN-SM', description: 'FUSE LITE CONNECTOR SC/UPC, BUFFER TUBE FAN-OUT, SINGLE-MODE (OS2)', qty: 3504, unit: 'EA', furnishedBy: C },
  // ------------------------------------------------------ HARDWARE
  // H13 stainless bolt assembly (3/8")
  { section: 'HARDWARE', item: 'H13.1', mfgr: '', catalogNo: '38X125HSSB', description: 'BOLT, 3/8" X 1-1/4" STAINLESS STEEL', qty: 4, unit: 'EA', furnishedBy: C, notes: 'FIELD VERIFY BOLT LENGTH', child: true },
  { section: 'HARDWARE', item: 'H13.2', mfgr: '', catalogNo: '38CHENBOX', description: 'NUT, 3/8" FULL, SILICON BRONZE', qty: 4, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H13.3', mfgr: '', catalogNo: '38X75BWSS', description: 'ONE (1) BELLEVILLE WASHER, 3/8", FLAT, STAINLESS STEEL', qty: 4, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H13.4', mfgr: '', catalogNo: '38SWSSMD', description: 'ONE (1) SPLIT LOCKWASHER, 3/8", STAINLESS STEEL', qty: 4, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H13.5', mfgr: '', catalogNo: '38FWSS', description: 'TWO (2) WASHER, 3/8", FLAT, STAINLESS STEEL', qty: 4, unit: 'EA', furnishedBy: C, child: true },
  // H22 (1/2" x 1")
  { section: 'HARDWARE', item: 'H22.1', mfgr: '', catalogNo: '50X100HSSB', description: 'BOLT, 1/2" X 1" STAINLESS STEEL', qty: 212, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H22.2', mfgr: '', catalogNo: '50CHENBOX', description: 'NUT, 1/2" FULL, SILICON BRONZE', qty: 212, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H22.3', mfgr: '', catalogNo: '50X106BWSS', description: 'ONE (1) BELLEVILLE WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 212, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H22.4', mfgr: '', catalogNo: '50FWSS', description: 'TWO (2) WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 212, unit: 'EA', furnishedBy: C, child: true },
  // H24 (1/2" x 1-1/2")
  { section: 'HARDWARE', item: 'H24.1', mfgr: '', catalogNo: '50X150HSSB', description: 'BOLT, 1/2" X 1-1/2" STAINLESS STEEL', qty: 2440, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H24.2', mfgr: '', catalogNo: '50CHENBOX', description: 'NUT, 1/2" FULL, SILICON BRONZE', qty: 2440, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H24.3', mfgr: '', catalogNo: '50X106BWSS', description: 'ONE (1) BELLEVILLE WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 2440, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H24.4', mfgr: '', catalogNo: '50FWSS', description: 'TWO (2) WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 2440, unit: 'EA', furnishedBy: C, child: true },
  // H27 (1/2" x 2-1/2")
  { section: 'HARDWARE', item: 'H27.1', mfgr: '', catalogNo: '50X250HSSB', description: 'BOLT, 1/2" X 2-1/2" STAINLESS STEEL', qty: 54, unit: 'EA', furnishedBy: C, notes: 'FIELD VERIFY BOLT LENGTH', child: true },
  { section: 'HARDWARE', item: 'H27.2', mfgr: '', catalogNo: '50CHENBOX', description: 'NUT, 1/2" FULL, SILICON BRONZE', qty: 54, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H27.3', mfgr: '', catalogNo: '50X106BWSS', description: 'ONE (1) BELLEVILLE WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 54, unit: 'EA', furnishedBy: C, child: true },
  { section: 'HARDWARE', item: 'H27.4', mfgr: '', catalogNo: '50FWSS', description: 'TWO (2) WASHER, 1/2", FLAT, STAINLESS STEEL', qty: 54, unit: 'EA', furnishedBy: C, child: true },
  // H30 battery aux (4 per container)
  { section: 'HARDWARE', item: 'H30.1', mfgr: '', catalogNo: '-', description: 'BOLT, M10 X L20 STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  { section: 'HARDWARE', item: 'H30.2', mfgr: '', catalogNo: '-', description: 'ONE (1) BELLEVILLE WASHER, D10, FLAT, STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  { section: 'HARDWARE', item: 'H30.3', mfgr: '', catalogNo: '-', description: 'ONE (1) WASHER, D10, FLAT, STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  // H32 battery external ground (4 per container) — double dash + stray inch
  // marks after D12 are verbatim from the sheet
  { section: 'HARDWARE', item: 'H32.1', mfgr: '', catalogNo: '--', description: 'BOLT, M12 X L25 STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  { section: 'HARDWARE', item: 'H32.2', mfgr: '', catalogNo: '--', description: 'ONE (1) BELLEVILLE WASHER, D12", FLAT, STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  { section: 'HARDWARE', item: 'H32.3', mfgr: '', catalogNo: '--', description: 'ONE (1) WASHER, D12", FLAT, STAINLESS STEEL', qty: 580, unit: 'EA', furnishedBy: BM, child: true },
  // H33 battery DC (8 per container) — sheet prints these quantities with a comma
  { section: 'HARDWARE', item: 'H33.1', mfgr: '', catalogNo: '-', description: 'BOLT, M12 X L45 STAINLESS STEEL', qty: 1160, unit: 'EA', furnishedBy: BM, child: true, qtyComma: true },
  { section: 'HARDWARE', item: 'H33.2', mfgr: '', catalogNo: '-', description: 'NUT, M12 FULL, SILICON BRONZE', qty: 1160, unit: 'EA', furnishedBy: BM, child: true, qtyComma: true },
  { section: 'HARDWARE', item: 'H33.3', mfgr: '', catalogNo: '-', description: 'ONE (1) BELLEVILLE WASHER, D12, FLAT, STAINLESS STEEL', qty: 1160, unit: 'EA', furnishedBy: BM, child: true, qtyComma: true },
  { section: 'HARDWARE', item: 'H33.4', mfgr: '', catalogNo: '-', description: 'TWO (2) WASHER, D12, FLAT, STAINLESS STEEL', qty: 1160, unit: 'EA', furnishedBy: BM, child: true, qtyComma: true },
  { section: 'HARDWARE', item: 'H103', mfgr: 'B-LINE', catalogNo: 'B22SH-120GLV', description: 'UNIVERSAL CHANNEL, 1-5/8" X 1-5/8" GALVANIZED - 10\' SECTIONS', qty: 40, unit: 'FT', furnishedBy: C },
  { section: 'HARDWARE', item: 'H133', mfgr: 'B-LINE', catalogNo: 'N225SS6', description: 'SPRING NUT, 1/2" FOR 1-5/8" UNIV. CHANNEL', qty: 16, unit: 'EA', furnishedBy: C },
  { section: 'HARDWARE', item: 'H160', mfgr: 'CORNING OR EQUAL', catalogNo: 'SPH-DIN-KIT', description: 'DIN RAIL MOUNT KIT', qty: AS_REQD, unit: 'EA', furnishedBy: C, notes: 'BATTERY ENCLOSURES & PCS UNITS' },
  // ------------------------------------------------------- CONDUIT
  { section: 'CONDUIT', item: 'K1', mfgr: 'CARLON or EQUAL', catalogNo: '59618-010', description: 'CONDUIT, 8" PVC, W/BELL END, 10 FT. LENGTH, SCH. 40', qty: 99, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K1A', mfgr: 'CARLON or EQUAL', catalogNo: 'E442T', description: 'COUPLING, 8" PVC', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K1B', mfgr: 'CARLON or EQUAL', catalogNo: 'E997T', description: 'END BELL, 8" PVC', qty: 60, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K2', mfgr: 'CARLON or EQUAL', catalogNo: '49017-010', description: 'CONDUIT, 6" PVC, W/BELL END, 10 FT. LENGTH, SCH. 40', qty: 86, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K2A', mfgr: 'CARLON or EQUAL', catalogNo: 'E940R', description: 'COUPLING, 6" PVC', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K2B', mfgr: 'CARLON or EQUAL', catalogNo: 'E997R', description: 'END BELL, 6" PVC', qty: 49, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K2C', mfgr: 'CARLON or EQUAL', catalogNo: 'E958R', description: 'END CAP, 6" PVC', qty: 8, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K4', mfgr: 'CARLON or EQUAL', catalogNo: '49015-010', description: 'CONDUIT, 4" PVC W/BELL END, 10 FT. LENGTH, SCH. 40', qty: 888, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K4A', mfgr: 'CARLON or EQUAL', catalogNo: 'E940N', description: 'COUPLING, 4" PVC', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K4B', mfgr: 'CARLON or EQUAL', catalogNo: 'E997N', description: 'END BELL, 4" PVC', qty: 680, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K4C', mfgr: 'CARLON or EQUAL', catalogNo: 'E958N', description: 'END CAP, 4" PVC', qty: 12, unit: 'EA', furnishedBy: '' },
  { section: 'CONDUIT', item: 'K4D', mfgr: 'CARLON or EQUAL', catalogNo: '(where to find?)', description: 'BUSHING, 4" PVC', qty: 8, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K8', mfgr: 'CARLON or EQUAL', catalogNo: '49011-010', description: 'CONDUIT, 2" PVC, W/BELL END, 10 FT. LENGTH, SCH 40', qty: 1966, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K8A', mfgr: 'CARLON or EQUAL', catalogNo: 'E940J', description: 'COUPLING, 2" PVC', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K8B', mfgr: 'CARLON or EQUAL', catalogNo: 'E997J', description: 'END BELL, 2" PVC', qty: 338, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K8C', mfgr: 'CARLON or EQUAL', catalogNo: 'E958J', description: 'END CAP, 2" PVC', qty: 48, unit: 'EA', furnishedBy: '' },
  { section: 'CONDUIT', item: 'K11', mfgr: 'CARLON or EQUAL', catalogNo: '49008-010', description: 'CONDUIT, 1" PVC, W/BELL END, 10 FT. LENGTH, SCH. 40', qty: 59, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K109', mfgr: 'CARLON or EQUAL', catalogNo: 'UA7FT', description: '8" PVC ELBOW, 36" RADIUS, 90 DEGREE SWEEP, SCH. 40', qty: 60, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K131', mfgr: 'CARLON or EQUAL', catalogNo: 'UA9ARB', description: '6" PVC ELBOW, STD. RADIUS, 90 DEGREE SWEEP, BELLED END, SCH. 40', qty: 51, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K138', mfgr: 'CARLON', catalogNo: 'UA7ARB', description: '6" PVC ELBOW, STD. RADIUS, 45 DEGREE SWEEP, BELLED END, SCH40', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K198', mfgr: 'CARLON or EQUAL', catalogNo: 'UA7ANB', description: '4" PVC ELBOW, STD. RADIUS, 45 DEGREE SWEEP, BELLED END, SCH40', qty: 175, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K191', mfgr: 'CARLON or EQUAL', catalogNo: 'UA9ANB', description: '4" PVC ELBOW, STD. RADIUS, 90 DEGREE SWEEP, BELLED END, SCH. 40', qty: 756, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K209', mfgr: 'CARLON or EQUAL', catalogNo: 'UA5ANB', description: '4" PVC ELBOW, STD. RADIUS, 22.5 DEGREE SWEEP, BELLED END, SCH40', qty: 48, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K311', mfgr: 'CARLON or EQUAL', catalogNo: 'UA9AJB', description: '2" PVC ELBOW, STD. RADIUS, 90 DEGREE SWEEP, BELLED END, SCH40', qty: 483, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K978', mfgr: '', catalogNo: '', description: 'ENCLOSURE, PRECAST POLYMER CONCRETE 24" X 36" X 48" DEEP, OPEN BOTTOM', qty: 2, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K979', mfgr: '', catalogNo: '', description: 'COVER, PRECAST POLYMER CONCRETE ENCLOSURE 24" X 36" GASKETED, HEAVY DUTY W/ 2 BOLTS', qty: 2, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K980', mfgr: 'CONCAST', catalogNo: '8005Y-7F', description: 'BOLLARD, 7-1/2" O.DX 7\'-4", HDPE, CONCRETE FILLED, PROVIDE YELLOW PLASTIC COVERS', qty: 8, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K981', mfgr: 'NORDIC OR EQUAL', catalogNo: 'PHH2-212115-MG', description: 'PLASTIC HAND HOLE, 21" x 21" x 15"', qty: 4, unit: 'EA', furnishedBy: C, notes: 'FIBER JUNCTION BOX' },
  { section: 'CONDUIT', item: 'K982', mfgr: '', catalogNo: '', description: 'W6 X 9 SUPPORT', qty: 8, unit: 'EA', furnishedBy: C },
  { section: 'CONDUIT', item: 'K985', mfgr: 'POWER ELECTRONICS', catalogNo: 'L6380', description: '500 kcmil CABLE CLAMP - (2) CLAMPS', qty: 102, unit: 'EA', furnishedBy: PE },
  { section: 'CONDUIT', item: 'K986', mfgr: 'POWER ELECTRONICS', catalogNo: 'L6381', description: '1000 kcmil & 1500 kcmil CABLE CLAMP - (2) CLAMPS', qty: 180, unit: 'EA', furnishedBy: PE },
  { section: 'CONDUIT', item: 'K990', mfgr: 'SCOTCH', catalogNo: 'SCOTCH 413', description: 'WARNING TAPE, DETECTABLE, 6 IN, RED', qty: AS_REQD, unit: 'FT', furnishedBy: C },
  { section: 'CONDUIT', item: 'K999', mfgr: 'POLYWATER', catalogNo: 'ATF-16P4', description: 'POLYWATER AFT, FOAM SEALANT, UL LISTED', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  // ---------------------------------------------- EQUIPMENT LABELS
  { section: 'EQUIPMENT LABELS', item: 'N02-N07', mfgr: '-', catalogNo: '-', description: 'STATION SIGNAGE & EQUIPMENT LABELS, REFER TO DRAWINGS CAR-D-B011-1A & CAR-D-B011-1B', qty: AS_REQD, unit: 'EA', furnishedBy: C },
  // ------------------------------------------------------ GROUNDING
  { section: 'GROUNDING', item: '0005', mfgr: 'SOUTHWIRE', catalogNo: '', description: '#10 AWG COPPER WIRE, BARE, CONCENTRIC LAY, 7-STRAND, SOFT DRAWN', qty: 20025, unit: 'FT', furnishedBy: C },
  { section: 'GROUNDING', item: '0007', mfgr: 'SOUTHWIRE', catalogNo: '', description: '#2 AWG COPPER WIRE, BARE, SOLID', qty: 3790, unit: 'FT', furnishedBy: C },
  { section: 'GROUNDING', item: '0020', mfgr: '-', catalogNo: '-', description: '#4/0 AWG COPPER WIRE, BARE, CONCENTRIC LAY, 7-STRAND, SOFT DRAWN', qty: 17904, unit: 'FT', furnishedBy: C },
  { section: 'GROUNDING', item: '0030', mfgr: 'COPPERWELD OR EQUAL', catalogNo: '-', description: '7 NO. 7 COPPERWELD, TRENCH GROUND, 40% CONDUCTIVITY', qty: 12265, unit: 'FT', furnishedBy: C },
  { section: 'GROUNDING', item: '0083', mfgr: 'BURNDY or EQUAL', catalogNo: 'YGHC29C26', description: 'CONNECTOR, HYTAP COMPRESSION, TYPE "C", RUN: #3/0 STR. CU TO 250 kcmil CU, TAP: #6 SOL. CU TO #2/0 STR. CU', qty: 580, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0084', mfgr: 'BURNDY or EQUAL', catalogNo: 'YGHC29C29', description: 'CONNECTOR, HYTAP COMPRESSION, TYPE "C", RUN: #3/0 STR. CU TO 250 kcmil CU, TAP: #3/0 STR. CU TO 250 kcmil CU', qty: 101, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0161', mfgr: 'BURNDY', catalogNo: 'YA28TC38', description: 'TERMINAL, COMPRESSION, NEMA 1-HOLE PAD, LONG BARREL, W/O INSPECTION WINDOW, 3/8" STUD HOLE, COPPER, #4/0 AWG', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0162', mfgr: 'BURNDY or EQUAL', catalogNo: 'YA28', description: 'TERMINAL, COMPRESSION, NEMA 1-HOLE PAD, LONG BARREL, W/O INSPECTION WINDOW, 1/2" STUD HOLE, COPPER, #4/0 AWG', qty: 110, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0307', mfgr: 'BURNDY or EQUAL', catalogNo: 'YA282LN', description: 'TERMINAL, COMPRESSION, NEMA 2-HOLE PAD, STANDARD BARREL, W/ INSPECTION WINDOW, 1/2" STUD HOLE, 1-3/4" STUD HOLE SPACING, COPPER, #4/0 AWG', qty: 290, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0520', mfgr: 'BURNDY or EQUAL', catalogNo: 'BG18', description: 'FLEXIBLE COPPER BRAID, 300 kcmil EQUIV., 2 HOLE PAD TO 2 HOLE PAD, 18 INCHES LONG', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0567', mfgr: 'BURNDY or EQUAL', catalogNo: 'GAR1626', description: 'CONNECTOR, 1-1/4" IPS PIPE TO ONE (1) COPPER CABLE, #4 AWG SOL. TO #2/0 AWG STR.', qty: 246, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0571', mfgr: 'BURNDY or EQUAL', catalogNo: 'GAR1726', description: 'CONNECTOR, 1-1/2" IPS PIPE TO ONE (1) COPPER CABLE, #4 AWG SOL. TO #2/0 AWG STR.', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0572', mfgr: 'BURNDY or EQUAL', catalogNo: 'GAR1729', description: 'CONNECTOR, 1-1/2" IPS PIPE TO ONE (1) COPPER CABLE, #2/0 AWG SOL. TO 250 kcmil', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0580', mfgr: 'BURNDY or EQUAL', catalogNo: 'GAR1929', description: 'CONNECTOR, 2-1/2" IPS PIPE TO ONE (1) COPPER CABLE, #2/0 AWG SOL. TO 250 kcmil', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0588', mfgr: 'BURNDY or EQUAL', catalogNo: 'GAR2129', description: 'CONNECTOR, 3-1/2" IPS PIPE TO ONE (1) COPPER CABLE, #2/0 AWG SOL. TO 250 kcmil', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0605', mfgr: 'BURNDY or EQUAL', catalogNo: 'GB29', description: 'CONNECTOR, 1/4" THICK BAR TO ONE (1) COPPER CABLE, #2/0 AWG TO 250 kcmil', qty: 4, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0809', mfgr: 'BURNDY or EQUAL', catalogNo: 'KS22', description: 'CONNECTOR, MECHANICAL, SPLIT BOLT, #6 AWG STR. TO #2 AWG SOL', qty: 27, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0857', mfgr: 'BURNDY or EQUAL', catalogNo: 'KVS26', description: 'CONNECTOR, ANODIZED ALUMINUM, RUN: #2 STR. CU TO #2/0 STR. CU, TAP: #6 STR. CU TO #2/0 STR. CU', qty: 762, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0908', mfgr: 'ERICO', catalogNo: 'XBQ2Q2Q', description: 'MOLD, EXOTHERMIC WELD, LAPPED HORIZONTAL CROSS, #4/0 BARE CU RUN TO #4/0 BARE CU TAP, REQUIRES #250 WELD METAL', qty: 9, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0909', mfgr: 'ERICO', catalogNo: 'TAC2Q2Q', description: 'MOLD, EXOTHERMIC WELD, HORIZONTAL TEE, #4/0 BARE CU RUN TO #4/0 BARE CU TAP, REQUIRES #150 WELD METAL', qty: 25, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0910', mfgr: 'ERICO', catalogNo: 'GTC182Q', description: 'MOLD, EXOTHERMIC WELD, 3/4" GROUND ROD TO #4/0 BARE CU, REQUIRES #115 WELD METAL', qty: 3, unit: 'EA', furnishedBy: C, notes: 'HOLD FOR GROUNDING STUDY' },
  { section: 'GROUNDING', item: '0911', mfgr: 'ERICO', catalogNo: '250', description: 'WELD METAL SHOT, #250', qty: 170, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0912', mfgr: 'ERICO', catalogNo: '150', description: 'WELD METAL SHOT, #150', qty: 500, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0913', mfgr: 'ERICO', catalogNo: '115', description: 'WELD METAL SHOT, #115', qty: 50, unit: 'EA', furnishedBy: C },
  { section: 'GROUNDING', item: '0940', mfgr: 'ERICO', catalogNo: '613400', description: 'GROUND ROD, 3/4" X 10\' - 0", COPPERBONDED, 13 MIL MIN. THREADED', qty: 50, unit: 'EA', furnishedBy: C },
];

// --------------------------------------------------------------------------
// Quantity derivation.
//
// EXACT_BASIS entries were VERIFIED as integer ratios against the package
// counts (e.g. E101: 51 = 1 × 51 PCS; H33.1: 1,160 = 8 × 145 containers).
// Everything else scales proportionally by container count (rounded up) and
// is flagged estimated — final counts for those come from cable cut sheets /
// grounding study, exactly as the package sheets themselves note.

export type QtyBasis = { per: 'pcs' | 'container' | 'island'; each: number };

export const EXACT_BASIS: Record<string, QtyBasis> = {
  // per PCS unit
  E101: { per: 'pcs', each: 1 },
  F31: { per: 'pcs', each: 1 },
  K131: { per: 'pcs', each: 1 },
  K985: { per: 'pcs', each: 2 },
  // per container
  A2: { per: 'container', each: 1 },
  A3: { per: 'container', each: 3 },
  'H30.1': { per: 'container', each: 4 }, 'H30.2': { per: 'container', each: 4 }, 'H30.3': { per: 'container', each: 4 },
  'H32.1': { per: 'container', each: 4 }, 'H32.2': { per: 'container', each: 4 }, 'H32.3': { per: 'container', each: 4 },
  'H33.1': { per: 'container', each: 8 }, 'H33.2': { per: 'container', each: 8 },
  'H33.3': { per: 'container', each: 8 }, 'H33.4': { per: 'container', each: 8 },
  // per island
  E104: { per: 'island', each: 1 },
  E106: { per: 'island', each: 1 },
  F1: { per: 'island', each: 1 },
  F6: { per: 'island', each: 1 },
  F11: { per: 'island', each: 1 },
  K981: { per: 'island', each: 1 },
  K138: { per: 'island', each: 1 },
  K980: { per: 'island', each: 2 },
  K982: { per: 'island', each: 2 },
};

export interface DesignCounts { pcsUnits: number; containers: number; islands: number }

export interface DerivedPartQty {
  qty: PkgQty;
  /** true when scaled proportionally rather than via a verified basis. */
  estimated: boolean;
}

export function derivePartQty(part: PackagePart, counts: DesignCounts): DerivedPartQty {
  if (part.qty === AS_REQD) return { qty: AS_REQD, estimated: false };
  // Container A/C split: every container is exactly one of the two SKUs, so
  // the pair must always sum to the container count (round the package's
  // 74:71 proportion for A, remainder is C — never an independent ceil).
  if (part.item === 'E103A' || part.item === 'E103B') {
    const a = Math.round(counts.containers * PACKAGE_DESIGN_COUNTS.containersA / PACKAGE_DESIGN_COUNTS.containers);
    return { qty: part.item === 'E103A' ? a : counts.containers - a, estimated: false };
  }
  const basis = EXACT_BASIS[part.item];
  if (basis) {
    const n = basis.per === 'pcs' ? counts.pcsUnits
      : basis.per === 'container' ? counts.containers
      : counts.islands;
    return { qty: basis.each * n, estimated: false };
  }
  const ratio = counts.containers / PACKAGE_DESIGN_COUNTS.containers;
  return { qty: Math.ceil(part.qty * ratio), estimated: true };
}

/** Real procurement identifiers for placed-equipment kinds (from B018-1). */
export const REAL_EQUIPMENT_PARTS = {
  bess: { mfgr: 'LG', catalogNo: 'EPNLTF_1200A/C', model: 'LG JF2 BATTERY / CONTAINER, 5.1 MWH' },
  inverterPE: { mfgr: 'POWER ELECTRONICS', catalogNo: 'FP4200M1', model: 'PCS UNIT, CONVERTER W/ INTEGRATED TRANSFORMER' },
  auxTransformer: { mfgr: 'HITACHI', catalogNo: '-', model: 'AUXILIARY TRANSFORMER, PADMOUNT, 34.5 KV-480 V, 1.5 MVA, Z=5.75%' },
  auxSwitchgear: { mfgr: 'LAKESHORE ELECTRIC', catalogNo: '-', model: 'AUXILIARY DISTRIBUTION CENTER, 480 V, 2000 A' },
  fiberJunctionBox: { mfgr: 'HOFFMAN OR EQUAL', catalogNo: 'A48H36DLP', model: 'NEMA 4X ENCLOSURE, 48" X 36" X 12"' },
} as const;

// --------------------------------------------------------------------------
// B018 template rows — the exact row sequence of CAR-D-B018-1/-2, shared by
// the DXF BOM sheets, the PDF plots (which replay the DXF display list), and
// the Full BOM CSV parts section, so every surface prints the identical list.
// The row COUNT and TEXT are design-independent; only derived quantities vary.
// At the package counts (51 PCS / 145 containers / 4 islands) every field
// reproduces the issued sheets character-for-character.
// --------------------------------------------------------------------------

export type BomTemplateRow =
  | { kind: 'section'; title: string }
  | { kind: 'spacer' }
  | {
      kind: 'part' | 'parent';
      item: string;      // '' on assembly children (sheet prints them blank)
      mfgr: string;
      catalogNo: string;
      description: string;
      qty: string;       // display text: '145', '1,160', "AS REQ'D", '' on parents
      unit: string;
      furnishedBy: string;
      notes: string;
      /** underlying catalog item tag (H13.1 for children; '' for parents) */
      tag: string;
      estimated?: boolean;
    };

/** Formats a derived quantity exactly as the sheet prints it. */
function formatQty(q: PkgQty, comma: boolean | undefined): string {
  if (q === AS_REQD) return AS_REQD;
  return comma ? q.toLocaleString('en-US') : String(q);
}

export function buildPartsTemplateRows(counts: DesignCounts): BomTemplateRow[] {
  const rows: BomTemplateRow[] = [];
  // The EST marker is suppressed at the package container count so the sheet
  // stays character-identical to the issued package; scaled designs flag
  // proportionally-derived rows in NOTES.
  const flagEstimates = counts.containers !== PACKAGE_DESIGN_COUNTS.containers;
  let section: string | null = null;
  let lastParent: string | null = null;
  for (const p of PACKAGE_BOM) {
    if (p.section !== section) {
      if (section !== null) rows.push({ kind: 'spacer' });
      rows.push({ kind: 'section', title: p.section });
      section = p.section;
      lastParent = null;
    }
    const parentTag = p.child ? p.item.split('.')[0] : null;
    if (parentTag && parentTag !== lastParent) {
      const a = HARDWARE_ASSEMBLIES[parentTag];
      if (lastParent !== null) rows.push({ kind: 'spacer' });
      rows.push({
        kind: 'parent', item: parentTag, mfgr: a?.mfgr ?? '', catalogNo: '',
        description: a?.description ?? '', qty: '', unit: '', furnishedBy: '',
        notes: a?.notes ?? '', tag: '',
      });
      lastParent = parentTag;
    } else if (!p.child && lastParent !== null) {
      // leaving the assembly block (H103 after H33.4)
      rows.push({ kind: 'spacer' });
      lastParent = null;
    }
    const d = derivePartQty(p, counts);
    const noteBits = [p.notes, d.estimated && flagEstimates ? 'EST - SCALED FROM 90% PKG' : undefined]
      .filter(Boolean) as string[];
    rows.push({
      kind: 'part',
      item: p.child ? '' : p.item,
      mfgr: p.mfgr,
      catalogNo: p.catalogNo,
      description: p.description,
      qty: formatQty(d.qty, p.qtyComma),
      unit: p.unit,
      furnishedBy: p.furnishedBy,
      notes: noteBits.join('; '),
      tag: p.item,
      estimated: d.estimated,
    });
  }
  return rows;
}

/**
 * Flattened parts lines for the Full BOM CSV parts section — derived from the
 * SAME template rows the B018 sheets print (parents included as zero-qty
 * heading lines), so the CSV can never drift from the drawn sheets.
 */
export interface PartsBomLine {
  qty: PkgQty;
  unit: string;
  description: string;
}

export function buildPartsBomLines(counts: DesignCounts): PartsBomLine[] {
  const lines: PartsBomLine[] = [];
  for (const r of buildPartsTemplateRows(counts)) {
    if (r.kind === 'section' || r.kind === 'spacer') continue;
    if (r.kind === 'parent') {
      lines.push({ qty: '' as any, unit: '', description: `[${r.item}] ${r.mfgr} - ${r.description}${r.notes ? ` (${r.notes})` : ''}` });
      continue;
    }
    const id = [r.tag && r.item === '' ? r.tag : r.item, r.mfgr, r.catalogNo].filter(Boolean).join(' ');
    lines.push({
      qty: r.qty === AS_REQD ? AS_REQD : Number(r.qty.replace(/,/g, '')),
      unit: r.unit,
      description: `[${id}] ${r.description}${r.notes ? ` (${r.notes})` : ''}`,
    });
  }
  return lines;
}

/** Design counts extracted from a generated design's equipment list. */
export function designCounts(equipment: { kind: string }[], islands?: unknown[] | null): DesignCounts {
  const count = (k: string) => equipment.filter(e => e.kind === k).length;
  return {
    pcsUnits: count('inverter'),
    containers: count('bess'),
    // No synthetic islands: fall back to the aux-transformer count (one per
    // island in the reference design) which is 0 on designs without them.
    islands: islands?.length ?? count('auxTransformer'),
  };
}

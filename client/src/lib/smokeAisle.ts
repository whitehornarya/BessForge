// Dev-only scripted smoke pass for drive-aisle drags (task: confirm aisle
// drags survive save/open and undo/redo in the browser). Runs the exact same
// store + validator code paths the 3D drag handlers in DesignScene use:
//   ghost validity  -> validateAisleShift(...) with design.rowEditGeom
//   drop commit     -> moveAisle(index, total)
//   undo / redo     -> undoEdit() / redoEdit()
//   save / reopen   -> exportProjectJson() -> importProject()
// Activated only via `?smoke=aisle` in dev builds (see main.tsx). Logs
// `[SMOKE] ...` lines to the browser console; final line is
// `[SMOKE] AISLE SUITE PASS` or `[SMOKE] AISLE SUITE FAIL`.
import { useDesignStore } from './stores/useDesignStore';
import { validateAisleShift } from './nextera/layoutEngine';

const log = (msg: string) => console.log(`[SMOKE] ${msg}`);

let failures = 0;
let passes = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passes++;
  else {
    failures++;
    log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred: () => boolean, label: string, timeoutMs = 30000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(200);
  }
  log(`FAIL timeout waiting for ${label}`);
  failures++;
  return false;
}

function aisleY(index: number): number | null {
  const d = useDesignStore.getState().design;
  if (!d) return null;
  const sorted = d.aisles
    .filter(a => Math.abs(Math.sin(a.rotation)) < 0.5)
    .sort((a, b) => a.y - b.y);
  const a = sorted[index - 1];
  return a ? a.y : null;
}

export async function runAisleSmoke(): Promise<void> {
  log('aisle smoke starting');
  const store = useDesignStore;

  // 1. Load a sample site (same path as the "Hondo 100MW" sidebar button).
  await store.getState().loadSample('/samples/hondo-100mw.kmz', 'Hondo 100MW');
  const loaded = await waitFor(
    () => !!store.getState().design && (store.getState().design!.aisles.length ?? 0) >= 1,
    'design with at least one interior aisle'
  );
  if (!loaded) {
    log('AISLE SUITE FAIL');
    return;
  }
  const st0 = store.getState();
  const d0 = st0.design!;
  log(`site loaded: ${d0.aisles.length} interior aisle(s), ${d0.blockRows.length} block row(s)`);

  // 2. Ghost validity — identical call to DesignScene's drag preview. Probe
  // aisles and candidate shifts with the ghost validator (as a drafter's drag
  // preview would) until one shows green, then commit that one.
  const geom = d0.rowEditGeom;
  if (!geom) {
    check('rowEditGeom present', false);
    log('AISLE SUITE FAIL');
    return;
  }
  const rows = d0.blockRows;
  // Same pinned reserved rectangles DesignScene's drag ghost passes.
  const edits = store.getState().layoutEdits;
  const pinnedReserved = d0.reservedZones.filter(z =>
    (z.kind === 'futureAug' && (edits.augPins ?? {})[z.id] != null) ||
    (z.kind === 'laydown' && edits.laydownPin != null && edits.laydownSize != null)
  );
  const ghostReason = (aisle: number, ddy: number, total: number): string | null => {
    const movingBlocks = rows.filter(r => r.index > aisle).flatMap(r => r.blocks);
    const otherBlocks = rows.filter(r => r.index <= aisle).flatMap(r => r.blocks);
    return validateAisleShift(
      movingBlocks, otherBlocks, geom, d0.fence, d0.boundary.polygon, ddy, total, pinnedReserved
    );
  };

  let idx = 0;
  let dy = 0;
  const nRowAisles = d0.aisles.filter(a => Math.abs(Math.sin(a.rotation)) < 0.5).length;
  outer: for (let a = 1; a <= nRowAisles; a++) {
    for (const cand of [10, 5, 2, -2, -4]) {
      if (ghostReason(a, cand, cand) === null) {
        idx = a;
        dy = cand;
        break outer;
      }
    }
  }
  check('ghost validator finds a valid shift on some aisle', idx > 0,
    'no aisle/shift combination validated on this site');
  if (idx === 0) {
    log('AISLE SUITE FAIL');
    return;
  }
  log(`using aisle ${idx}, shift ${dy > 0 ? '+' : ''}${dy} ft (ghost valid)`);
  const y0 = aisleY(idx)!;
  const badReason = ghostReason(idx, 100000, 100000);
  check('ghost shows invalid for absurd shift (+100000 ft)', badReason !== null);

  // 3. Drop commit.
  const committed = store.getState().moveAisle(idx, dy);
  check('moveAisle commit accepted', committed === true);
  const yMoved = aisleY(idx);
  check(`aisle position shifted by ${dy > 0 ? '+' : ''}${dy} ft`, yMoved !== null && Math.abs(yMoved - (y0 + dy)) < 0.01,
    `y0=${y0} yMoved=${yMoved}`);
  check('layoutEdits.aisleMoves recorded', store.getState().layoutEdits.aisleMoves?.[idx] === dy);

  // Rejected commit must snap back (same toast.error path in DesignScene).
  const rejected = store.getState().moveAisle(idx, 100000);
  check('absurd moveAisle rejected', rejected === false);
  check('rejected move left constraint untouched', store.getState().layoutEdits.aisleMoves?.[idx] === dy);
  check('rejected move left position untouched', Math.abs((aisleY(idx) ?? NaN) - (y0 + dy)) < 0.01);

  // 4. Undo / redo.
  const undone = store.getState().undoEdit();
  check('undo returns true', undone === true);
  check('undo restored automatic position', Math.abs((aisleY(idx) ?? NaN) - y0) < 0.01,
    `y=${aisleY(idx)} expected=${y0}`);
  check('undo cleared aisleMoves', store.getState().layoutEdits.aisleMoves?.[idx] === undefined);

  const redone = store.getState().redoEdit();
  check('redo returns true', redone === true);
  check('redo re-applied the shift', Math.abs((aisleY(idx) ?? NaN) - (y0 + dy)) < 0.01,
    `y=${aisleY(idx)} expected=${y0 + dy}`);
  check('redo restored aisleMoves', store.getState().layoutEdits.aisleMoves?.[idx] === dy);

  // 5. Save project, reopen.
  const json = store.getState().exportProjectJson();
  check('project export produced JSON', !!json);
  if (json) {
    const parsed = JSON.parse(json);
    check('saved file carries aisleMoves', parsed?.layoutEdits?.aisleMoves?.[idx] === dy);
    // Wipe the edit, then reopen the saved file — the moved aisle must return.
    store.getState().moveAisle(idx, 0);
    check('reset-to-auto before reopen', Math.abs((aisleY(idx) ?? NaN) - y0) < 0.01);
    const err = store.getState().importProject(json);
    check('project reopen succeeded', err === null, err ?? undefined);
    check('aisle stays moved after reopen', Math.abs((aisleY(idx) ?? NaN) - (y0 + dy)) < 0.01,
      `y=${aisleY(idx)} expected=${y0 + dy}`);
    check('aisleMoves restored after reopen', store.getState().layoutEdits.aisleMoves?.[idx] === dy);
  }

  (window as any).__aisleSmokeResults = results;
  log(failures === 0
    ? `AISLE SUITE PASS (${passes}/${passes + failures} checks)`
    : `AISLE SUITE FAIL (${failures} of ${passes + failures} checks failed)`);
}

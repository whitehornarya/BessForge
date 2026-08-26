// Reference equipment naming per the current standard:
//   PCS units:  PCS<FF>-<UU>      e.g. PCS43-04
//   Containers: CON<FFUU>-A-<n>   e.g. CON4304-A-2
// where FF = feeder (circuit) number and UU = the unit's 1-based position on
// that feeder, both zero-padded to two digits, and n = the container number
// at that PCS unit.
//
// When feeders exist (a substation is placed), FF/UU come straight from the
// feeder circuits so labels always match the MV schedule. Before a substation
// exists, the same deterministic grouping the feeder generator starts from
// (autoGroupInverters) provides provisional numbers, so labels are stable and
// don't jump when the substation is added.
import { PlacedEquipment, IslandInfo } from './types';
import { FeederCircuit, autoGroupInverters } from './feeders';

const p2 = (n: number) => String(n).padStart(2, '0');

// Mutates eq.label in place for every inverter (PCS) and bess container.
// In mirrored-pair (island) layouts, FF is the island number and UU walks the
// island's unit order (south side W->E, then north side E->W), matching the
// reference drawing — feeder circuits do not renumber the units.
export function applyReferenceLabels(
  equipment: PlacedEquipment[],
  feeders: FeederCircuit[] | null | undefined,
  islands?: IslandInfo[] | null
): void {
  // Future/augmentation-flagged PCS (KMZ-traced yards) never join the built
  // numbering: they must not consume FF/UU positions in the provisional
  // grouping, must not be relabeled, and must never own traced containers —
  // otherwise built CON identifiers skip numbers or hang off a future unit.
  const inverters = equipment.filter(
    e => e.kind === 'inverter' && !e.augmented && !e.future);
  if (!inverters.length) return;

  // groups[i] = ordered inverter ids on feeder i+1 (or island i+1)
  const groups: string[][] = islands && islands.length
    ? islands.map(i => i.inverterIds)
    : feeders && feeders.length
      ? feeders.map(f => f.inverterIds)
      : autoGroupInverters(inverters);

  // inverter id -> { ff, uu }
  const pos = new Map<string, { ff: number; uu: number }>();
  groups.forEach((ids, gi) => {
    ids.forEach((id, ui) => pos.set(id, { ff: gi + 1, uu: ui + 1 }));
  });

  for (const eq of equipment) {
    // Flagged units keep their stored labels even if a stale feeder list
    // somehow still carries one — belt and braces with the filter above.
    if (eq.augmented || eq.future) continue;
    if (eq.kind === 'inverter') {
      const p = pos.get(eq.id);
      if (p) eq.label = `PCS${p2(p.ff)}-${p2(p.uu)}`;
    } else if (eq.kind === 'bess') {
      // bess ids are `bess-<block>-<n>`; the owning PCS is `inv-<block>`
      const m = eq.id.match(/^bess-(\d+)-(\d+)$/);
      if (!m) continue;
      const p = pos.get(`inv-${m[1]}`);
      if (p) eq.label = `CON${p2(p.ff)}${p2(p.uu)}-A-${m[2]}`;
    }
  }

  // Traced containers (KMZ auto-fill) carry no auto block id, so ownership is
  // geometric: each one belongs to the NEAREST labeled PCS and takes the same
  // CON<FFUU>-A-<n> convention, numbering the containers per unit in a stable
  // west-to-east / south-to-north order so re-runs never shuffle names.
  // Future/augmentation containers never join the built numbering (and their
  // owners are always BUILT PCS — flagged inverters were filtered out above):
  // they print as dashed future footprints without built-unit labels, and
  // letting them consume CON numbers would leave gaps in the built sequence.
  const tracedBess = equipment.filter(
    e => e.kind === 'bess' && !e.augmented && !e.future &&
      !/^bess-\d+-\d+$/.test(e.id) && pos.get(e.id) === undefined);
  if (tracedBess.length) {
    const labeledInvs = inverters.filter(i => pos.has(i.id));
    if (labeledInvs.length) {
      const byOwner = new Map<string, typeof tracedBess>();
      for (const b of tracedBess) {
        let owner = labeledInvs[0];
        let bd = Infinity;
        for (const i of labeledInvs) {
          const d = Math.hypot(i.x - b.x, i.y - b.y);
          if (d < bd) { bd = d; owner = i; }
        }
        (byOwner.get(owner.id) ?? byOwner.set(owner.id, []).get(owner.id)!).push(b);
      }
      byOwner.forEach((list, ownerId) => {
        const p = pos.get(ownerId)!;
        list.sort((a: PlacedEquipment, b: PlacedEquipment) => (a.x - b.x) || (a.y - b.y));
        list.forEach((b: PlacedEquipment, i: number) => { b.label = `CON${p2(p.ff)}${p2(p.uu)}-A-${i + 1}`; });
      });
    }
  }
}

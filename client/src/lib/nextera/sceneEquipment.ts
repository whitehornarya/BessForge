import type { PlacedEquipment } from './types';

export interface SceneEquipmentGroups {
  builtEquipment: PlacedEquipment[];
  plannedEquipment: PlacedEquipment[];
}

/** True for traced-yard equipment that represents later build-out, not built scope. */
export function isPlannedSceneEquipment(eq: PlacedEquipment): boolean {
  return eq.augmented === true || eq.future === true;
}

/**
 * Split scene bodies from planned/ghost bodies.
 *
 * Auto layouts never flag design.equipment, so their original array identities
 * are preserved. Traced yards keep augmentation/future units in equipment;
 * those units join the legacy futureEquipment ghost list instead of entering
 * any built-body render pass.
 */
export function partitionSceneEquipment(
  equipment: PlacedEquipment[],
  futureEquipment: PlacedEquipment[] = [],
): SceneEquipmentGroups {
  const tracedPlanned = equipment.filter(isPlannedSceneEquipment);
  if (tracedPlanned.length === 0) {
    return { builtEquipment: equipment, plannedEquipment: futureEquipment };
  }
  const builtEquipment = equipment.filter(eq => !isPlannedSceneEquipment(eq));
  return {
    builtEquipment,
    plannedEquipment: futureEquipment.length > 0
      ? [...futureEquipment, ...tracedPlanned]
      : tracedPlanned,
  };
}
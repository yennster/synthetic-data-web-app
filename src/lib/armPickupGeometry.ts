/** The Braccio IK target represents the ideal gripper tip, but the
 * rendered / MuJoCo finger pads extend about 2 cm past that simplified
 * point because the pad bodies start below the carrier plate. Keep the
 * requested tip above this overhang so the physical finger geometry
 * cannot be commanded through the floor during pick-and-place. */
export const BRACCIO_GRIPPER_PAD_OVERHANG_M = 0.02;
export const BRACCIO_GRIPPER_FLOOR_MARGIN_M = 0.003;
export const BRACCIO_GRIPPER_MIN_TIP_Y =
  BRACCIO_GRIPPER_PAD_OVERHANG_M + BRACCIO_GRIPPER_FLOOR_MARGIN_M;

export function floorSafePickupTipY(
  targetCenterY: number,
  targetHalfExtentY: number,
): number {
  const bottomY = targetCenterY - targetHalfExtentY;
  return Math.max(BRACCIO_GRIPPER_MIN_TIP_Y, bottomY);
}

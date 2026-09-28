import Decimal from "decimal.js";

const TWO = new Decimal(2);
const THREE = new Decimal(3);

/** S-кривая освоения C(x) = 3x² − 2x³ (F.CAPEX.SCHEDULE_WEIGHT): накопленная доля к моменту x ∈ [0; 1]. */
export function sCurve(x: Decimal): Decimal {
  return THREE.mul(x.pow(2)).sub(TWO.mul(x.pow(3)));
}

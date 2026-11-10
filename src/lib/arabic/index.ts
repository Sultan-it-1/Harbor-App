import {
  ARABIC_COMEDY,
  ARABIC_DRAMA,
  ARABIC_KHALEEJI,
  ARABIC_MOVIES,
  ARABIC_RAMADAN,
  ARABIC_TRENDING,
  arabicRowTitle,
  type ArabicRowDef,
} from "./rows";
import { ARABIC_CLASSICS, EGYPTIAN_CLASSICS, fetchEgyptianClassics } from "./classics";

export type { ArabicRowDef };
export { arabicRowTitle };
export { EGYPTIAN_CLASSICS, fetchEgyptianClassics };

export const ARABIC_ROWS: ArabicRowDef[] = [
  ARABIC_RAMADAN,
  ARABIC_DRAMA,
  ARABIC_MOVIES,
  ARABIC_CLASSICS,
  ARABIC_KHALEEJI,
  ARABIC_COMEDY,
  ARABIC_TRENDING,
];

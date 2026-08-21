import {
  type PresentationDisplayState,
  type PresentationUpdate,
  reconcilePresentationUpdate,
} from "../src/index.js";

export function consumePresentationUpdate(
  state: PresentationDisplayState,
  update: PresentationUpdate,
): PresentationDisplayState {
  return reconcilePresentationUpdate(state, update);
}

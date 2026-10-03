import { create } from 'zustand';

/**
 * What the Clone from GitHub dialog was filled in with. It outlives the dialog
 * so a user sent to the host terminal to sign in can come back and try the
 * same clone again.
 */
interface CloneDraftState {
  url: string;
  destPath: string;
  error: string;
  /** Remote host whose git could not sign in to the server; null when the error is not about signing in. */
  signInHost: string | null;
  update: (draft: Partial<Omit<CloneDraftState, 'update' | 'reset'>>) => void;
  reset: () => void;
}

const EMPTY_DRAFT = { url: '', destPath: '', error: '', signInHost: null };

export const useCloneDraftStore = create<CloneDraftState>((set) => ({
  ...EMPTY_DRAFT,
  update: (draft) => set(draft),
  reset: () => set(EMPTY_DRAFT),
}));

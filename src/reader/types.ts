export interface Jump {
  path: string;
  top: number;
}

export interface ImageDetails {
  width: number;
  height: number;
  format: string;
}

export interface ReaderMotionOptions {
  canAcceptCount: () => boolean;
  isPreviewing: () => boolean;
  documentText: () => string | undefined;
  currentMatchLine: () => number | undefined;
  scrollTop: () => number;
  viewportHeight: () => number;
  scrollTo: (position: number) => void;
  scrollToLine: (line: number) => void;
  setPending: (count: number | undefined) => void;
  setMessage: (text: string) => void;
}

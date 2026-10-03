export interface PackLocation {
  id: string;
  file: string;
  absolutePath: string;
}

export declare const PACKS_DIR: string;
export declare function listPacks(): PackLocation[];
export declare function resolvePack(id: string): string | null;
export declare function defaultPackPaths(): string[];
export declare const version: string;
/**
 * Web stub for `expo-file-system` (StingStream M2 web target).
 *
 * `expo-file-system@57`'s own web backend (`ExpoFileSystem.web.ts`) is a hollow
 * placeholder: `FileSystemFile` / `FileSystemDirectory` are empty classes, so
 * the very first `new Directory(Paths.document, ...)` throws
 * `this.validatePath is not a function`. That happens inside `DownloadProvider`
 * during the first render, which means the app cannot mount at all on web —
 * this stub is what gets past that.
 *
 * Sixteen files use the modern `File` / `Directory` / `Paths` API (offline
 * downloads, the audio cache, the image cache, downloaded subtitles, log
 * export). Since "downloads are not available on web" is a deliberate gap for
 * the spike, this provides:
 *
 *   - **Directories**: always creatable, always listable, always empty. Callers
 *     that do `if (!dir.exists) dir.create()` at startup succeed and then see
 *     nothing downloaded, which is the correct answer on web.
 *   - **Text files**: really readable and writable, persisted in `localStorage`
 *     under a `stingstream:fs:` prefix. The small JSON bookkeeping files
 *     (pending downloads, queue state) therefore survive a page reload.
 *   - **Binary payloads** (`bytes`, `arrayBuffer`, streams, `upload`,
 *     `downloadFileAsync`): rejected with a clear "not available on web" error
 *     rather than a `TypeError` from an undefined method.
 *
 * Metro substitutes this module for `platform === "web"` only — see
 * `webModuleStubs` in `metro.config.js`. Native bundles use the real package.
 */

const STORE_PREFIX = "stingstream:fs:";
/**
 * Sentinel stored as a directory entry's value. Deliberately something no
 * caller would ever `File.write()`, so a text file can never be mistaken for
 * a directory.
 */
const DIR_MARKER = "\u0000stingstream-dir";
const ROOT = "file:///stingstream-web/";

const unsupported = (what: string) =>
  new Error(`${what} is not available on web (StingStream web target).`);

// ---------------------------------------------------------------------------
// Path helpers (mirrors expo-file-system's PathUtilities closely enough)
// ---------------------------------------------------------------------------

const toPath = (value: unknown): string => {
  if (typeof value === "string") return value;
  const uri = (value as { uri?: string } | null)?.uri;
  return typeof uri === "string" ? uri : "";
};

const joinPaths = (...parts: unknown[]): string => {
  const segments = parts.map(toPath).filter(Boolean);
  if (segments.length === 0) return "";
  const [head, ...rest] = segments;
  let out = head;
  for (const segment of rest) {
    out = `${out.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
  }
  return out;
};

const basename = (path: string, ext?: string): string => {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
};

const dirname = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
};

const extname = (path: string): string => {
  const name = basename(path);
  const idx = name.lastIndexOf(".");
  return idx <= 0 ? "" : name.slice(idx);
};

// ---------------------------------------------------------------------------
// localStorage-backed text store
// ---------------------------------------------------------------------------

const storage = (): Storage | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Blocked site data (private mode, embedded contexts).
    return null;
  }
};

const readEntry = (uri: string): string | null => {
  try {
    return storage()?.getItem(STORE_PREFIX + uri) ?? null;
  } catch {
    return null;
  }
};

const writeEntry = (uri: string, value: string): void => {
  try {
    storage()?.setItem(STORE_PREFIX + uri, value);
  } catch {
    // Quota or blocked storage: the caller's bookkeeping just does not persist.
  }
};

const removeEntry = (uri: string): void => {
  try {
    storage()?.removeItem(STORE_PREFIX + uri);
  } catch {
    // Nothing to do.
  }
};

// ---------------------------------------------------------------------------

class FileSystemPath {
  uri: string;

  constructor(...uris: unknown[]) {
    this.uri = joinPaths(...uris) || ROOT;
  }

  get name(): string {
    return basename(this.uri);
  }

  get parentDirectory(): Directory {
    return new Directory(dirname(this.uri));
  }

  toString(): string {
    return this.uri;
  }

  /** Present so anything probing for the real class's validator finds it. */
  validatePath(): void {}
}

export class Directory extends FileSystemPath {
  get exists(): boolean {
    return readEntry(this.uri) === DIR_MARKER;
  }

  /** `size` of a directory is unknowable here; the app only reads it for display. */
  get size(): number | null {
    return null;
  }

  get modificationTime(): number | null {
    return null;
  }

  get creationTime(): number | null {
    return null;
  }

  create(_options?: { intermediates?: boolean; idempotent?: boolean }): void {
    writeEntry(this.uri, DIR_MARKER);
  }

  delete(): void {
    removeEntry(this.uri);
  }

  /** Nothing is ever downloaded on web, so every directory reads as empty. */
  list(): (Directory | File)[] {
    return [];
  }

  createFile(name: string, _mimeType: string | null = null): File {
    const file = new File(this.uri, name);
    file.create();
    return file;
  }

  createDirectory(name: string): Directory {
    const dir = new Directory(this.uri, name);
    dir.create();
    return dir;
  }

  copy(_destination: Directory | File): void {
    throw unsupported("Directory.copy");
  }

  move(_destination: Directory | File): void {
    throw unsupported("Directory.move");
  }

  watch(): { remove: () => void } {
    return { remove: () => {} };
  }

  info() {
    return { exists: this.exists, uri: this.uri, isDirectory: true } as const;
  }
}

export class File extends FileSystemPath {
  get exists(): boolean {
    const entry = readEntry(this.uri);
    return entry !== null && entry !== DIR_MARKER;
  }

  get size(): number | null {
    const entry = readEntry(this.uri);
    return entry === null || entry === DIR_MARKER ? null : entry.length;
  }

  get md5(): string | null {
    return null;
  }

  get type(): string | null {
    return null;
  }

  get modificationTime(): number | null {
    return null;
  }

  get creationTime(): number | null {
    return null;
  }

  get extension(): string {
    return extname(this.uri);
  }

  create(_options?: { intermediates?: boolean; overwrite?: boolean }): void {
    if (!this.exists) writeEntry(this.uri, "");
  }

  delete(): void {
    removeEntry(this.uri);
  }

  write(contents: string | Uint8Array): void {
    if (typeof contents !== "string") throw unsupported("File.write(bytes)");
    writeEntry(this.uri, contents);
  }

  text(): string {
    const entry = readEntry(this.uri);
    if (entry === null || entry === DIR_MARKER) {
      throw new Error(`File does not exist: ${this.uri}`);
    }
    return entry;
  }

  textSync(): string {
    return this.text();
  }

  base64(): string {
    return typeof btoa === "function" ? btoa(this.text()) : "";
  }

  json(): any {
    return JSON.parse(this.text());
  }

  bytes(): Uint8Array {
    throw unsupported("File.bytes");
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(unsupported("File.arrayBuffer"));
  }

  blob(): Promise<Blob> {
    return Promise.reject(unsupported("File.blob"));
  }

  formData(): Promise<FormData> {
    return Promise.reject(unsupported("File.formData"));
  }

  slice(): Blob {
    throw unsupported("File.slice");
  }

  stream(): never {
    throw unsupported("File.stream");
  }

  readableStream(): never {
    throw unsupported("File.readableStream");
  }

  writableStream(): never {
    throw unsupported("File.writableStream");
  }

  copy(_destination: Directory | File): void {
    throw unsupported("File.copy");
  }

  move(_destination: Directory | File): void {
    throw unsupported("File.move");
  }

  upload(): Promise<never> {
    return Promise.reject(unsupported("File.upload"));
  }

  createUploadTask(): never {
    throw unsupported("File.createUploadTask");
  }

  watch(): { remove: () => void } {
    return { remove: () => {} };
  }

  info() {
    return { exists: this.exists, uri: this.uri, isDirectory: false } as const;
  }

  static downloadFileAsync(): Promise<never> {
    return Promise.reject(unsupported("File.downloadFileAsync"));
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: mirrors expo-file-system's public API, where `Paths` is a static-only class the app calls as `Paths.document`.
export class Paths {
  static get cache(): Directory {
    return new Directory(`${ROOT}cache`);
  }

  static get document(): Directory {
    return new Directory(`${ROOT}document`);
  }

  static get bundle(): Directory {
    return new Directory(`${ROOT}bundle`);
  }

  static get appleSharedContainers(): Record<string, Directory> {
    return {};
  }

  /** The browser will not tell us; callers only use these for a display hint. */
  static get totalDiskSpace(): number {
    return 0;
  }

  static get availableDiskSpace(): number {
    return 0;
  }

  static info(...uris: string[]) {
    const uri = joinPaths(...uris);
    return { exists: readEntry(uri) !== null, uri };
  }

  static join = joinPaths;
  static dirname = dirname;
  static basename = basename;
  static extname = extname;
  static isAbsolute = (path: string | File | Directory) =>
    toPath(path).startsWith("/") || /^[a-z]+:\/\//i.test(toPath(path));
  static normalize = (path: string | File | Directory) => toPath(path);
  static relative = (
    _from: string | File | Directory,
    to: string | File | Directory,
  ) => toPath(to);
  static parse = (path: string | File | Directory) => {
    const p = toPath(path);
    const ext = extname(p);
    return {
      root: "/",
      dir: dirname(p),
      base: basename(p),
      ext,
      name: basename(p, ext),
    };
  };
}

export const downloadFileAsync = (): Promise<never> =>
  Promise.reject(unsupported("downloadFileAsync"));
export const pickDirectoryAsync = (): Promise<never> =>
  Promise.reject(unsupported("pickDirectoryAsync"));
export const pickFileAsync = (): Promise<never> =>
  Promise.reject(unsupported("pickFileAsync"));

export class FileSystemDownloadTask {
  start(): Promise<never> {
    return Promise.reject(unsupported("FileSystemDownloadTask"));
  }
  pause() {
    return { resumeData: "" };
  }
  resume(): Promise<never> {
    return Promise.reject(unsupported("FileSystemDownloadTask"));
  }
  addListener() {
    return { remove: () => {} };
  }
  cancel() {}
  release() {}
}

export class FileSystemUploadTask extends FileSystemDownloadTask {}

export default { File, Directory, Paths };

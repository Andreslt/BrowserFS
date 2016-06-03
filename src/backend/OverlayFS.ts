import {FileSystem, SynchronousFileSystem} from '../core/file_system';
import {ApiError, ErrorCode} from '../core/api_error';
import {default as FileFlag, ActionType} from '../core/file_flag';
import * as util from '../core/util';
import {File} from '../core/file';
import Stats from '../core/node_fs_stats';
import PreloadFile from '../generic/preload_file';
import * as path from 'path';
let deletionLogPath = '/.deletedFiles.log';

/**
 * Given a read-only mode, makes it writable.
 */
function makeModeWritable(mode: number): number {
  return 0x92 | mode;
}

/**
 * Overlays a RO file to make it writable.
 */
class OverlayFile extends PreloadFile<OverlayFS> implements File {
  constructor(fs: OverlayFS, path: string, flag: FileFlag, stats: Stats, data: Buffer) {
    super(fs, path, flag, stats, data);
  }

  public syncSync(): void {
    if (this.isDirty()) {
      this._fs._syncSync(this);
      this.resetDirty();
    }
  }

  public closeSync(): void {
    this.syncSync();
  }
}

/**
 * OverlayFS makes a read-only filesystem writable by storing writes on a second,
 * writable file system. Deletes are persisted via metadata stored on the writable
 * file system.
 *
 * Currently only works for two synchronous file systems.
 */
export default class OverlayFS extends SynchronousFileSystem implements FileSystem {
  private _writable: FileSystem;
  private _readable: FileSystem;
  private _isInitialized: boolean = false;
  private _initializeCallbacks: ((e?: ApiError) => void)[] = [];
  private _deletedFiles: {[path: string]: boolean} = {};
  private _deleteLog: File = null;

  constructor(writable: FileSystem, readable: FileSystem) {
    super();
    this._writable = writable;
    this._readable = readable;
    if (this._writable.isReadOnly()) {
      throw new ApiError(ErrorCode.EINVAL, "Writable file system must be writable.");
    }
    if (!this._writable.supportsSynch() || !this._readable.supportsSynch()) {
      throw new ApiError(ErrorCode.EINVAL, "OverlayFS currently only operates on synchronous file systems.");
    }
  }

  private checkInitialized(): void {
    if (!this._isInitialized) {
      throw new ApiError(ErrorCode.EPERM, "OverlayFS is not initialized. Please initialize OverlayFS using its initialize() method before using it.");
    }
  }

  public getOverlayedFileSystems(): { readable: FileSystem; writable: FileSystem; } {
    return {
      readable: this._readable,
      writable: this._writable
    };
  }

  /**
   * With the given path, create the needed parent directories on the writable storage
   * should they not exist. Use modes from the read-only storage.
   */
  private createParentDirectories(p: string): void {
    var parent = path.dirname(p), toCreate: string[] = [];
    while (!this._writable.existsSync(parent)) {
      toCreate.push(parent);
      parent = path.dirname(parent);
    }
    toCreate = toCreate.reverse();

    toCreate.forEach((p: string) => {
      this._writable.mkdirSync(p, this.statSync(p, false).mode);
    });
  }

  public static isAvailable(): boolean {
    return true;
  }

  public _syncSync(file: PreloadFile<any>): void {
    this.createParentDirectories(file.getPath());
    this._writable.writeFileSync(file.getPath(), file.getBuffer(), null, FileFlag.getFileFlag('w'), file.getStats().mode);
  }

  public getName() {
    return "OverlayFS";
  }

  /**
   * Called once to load up metadata stored on the writable file system.
   */
  public initialize(cb: (err?: ApiError) => void): void {
    const callbackArray = this._initializeCallbacks;

    const end = (e?: ApiError): void => {
      this._isInitialized = !e;
      this._initializeCallbacks = [];
      callbackArray.forEach(((cb) => cb(e)));
    };

    if (!this._isInitialized) {
      // The first call to initialize initializes, the rest wait for it to complete.
      if (callbackArray.push(cb) === 1) {
        // Read deletion log, process into metadata.
        this._writable.readFile(deletionLogPath, 'utf8',
          FileFlag.getFileFlag('r'), (err: ApiError, data?: string) => {
          if (err) {
            // ENOENT === Newly-instantiated file system, and thus empty log.
            if (err.errno !== ErrorCode.ENOENT) {
              return end(err);
            }
          } else {
            data.split('\n').forEach((path: string) => {
              // If the log entry begins w/ 'd', it's a deletion. Otherwise, it's
              // an undeletion.
              // TODO: Clean up log during initialization phase.
              this._deletedFiles[path.slice(1)] = path.slice(0, 1) === 'd';
            });
          }
          // Open up the deletion log for appending.
          this._writable.open(deletionLogPath, FileFlag.getFileFlag('a'),
            0x1a4, (err: ApiError, fd?: File) => {
            if (err) {
              end(err);
            } else {
              this._deleteLog = fd;
              end();
            }
          });
        });
      }
    } else {
      cb();
    }
  }

  public isReadOnly(): boolean { return false; }
  public supportsSynch(): boolean { return true; }
  public supportsLinks(): boolean { return false; }
  public supportsProps(): boolean { return this._readable.supportsProps() && this._writable.supportsProps(); }

  private deletePath(p: string): void {
    this._deletedFiles[p] = true;
    var buff = new Buffer("d" + p + "\n");
    this._deleteLog.writeSync(buff, 0, buff.length, null);
    this._deleteLog.syncSync();
  }

  private undeletePath(p: string): void {
    if (this._deletedFiles[p]) {
      this._deletedFiles[p] = false;
      var buff = new Buffer("u" + p);
      this._deleteLog.writeSync(buff, 0, buff.length, null);
      this._deleteLog.syncSync();
    }
  }

  public renameSync(oldPath: string, newPath: string): void {
    this.checkInitialized();
    // Write newPath using oldPath's contents, delete oldPath.
    var oldStats = this.statSync(oldPath, false);
    if (oldStats.isDirectory()) {
      // Optimization: Don't bother moving if old === new.
      if (oldPath === newPath) {
        return;
      }

      var mode = 0x1ff;
      if (this.existsSync(newPath)) {
        var stats = this.statSync(newPath, false),
          mode = stats.mode;
        if (stats.isDirectory()) {
          if (this.readdirSync(newPath).length > 0) {
            throw ApiError.ENOTEMPTY(newPath);
          }
        } else {
          throw ApiError.ENOTDIR(newPath);
        }
      }

      // Take care of writable first. Move any files there, or create an empty directory
      // if it doesn't exist.
      if (this._writable.existsSync(oldPath)) {
        this._writable.renameSync(oldPath, newPath);
      } else if (!this._writable.existsSync(newPath)) {
        this._writable.mkdirSync(newPath, mode);
      }

      // Need to move *every file/folder* currently stored on readable to its new location
      // on writable.
      if (this._readable.existsSync(oldPath)) {
        this._readable.readdirSync(oldPath).forEach((name) => {
          // Recursion! Should work for any nested files / folders.
          this.renameSync(path.resolve(oldPath, name), path.resolve(newPath, name));
        });
      }
    } else {
      if (this.existsSync(newPath) && this.statSync(newPath, false).isDirectory()) {
        throw ApiError.EISDIR(newPath);
      }

      this.writeFileSync(newPath,
        this.readFileSync(oldPath, null, FileFlag.getFileFlag('r')), null,
        FileFlag.getFileFlag('w'), oldStats.mode);
    }

    if (oldPath !== newPath && this.existsSync(oldPath)) {
      this.unlinkSync(oldPath);
    }
  }
  public statSync(p: string, isLstat: boolean): Stats {
    this.checkInitialized();
    try {
      return this._writable.statSync(p, isLstat);
    } catch (e) {
      if (this._deletedFiles[p]) {
        throw ApiError.ENOENT(p);
      }
      var oldStat = this._readable.statSync(p, isLstat).clone();
      // Make the oldStat's mode writable. Preserve the topmost part of the
      // mode, which specifies if it is a file or a directory.
      oldStat.mode = makeModeWritable(oldStat.mode);
      return oldStat;
    }
  }
  public openSync(p: string, flag: FileFlag, mode: number): File {
    this.checkInitialized();
    if (this.existsSync(p)) {
      switch (flag.pathExistsAction()) {
        case ActionType.TRUNCATE_FILE:
          this.createParentDirectories(p);
          return this._writable.openSync(p, flag, mode);
        case ActionType.NOP:
          if (this._writable.existsSync(p)) {
            return this._writable.openSync(p, flag, mode);
          } else {
            // Create an OverlayFile.
            var stats = this._readable.statSync(p, false).clone();
            stats.mode = mode;
            return new OverlayFile(this, p, flag, stats, this._readable.readFileSync(p, null, FileFlag.getFileFlag('r')));
          }
        default:
          throw ApiError.EEXIST(p);
      }
    } else {
      switch(flag.pathNotExistsAction()) {
        case ActionType.CREATE_FILE:
          this.createParentDirectories(p);
          return this._writable.openSync(p, flag, mode);
        default:
          throw ApiError.ENOENT(p);
      }
    }
  }
  public unlinkSync(p: string): void {
    this.checkInitialized();
    if (this.existsSync(p)) {
      if (this._writable.existsSync(p)) {
        this._writable.unlinkSync(p);
      }

      // Does it still exist?
      if (this.existsSync(p)) {
        // Add to delete log.
        this.deletePath(p);
      }
    } else {
      throw ApiError.ENOENT(p);
    }
  }
  public rmdirSync(p: string): void {
    this.checkInitialized();
    if (this.existsSync(p)) {
      if (this._writable.existsSync(p)) {
        this._writable.rmdirSync(p);
      }
      if (this.existsSync(p)) {
        // Check if directory is empty.
        if (this.readdirSync(p).length > 0) {
          throw ApiError.ENOTEMPTY(p);
        } else {
          this.deletePath(p);
        }
      }
    } else {
      throw ApiError.ENOENT(p);
    }
  }
  public mkdirSync(p: string, mode: number): void {
    this.checkInitialized();
    if (this.existsSync(p)) {
      throw ApiError.EEXIST(p);
    } else {
      // The below will throw should any of the parent directories fail to exist
      // on _writable.
      this.createParentDirectories(p);
      this._writable.mkdirSync(p, mode);
    }
  }
  public readdirSync(p: string): string[] {
    this.checkInitialized();
    var dirStats = this.statSync(p, false);
    if (!dirStats.isDirectory()) {
      throw ApiError.ENOTDIR(p);
    }

    // Readdir in both, merge, check delete log on each file, return.
    var contents: string[] = [];
    try {
      contents = contents.concat(this._writable.readdirSync(p));
    } catch (e) {
    }
    try {
      contents = contents.concat(this._readable.readdirSync(p));
    } catch (e) {
    }
    var seenMap: {[name: string]: boolean} = {};
    return contents.filter((fileP: string) => {
      var result = seenMap[fileP] === undefined && this._deletedFiles[p + "/" + fileP] !== true;
      seenMap[fileP] = true;
      return result;
    });
  }
  public existsSync(p: string): boolean {
    this.checkInitialized();
    return this._writable.existsSync(p) || (this._readable.existsSync(p) && this._deletedFiles[p] !== true);
  }
  public chmodSync(p: string, isLchmod: boolean, mode: number): void {
    this.checkInitialized();
    this.operateOnWritable(p, () => {
      this._writable.chmodSync(p, isLchmod, mode);
    });
  }
  public chownSync(p: string, isLchown: boolean, uid: number, gid: number): void {
    this.checkInitialized();
    this.operateOnWritable(p, () => {
      this._writable.chownSync(p, isLchown, uid, gid);
    });
  }
  public utimesSync(p: string, atime: Date, mtime: Date): void {
    this.checkInitialized();
    this.operateOnWritable(p, () => {
      this._writable.utimesSync(p, atime, mtime);
    });
  }

  /**
   * Helper function:
   * - Ensures p is on writable before proceeding. Throws an error if it doesn't exist.
   * - Calls f to perform operation on writable.
   */
  private operateOnWritable(p: string, f: () => void): void {
    if (this.existsSync(p)) {
      if (!this._writable.existsSync(p)) {
        // File is on readable storage. Copy to writable storage before
        // changing its mode.
        this.copyToWritable(p);
      }
      f();
    } else {
      throw ApiError.ENOENT(p);
    }
  }

  /**
   * Copy from readable to writable storage.
   * PRECONDITION: File does not exist on writable storage.
   */
  private copyToWritable(p: string): void {
    var pStats = this.statSync(p, false);
    if (pStats.isDirectory()) {
      this._writable.mkdirSync(p, pStats.mode);
    } else {
      this.writeFileSync(p,
        this._readable.readFileSync(p, null, FileFlag.getFileFlag('r')), null,
        FileFlag.getFileFlag('w'), this.statSync(p, false).mode);
    }
  }
}

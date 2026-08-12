import fs from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const PREFIX = "safe-storage:v1:";
export const BACKUP_MAGIC = Buffer.from("CODEXIA-BACKUP-V1\n", "utf8");

const BACKUP_KEY_BYTES = 32;
const BACKUP_IV_BYTES = 12;
const BACKUP_TAG_BYTES = 16;
const BACKUP_IO_CHUNK_BYTES = 1024 * 1024;
const MAX_WRAPPED_KEY_BYTES = 64 * 1024;

interface SafeStorageAdapter {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}
export interface SecretCodec {
  isEncrypted: (value: unknown) => boolean;
  encrypt: (value: unknown) => string;
  decrypt: (value: unknown) => string;
  isEncryptedFile: (file: string) => boolean;
  encryptFile: (source: string, destination: string) => void;
  decryptFile: (source: string, destination: string) => void;
}
export function createSecretCodec(safeStorage: SafeStorageAdapter): SecretCodec {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error("系统安全存储不可用，无法安全保存 Codex 账号 Token。");
  }
  return {
    isEncrypted(value: unknown): boolean {
      return String(value || "").startsWith(PREFIX);
    },
    encrypt(value: unknown): string {
      const text = String(value || "");
      if (!text || text.startsWith(PREFIX)) return text;
      return `${PREFIX}${safeStorage.encryptString(text).toString("base64")}`;
    },
    decrypt(value: unknown): string {
      const text = String(value || "");
      if (!text || !text.startsWith(PREFIX)) return text;
      return safeStorage.decryptString(Buffer.from(text.slice(PREFIX.length), "base64"));
    },
    isEncryptedFile(file: string): boolean {
      if (!fs.existsSync(file) || fs.statSync(file).size < BACKUP_MAGIC.length) return false;
      const handle = fs.openSync(file, "r");
      try {
        const magic = Buffer.alloc(BACKUP_MAGIC.length);
        return fs.readSync(handle, magic, 0, magic.length, 0) === magic.length
          && magic.equals(BACKUP_MAGIC);
      } finally {
        fs.closeSync(handle);
      }
    },
    encryptFile(source: string, destination: string): void {
      encryptFileWithSafeStorage(source, destination, safeStorage);
    },
    decryptFile(source: string, destination: string): void {
      decryptFileWithSafeStorage(source, destination, safeStorage);
    }
  };
}

function encryptFileWithSafeStorage(source: string, destination: string, safeStorage: SafeStorageAdapter): void {
  const key = randomBytes(BACKUP_KEY_BYTES);
  const iv = randomBytes(BACKUP_IV_BYTES);
  const wrappedKey = safeStorage.encryptString(key.toString("base64"));
  if (wrappedKey.length < 1 || wrappedKey.length > MAX_WRAPPED_KEY_BYTES) {
    key.fill(0);
    throw new Error("系统安全存储返回了无效的备份密钥封装。");
  }
  const wrappedLength = Buffer.alloc(4);
  wrappedLength.writeUInt32BE(wrappedKey.length);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let sourceHandle: number | null = null;
  let destinationHandle: number | null = null;
  try {
    sourceHandle = fs.openSync(source, "r");
    destinationHandle = fs.openSync(destination, "wx", 0o600);
    writeAll(destinationHandle, BACKUP_MAGIC);
    writeAll(destinationHandle, wrappedLength);
    writeAll(destinationHandle, wrappedKey);
    writeAll(destinationHandle, iv);
    transformFile(sourceHandle, destinationHandle, cipher);
    writeAll(destinationHandle, cipher.final());
    writeAll(destinationHandle, cipher.getAuthTag());
    fs.fsyncSync(destinationHandle);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (destinationHandle !== null) fs.closeSync(destinationHandle);
    destinationHandle = null;
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    key.fill(0);
    if (sourceHandle !== null) fs.closeSync(sourceHandle);
    if (destinationHandle !== null) fs.closeSync(destinationHandle);
  }
}

function decryptFileWithSafeStorage(source: string, destination: string, safeStorage: SafeStorageAdapter): void {
  let sourceHandle: number | null = null;
  let destinationHandle: number | null = null;
  let key: Buffer | null = null;
  try {
    sourceHandle = fs.openSync(source, "r");
    const size = fs.fstatSync(sourceHandle).size;
    const magic = readExactly(sourceHandle, BACKUP_MAGIC.length, 0);
    if (!magic.equals(BACKUP_MAGIC)) throw new Error("迁移备份不是受支持的加密格式。");
    const wrappedLength = readExactly(sourceHandle, 4, BACKUP_MAGIC.length).readUInt32BE(0);
    if (wrappedLength < 1 || wrappedLength > MAX_WRAPPED_KEY_BYTES) {
      throw new Error("迁移备份的密钥封装长度无效。");
    }
    const wrappedOffset = BACKUP_MAGIC.length + 4;
    const wrappedKey = readExactly(sourceHandle, wrappedLength, wrappedOffset);
    const ivOffset = wrappedOffset + wrappedLength;
    const iv = readExactly(sourceHandle, BACKUP_IV_BYTES, ivOffset);
    const ciphertextOffset = ivOffset + BACKUP_IV_BYTES;
    const ciphertextBytes = size - ciphertextOffset - BACKUP_TAG_BYTES;
    if (ciphertextBytes < 0) throw new Error("迁移备份已截断。");
    const tag = readExactly(sourceHandle, BACKUP_TAG_BYTES, size - BACKUP_TAG_BYTES);
    key = Buffer.from(safeStorage.decryptString(wrappedKey), "base64");
    if (key.length !== BACKUP_KEY_BYTES) throw new Error("迁移备份的数据密钥无效。");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    destinationHandle = fs.openSync(destination, "wx", 0o600);
    transformFile(sourceHandle, destinationHandle, decipher, ciphertextOffset, ciphertextBytes);
    writeAll(destinationHandle, decipher.final());
    fs.fsyncSync(destinationHandle);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (destinationHandle !== null) fs.closeSync(destinationHandle);
    destinationHandle = null;
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    key?.fill(0);
    if (sourceHandle !== null) fs.closeSync(sourceHandle);
    if (destinationHandle !== null) fs.closeSync(destinationHandle);
  }
}

function transformFile(
  sourceHandle: number,
  destinationHandle: number,
  transform: { update: (data: Buffer) => Buffer },
  start = 0,
  length = fs.fstatSync(sourceHandle).size
): void {
  const buffer = Buffer.allocUnsafe(Math.min(BACKUP_IO_CHUNK_BYTES, Math.max(1, length)));
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const bytesRead = fs.readSync(sourceHandle, buffer, 0, Math.min(buffer.length, remaining), position);
    if (bytesRead === 0) throw new Error("迁移备份在处理过程中被截断。");
    writeAll(destinationHandle, transform.update(buffer.subarray(0, bytesRead)));
    position += bytesRead;
    remaining -= bytesRead;
  }
}

function readExactly(handle: number, length: number, position: number): Buffer {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(handle, result, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("迁移备份已截断。");
    offset += bytesRead;
  }
  return result;
}

function writeAll(handle: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const bytesWritten = fs.writeSync(handle, data, offset, data.length - offset);
    if (bytesWritten === 0) throw new Error("无法完整写入加密迁移备份。");
    offset += bytesWritten;
  }
}

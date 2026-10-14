
import {
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
  } from "node:fs/promises";
  import { dirname } from "node:path";
  
  export async function writeCheckpoint(
    path: string,
    data: unknown,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
  
    const temporaryPath = `${path}.${process.pid}.tmp`;
  
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
  
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  
  export async function readCheckpoint<T>(
    path: string,
  ): Promise<T | null> {
    try {
      const content = await readFile(path, "utf8");
      return JSON.parse(content) as T;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
  
      // Do not silently ignore corrupted JSON.
      throw error;
    }
  }
  
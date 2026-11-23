import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: loadEnv("test", process.cwd(), ""),
    fileParallelism: false,
    exclude: [...configDefaults.exclude, ".claude/**"], // other sessions' worktrees
  },
});

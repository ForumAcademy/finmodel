import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "excel-import",
    include: ["test/**/*.test.ts"],
  },
});

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "egrn-import",
    include: ["test/**/*.test.ts"],
  },
});

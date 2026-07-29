// @ts-nocheck -- analyzed by the fixture's own offline tsconfig.
import { shared } from "@golden/shared";
import { shared as again } from "@golden/shared";
import type { ReactNode } from "react";

export function choose(first: boolean, second: boolean): ReactNode {
  if (first && second) return shared;
  return first ? again : 0;
}
